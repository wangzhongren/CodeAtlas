import { useState, useRef, useEffect, useMemo } from 'react';
import type { FileContent } from '../types/electron.d';
import type { CodeSelection } from './CodeViewer';
import { useTaskStore } from '../store/taskStore';

interface Props {
  projectPath: string | null;
  openFilePath: string | null;
  selection: CodeSelection | null;
  onClearSelection: () => void;
  injectContext?: string;
  onConsumeContext?: () => void;
  onFileChanged?: () => void;
}

interface ShellState {
  id: string;
  command: string;
  output: string;
  running: boolean;
  exitCode: number | null;
}

interface Message {
  role: 'user' | 'agent';
  content: string;
  operations?: Array<{
    type: string;
    file: string;
    start_line?: number;
    end_line?: number;
    after_line?: number;
    content?: string;
    pending?: boolean; // needs user approval for shell commands
  }>;
  shell?: ShellState;
  needsApproval?: boolean;
}

/* ── Render message content with code blocks ── */
function MessageContent({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const parts: { type: 'text' | 'code'; content: string; lang?: string }[] = [];
    const regex = /```(\w*)\n?([\s\S]*?)```/g;
    let lastIdx = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIdx) {
        parts.push({ type: 'text', content: text.slice(lastIdx, match.index) });
      }
      parts.push({ type: 'code', lang: match[1] || undefined, content: match[2].trimEnd() });
      lastIdx = match.index + match[0].length;
    }
    if (lastIdx < text.length) {
      parts.push({ type: 'text', content: text.slice(lastIdx) });
    }
    return parts;
  }, [text]);

  if (blocks.length === 0) {
    return <span className="whitespace-pre-wrap break-words leading-relaxed">{text}</span>;
  }

  return (
    <>
      {blocks.map((block, i) =>
        block.type === 'code' ? (
          <div key={i} className="my-2 rounded-xl overflow-hidden border" style={{ borderColor: '#303234', background: '#0d1117' }}>
            {block.lang && (
              <div className="flex items-center px-3 py-1.5 border-b text-[10px] font-medium uppercase tracking-wide" style={{ borderColor: '#21262d', color: '#8b949e' }}>
                {block.lang}
              </div>
            )}
            <pre className="px-4 py-3 text-[12px] leading-relaxed overflow-x-auto font-mono whitespace-pre" style={{ color: '#c9d1d9' }}>
              <code>{block.content}</code>
            </pre>
          </div>
        ) : (
          <span key={i} className="whitespace-pre-wrap break-words leading-relaxed">{block.content}</span>
        )
      )}
    </>
  );
}

/* ── Operation chip colors ── */
const OP_STYLE: Record<string, { icon: string; color: string; bg: string }> = {
  insert_lines: { icon: '+', color: '#3fb950', bg: '#12261a' },
  replace_lines: { icon: '~', color: '#d29922', bg: '#272115' },
  delete_lines: { icon: '-', color: '#f85149', bg: '#261212' },
  create_file: { icon: '+', color: '#3fb950', bg: '#12261a' },
  run_shell: { icon: '>', color: '#58a6ff', bg: '#121d2e' },
  read_file: { icon: '?', color: '#8b949e', bg: '#1c1c1c' },
  check_log: { icon: '?', color: '#8b949e', bg: '#1c1c1c' },
};

/* ═════════════════════════════════════════ */
export default function AgentPanel({ projectPath, openFilePath, selection, onClearSelection, injectContext, onConsumeContext, onFileChanged }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [approveMsgIdx, setApproveMsgIdx] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pendingOpsRef = useRef<Array<{ file?: string; type: string; content?: string }>>([]);
  const pendingShellRef = useRef<any[]>([]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const handleStop = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setSending(false);
  };

  const handleSend = async () => {
    let instruction = input.trim();
    if (!instruction || sending) return;
    setSending(true);
    setInput('');
    abortRef.current = new AbortController();

    // Prepend injected context if present
    if (injectContext) {
      instruction = `【从功能分析中获取的上下文】\n${injectContext}\n\n【用户指令】\n${instruction}`;
      onConsumeContext?.();
    }

    setMessages((prev) => [...prev, { role: 'user', content: instruction }]);

    const allEditingOps: any[] = [];
    pendingShellRef.current = [];
    pendingOpsRef.current = [];

    try {
      let openFileCtx = null;
      let fileTree = null;

      if (projectPath) {
        try {
          fileTree = await window.codeatlas.file.listDirectory(projectPath);
        } catch (e) {
          console.error('[Agent] listDirectory failed:', e);
        }

        if (openFilePath) {
          try {
            const fc: FileContent = await window.codeatlas.file.readFile(openFilePath);
            openFileCtx = { path: openFilePath.replace(projectPath, '').replace(/^[\\/]/, ''), content: fc.content, lines: fc.lineCount };
          } catch { /* ok */ }
        }
      }

      // Add project info directly to instruction so LLM always sees it
      let fullInstruction = instruction;
      if (projectPath) {
        const projName = projectPath.split(/[\\/]/).pop() || projectPath;
        fullInstruction = `【当前项目: ${projName}，路径: ${projectPath}】\n${instruction}`;
      }
      if (fileTree && fileTree.length > 0) {
        fullInstruction += `\n\n项目文件列表:\n${JSON.stringify(fileTree, null, 2)}`;
      }

      let selectionCtx = null;
      if (selection) {
        const relPath = projectPath ? selection.filePath.replace(projectPath, '').replace(/^[\\/]/, '') : selection.filePath;
        selectionCtx = { file: relPath, text: selection.text, lines: `L${selection.startLine}-L${selection.endLine}` };
      }

      // Include last 10 messages as conversation history
      const history = messages.map((m) => ({ role: m.role, content: m.content }));
      const body: Record<string, any> = { instruction, open_file: openFileCtx, file_tree: fileTree, history };
      if (selectionCtx) body.selection = selectionCtx;

      setMessages((prev) => [...prev, { role: 'agent', content: '', operations: [] }]);

      const res = await fetch('/api/v1/agent/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abortRef.current?.signal,
      });

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let fullMessage = '';
      let finalOps: any[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          const lines = part.split('\n');
          let eventType = '', eventData = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) eventType = line.slice(7);
            else if (line.startsWith('data: ')) eventData = line.slice(6);
          }

          if (eventType === 'token') {
            fullMessage += eventData;
            setMessages((prev) => {
              const u = [...prev];
              const last = u[u.length - 1];
              if (last?.role === 'agent') u[u.length - 1] = { ...last, content: fullMessage };
              return u;
            });
          } else if (eventType === 'done') {
            try {
              const d = JSON.parse(eventData);
              fullMessage = d.message || fullMessage;
              const ops = (d.operations || []).map((op: any) => ({
                ...op,
                pending: op.type === 'run_shell',
              }));
              finalOps = ops;
              setMessages((prev) => {
                const u = [...prev];
                const last = u[u.length - 1];
                if (last?.role === 'agent') u[u.length - 1] = { ...last, content: fullMessage, operations: ops, needsApproval: ops.some((o: any) => o.pending) };
                return u;
              });
            } catch { /* ignore */ }
          }
        }
      }

      // Execute operations with auto-feedback loop for read_file
      let ops = [...finalOps];
      let extraContext = '';
      let loopGuard = 0;

      while (ops.length > 0 && loopGuard < 50) {
        loopGuard++;
        const readOps = ops.filter((o) => o.type === 'read_file');
        const execOps = ops.filter((o) => o.type !== 'read_file');

        // Execute read_file operations first, collect content
        for (const op of readOps) {
          try {
            let filePath = op.file || '';
            if (filePath && !/^[a-zA-Z]:[\\/]/.test(filePath) && projectPath) {
              filePath = projectPath.replace(/\\/g, '/') + '/' + filePath.replace(/^[\\/]+/, '');
            }
            if (filePath) {
              const fc: FileContent = await window.codeatlas.file.readFile(filePath, op.start_line, op.end_line);
              const label = op.start_line ? `${op.file}:L${op.start_line}-${op.end_line || op.start_line}` : (op.file || filePath);
              extraContext += `\n\n【文件: ${label}】\n\`\`\`\n${fc.content}\n\`\`\`\n`;
            }
          } catch (e: any) {
            extraContext += `\n\n【文件: ${op.file} - 读取失败: ${e.message}】\n`;
          }
        }

        // Separate pending (shell) from auto-run ops
        const autoOps = execOps.filter((o) => !o.pending);
        const pendingShell = execOps.filter((o) => o.pending);
        allEditingOps.push(...execOps);
        pendingShellRef.current.push(...pendingShell);
        pendingOpsRef.current = allEditingOps;

        // If there are pending shell ops, STOP here and wait for approval
        if (pendingShell.length > 0) {
          setSending(false); // release input (but don't finalize)
          return; // exit handleSend — resume from handleApprove
        }

        for (const op of autoOps) {
          try {
            let filePath = op.file || '';
            if (filePath && !/^[a-zA-Z]:[\\/]/.test(filePath) && projectPath) {
              filePath = projectPath.replace(/\\/g, '/') + '/' + filePath.replace(/^[\\/]+/, '');
            }
            switch (op.type) {
              case 'insert_lines': await window.codeatlas.file.insertLines(filePath, op.after_line || 0, op.content || ''); break;
              case 'replace_lines': await window.codeatlas.file.replaceLines(filePath, op.start_line || 1, op.end_line || 1, op.content || ''); break;
              case 'delete_lines': await window.codeatlas.file.deleteLines(filePath, op.start_line || 1, op.end_line || 1); break;
              case 'create_file': await window.codeatlas.file.writeFile(filePath, op.content || ''); break;
            }
          } catch (e: any) {
            console.error(`Op failed: ${op.type}`, e);
          }
        }

        // If we read files, feed them back to agent for follow-up
        if (readOps.length > 0 && extraContext) {
          const followBody: Record<string, any> = {
            instruction: loopGuard >= 49
              ? `【这是最后一轮（第50轮），请总结到目前为止完成的所有操作，说明项目的当前状态，以及建议的后续操作方向】\n${extraContext}`
              : `【之前你说需要读以下文件，现在内容在这里了，请继续处理用户最初的需求】\n${extraContext}`,
            open_file: openFileCtx,
            file_tree: fileTree,
            history,
          };

          setMessages((prev) => [...prev, { role: 'agent', content: '', operations: [] }]);

          const res2 = await fetch('/api/v1/agent/chat/stream', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(followBody),
            signal: abortRef.current?.signal,
          });

          const reader2 = res2.body?.getReader();
          if (!reader2) break;

          const decoder2 = new TextDecoder();
          let buf2 = '';
          let msg2 = '';
          let ops2: any[] = [];

          while (true) {
            const { done, value } = await reader2.read();
            if (done) break;
            buf2 += decoder2.decode(value, { stream: true });
            const parts2 = buf2.split('\n\n');
            buf2 = parts2.pop() || '';
            for (const part of parts2) {
              const lines2 = part.split('\n');
              let et = '', ed = '';
              for (const l of lines2) {
                if (l.startsWith('event: ')) et = l.slice(7);
                else if (l.startsWith('data: ')) ed = l.slice(6);
              }
              if (et === 'token') {
                msg2 += ed;
                setMessages((prev) => {
                  const u = [...prev];
                  const last = u[u.length - 1];
                  if (last?.role === 'agent') u[u.length - 1] = { ...last, content: msg2 };
                  return u;
                });
              } else if (et === 'done') {
                try {
                  const d = JSON.parse(ed);
                  msg2 = d.message || msg2;
                  const ops = (d.operations || []).map((op: any) => ({ ...op, pending: op.type === 'run_shell' }));
                  ops2 = ops;
                  setMessages((prev) => {
                    const u = [...prev];
                    const last = u[u.length - 1];
                    if (last?.role === 'agent') u[u.length - 1] = { ...last, content: msg2, operations: ops, needsApproval: ops.some((o: any) => o.pending) };
                    return u;
                  });
                } catch { /* ignore */ }
              }
            }
          }

          ops = ops2;
          extraContext = '';
        } else {
          ops = [];
        }
      }

      // Normal completion — summarize and refresh
      await finalizeOps(allEditingOps);

    } catch (e: any) {
      if (e.name !== 'AbortError') {
        setMessages((prev) => [...prev, { role: 'agent', content: `\`\`\`\nError: ${e.message}\n\`\`\`` }]);
      }
    }
    abortRef.current = null;
    setSending(false);
  };

  const finalizeOps = async (ops: any[]) => {
    if (ops.some((o: any) => ['insert_lines', 'replace_lines', 'delete_lines', 'create_file'].includes(o.type))) {
      onFileChanged?.();
    }
    if (ops.length > 0 && projectPath) {
      const stId = `summarize_${Date.now()}`;
      useTaskStore.getState().addTask({ id: stId, type: 'summarize', label: 'Summarize changes', status: 'running', startedAt: Date.now(), detail: `${ops.length} operations` });
      try {
        await fetch('/api/v1/changes/summarize', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_path: projectPath, operations: ops }),
        });
        useTaskStore.getState().updateTask(stId, { status: 'done', detail: 'Pushed to queue' });
      } catch {
        useTaskStore.getState().updateTask(stId, { status: 'error', detail: 'Failed' });
      }
    }
  };

  const executeShellOp = async (op: any) => {
    const cmd = op.content || '';
    if (!cmd) return;
    const taskId = `shell_${Date.now()}`;
    useTaskStore.getState().addTask({ id: taskId, type: 'shell', label: cmd.slice(0, 50), status: 'running', startedAt: Date.now(), detail: 'Starting...' });
    const shellId = window.codeatlas.shell.run(cmd);
    const st: ShellState = { id: shellId, command: cmd, output: '', running: true, exitCode: null };
    setMessages((prev) => {
      const u = [...prev];
      for (let i = u.length - 1; i >= 0; i--) {
        if (u[i].role === 'agent') { u[i] = { ...u[i], shell: st }; break; }
      }
      return u;
    });
    window.codeatlas.shell.onData((id, data) => {
      if (id !== shellId) return;
      useTaskStore.getState().updateTask(taskId, { detail: (data || '').slice(-60) });
      setMessages((prev) => {
        const u = [...prev];
        for (let i = u.length - 1; i >= 0; i--) {
          if (u[i].shell?.id === shellId) {
            u[i] = { ...u[i], shell: { ...u[i].shell!, output: u[i].shell!.output + data } };
            break;
          }
        }
        return u;
      });
    });
    window.codeatlas.shell.onDone((id, code) => {
      if (id !== shellId) return;
      useTaskStore.getState().updateTask(taskId, { status: code === 0 ? 'done' : 'error', exitCode: code, detail: `Exit code: ${code}` });
      setMessages((prev) => {
        const u = [...prev];
        for (let i = u.length - 1; i >= 0; i--) {
          if (u[i].shell?.id === shellId) {
            u[i] = { ...u[i], shell: { ...u[i].shell!, running: false, exitCode: code } };
            break;
          }
        }
        return u;
      });
    });
  };

  const handleDeny = (msgIdx: number) => {
    setMessages((prev) => {
      const u = [...prev];
      const msg = u[msgIdx];
      if (msg?.operations) {
        u[msgIdx] = { ...msg, operations: msg.operations.filter((o: any) => o.type !== 'run_shell'), needsApproval: false };
      }
      return u;
    });
  };

  const handleApprove = async (msgIdx: number) => {
    setMessages((prev) => {
      const u = [...prev];
      const msg = u[msgIdx];
      if (msg?.operations) {
        u[msgIdx] = { ...msg, operations: msg.operations.map((o: any) => ({ ...o, pending: false })), needsApproval: false };
      }
      return u;
    });
    const msg = messages[msgIdx];
    const shellOps = msg?.operations?.filter((o: any) => o.type === 'run_shell') || [];

    for (const op of shellOps) {
      const cmd = (op.content || '').trim();
      let timedOut = false;
      const timeout = new Promise<void>((resolve) => setTimeout(() => { timedOut = true; resolve(); }, 15000));
      await Promise.race([executeShellOp(op), timeout]);
      if (timedOut) {
        setMessages((prev) => [...prev, {
          role: 'agent',
          content: `\`\`\`\nStill running in background: ${cmd.slice(0, 60)}\nCheck status bar.\n\`\`\``,
        }]);
      }
    }

    await finalizeOps(pendingOpsRef.current);
    pendingShellRef.current = [];
    pendingOpsRef.current = [];
  };

  return (
    <div className="relative flex flex-col h-full" style={{ background: '#0d1117' }}>
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full px-8">
            <div className="text-center space-y-1" style={{ color: '#484f58' }}>
              <div className="text-[11px] font-mono">Ask anything.</div>
              <div className="text-[11px] font-mono opacity-50">Edit code, run commands, analyze structure.</div>
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className="animate-fade-in">
            {/* User message */}
            {msg.role === 'user' && (
              <div className="px-5 py-3">
                <div className="text-[11px] mb-1 font-medium" style={{ color: '#58a6ff' }}>You</div>
                <div className="text-[13px] leading-relaxed whitespace-pre-wrap" style={{ color: '#c9d1d9' }}>
                  {msg.content}
                </div>
              </div>
            )}

            {/* Agent message */}
            {msg.role === 'agent' && (
              <div className="border-t" style={{ borderColor: '#21262d' }}>
                <div className="px-5 py-3">
                  <div className="text-[11px] mb-2 font-medium" style={{ color: '#7ee787' }}>Agent</div>
                  <div className="text-[13px] leading-relaxed" style={{ color: '#c9d1d9' }}>
                    <MessageContent text={msg.content || (i === messages.length - 1 ? '...' : '')} />
                  </div>

                  {/* Approval bar — now a button that opens modal */}
                  {msg.needsApproval && (
                    <button onClick={() => setApproveMsgIdx(i)}
                      className="flex items-center gap-2 mt-3 px-3 py-2 rounded-lg w-full text-left transition-colors hover:bg-white/[0.03]"
                      style={{ border: '1px solid #d2992240' }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#d29922" strokeWidth="2" className="shrink-0">
                        <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                      </svg>
                      <span className="text-[11px]" style={{ color: '#d29922' }}>
                        Shell command needs approval — click to review
                      </span>
                    </button>
                  )}

                  {/* Operations chips — subtle, below content */}
                  {msg.operations && msg.operations.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-3">
                      {msg.operations.map((op, j) => {
                        const s = OP_STYLE[op.type] || OP_STYLE.read_file;
                        return (
                          <span key={j} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono"
                            style={{ color: s.color, background: s.bg }}>
                            <span>{s.icon}</span>
                            <span className="max-w-[120px] truncate">
                              {op.type === 'run_shell' ? (op.content || '').slice(0, 30) : op.file}
                            </span>
                            {op.start_line && <span style={{ opacity: 0.5 }}>:{op.start_line}</span>}
                            {op.pending && <span style={{ color: '#d29922' }}> ?</span>}
                          </span>
                        );
                      })}
                    </div>
                  )}

                  {/* Shell output */}
                  {msg.shell && (
                    <div className="mt-3">
                      <div className="flex items-center justify-between text-[10px] mb-1.5 px-1">
                        <span className="font-mono" style={{ color: '#7ee787' }}>$ {msg.shell.command}</span>
                        <span style={{ color: msg.shell.running ? '#d29922' : msg.shell.exitCode === 0 ? '#7ee787' : '#f85149' }}>
                          {msg.shell.running ? 'running' : `exit ${msg.shell.exitCode}`}
                          {msg.shell.running && (
                            <button onClick={() => window.codeatlas.shell.kill(msg.shell!.id)}
                              className="ml-2 px-1.5 py-0.5 rounded text-[9px]" style={{ background: '#da363320', color: '#f85149' }}>Stop</button>
                          )}
                        </span>
                      </div>
                      {msg.shell.output && (
                        <div className="rounded-lg overflow-hidden" style={{ background: '#161b22', border: '1px solid #21262d' }}>
                          <pre className="px-4 py-2.5 text-[11px] leading-relaxed overflow-x-auto max-h-64 whitespace-pre-wrap font-mono"
                            style={{ color: '#c9d1d9' }}>
                            {msg.shell.output.trimEnd() || ' '}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Input */}
      <div className="border-t" style={{ borderColor: '#21262d', background: '#0d1117' }}>
        {injectContext && (
          <div className="px-4 pt-2">
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] animate-fade-in"
              style={{ background: '#1a3350', color: '#8ab4f8', border: '1px solid #8ab4f830' }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
              Context from Feature Analysis
              <button onClick={onConsumeContext} className="opacity-50 hover:opacity-100">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </span>
          </div>
        )}
        {selection && (
          <div className="px-4 pt-2">
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px]"
              style={{ background: '#0f2e1a', color: '#7ee787', border: '1px solid #23863630' }}>
              {selection.filePath.split(/[\\/]/).pop()} L{selection.startLine}-L{selection.endLine}
              <button onClick={onClearSelection} className="opacity-50 hover:opacity-100 ml-0.5">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </span>
          </div>
        )}
        <div className="p-3">
          <div className="flex items-end gap-2">
            {sending && (
              <button onClick={handleStop} className="p-2 rounded-lg transition-colors hover:bg-white/10 shrink-0" title="Stop generating">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="#f85149"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
              </button>
            )}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask anything..."
              disabled={sending}
              rows={1}
              className="flex-1 px-3 py-2 text-[13px] leading-relaxed outline-none resize-none rounded-lg transition-colors placeholder:text-[#484f58] disabled:opacity-50"
              style={{
                background: '#161b22',
                border: '1px solid #30363d',
                color: '#c9d1d9',
                fontFamily: 'inherit',
              }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = 'auto';
                el.style.height = Math.min(el.scrollHeight, 120) + 'px';
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
              }}
            />
            {!sending && (
              <button onClick={handleSend} disabled={!input.trim()}
                className="p-2 rounded-lg transition-colors hover:bg-white/10 disabled:opacity-20 shrink-0"
                style={{ color: '#8ab4f8' }} title="Send">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Approval Modal */}
      {approveMsgIdx !== null && messages[approveMsgIdx] && (
        <div className="absolute inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(1,4,9,0.8)' }}>
          <div className="w-[420px] rounded-xl overflow-hidden card-elevation animate-fade-in"
            style={{ background: '#161b22', border: '1px solid #30363d' }}>
            {/* Header */}
            <div className="px-4 py-3 border-b flex items-center gap-2" style={{ borderColor: '#21262d' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d29922" strokeWidth="2">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span className="text-xs font-medium flex-1" style={{ color: '#e3e2e6' }}>Approve Shell Command</span>
              <button onClick={() => setApproveMsgIdx(null)} style={{ color: '#484f58' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            {/* Body */}
            <div className="px-4 py-3 space-y-3">
              <div className="text-[11px]" style={{ color: '#8b949e' }}>
                This command will be executed in the project directory:
              </div>
              {messages[approveMsgIdx].operations?.filter((o: any) => o.type === 'run_shell').map((op: any, j: number) => (
                <div key={j} className="rounded-lg p-3 font-mono text-[12px]" style={{ background: '#0d1117', color: '#7ee787', border: '1px solid #21262d' }}>
                  $ {op.content}
                </div>
              ))}
              <div className="text-[10px]" style={{ color: '#d29922' }}>
                Commands run with a 15-second timeout; longer processes continue in the background.
              </div>
            </div>
            {/* Footer */}
            <div className="px-4 py-2.5 border-t flex justify-end gap-2" style={{ borderColor: '#21262d', background: '#0d1117' }}>
              <button onClick={() => { handleDeny(approveMsgIdx); setApproveMsgIdx(null); }}
                className="px-4 py-1.5 rounded text-[11px] font-medium transition-colors hover:opacity-80"
                style={{ background: '#21262d', color: '#c9d1d9' }}>
                Deny
              </button>
              <button onClick={() => { handleApprove(approveMsgIdx); setApproveMsgIdx(null); }}
                className="px-4 py-1.5 rounded text-[11px] font-medium transition-colors hover:opacity-80"
                style={{ background: '#238636', color: '#fff' }}>
                Approve & Run
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
