import { useState, useRef, useEffect, useCallback } from 'react';
import { streamAgentResponse, executeShellAndWait } from '../utils/agentStream';
import type { FileContent } from '../types/electron.d';

interface Props {
  projectPath: string;
  onClose: () => void;
  onFileChanged?: () => void;
}

type RunPhase =
  | 'starting'
  | 'analyzing'
  | 'installing'
  | 'building'
  | 'running'
  | 'fixing'
  | 'success'
  | 'failed';

const PHASE_LABELS: Record<RunPhase, string> = {
  starting: 'Starting...',
  analyzing: 'Analyzing project structure',
  installing: 'Installing dependencies',
  building: 'Building project',
  running: 'Running project',
  fixing: 'Fixing errors',
  success: 'Run successful',
  failed: 'Run failed',
};

const MAX_FIXES = 5;

export default function RunPage({ projectPath, onClose, onFileChanged }: Props) {
  const [phase, setPhase] = useState<RunPhase>('starting');
  const [log, setLog] = useState('');
  const [agentThought, setAgentThought] = useState('');
  const [fixCount, setFixCount] = useState(0);
  const [running, setRunning] = useState(true);
  const [shellCount, setShellCount] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const appendLog = useCallback((text: string) => {
    setLog((prev) => prev + text);
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [log]);

  const appendShellLog = useCallback((command: string, output: string, exitCode: number) => {
    setShellCount((n) => n + 1);
    const status = exitCode === 0 ? 'OK' : `FAIL (exit ${exitCode})`;
    appendLog(`\n\n$ ${command}\n${output.trimEnd() || '(no output)'}\n[${status}]`);
  }, [appendLog]);

  /* ── Main auto-run loop ── */
  const startAutoRun = useCallback(async () => {
    if (!projectPath) return;
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    const AUTO_RUN_PROMPT = `【自动运行模式】

你的任务是让这个项目成功运行起来。按以下步骤操作：

1. 读取项目的配置文件（package.json、Cargo.toml、go.mod、pyproject.toml、setup.py 等）确定项目类型
2. 读取 README.md（如有）了解运行说明
3. 读取关键入口文件了解项目结构
4. 确定正确的构建/运行命令
5. 如果需要安装依赖，先执行安装命令
6. 执行启动/构建命令
7. 如果运行出错（exit code != 0），仔细分析错误输出，修改代码修复，然后重新运行
8. 最多尝试 ${MAX_FIXES} 次修复

【重要】
- 直接操作，不要询问
- 从错误输出中仔细分析根本原因
- 修改代码后确保语法正确
- 如果项目已能正常运行，报告成功`;

    try {
      // Build context
      let fileTree = null;
      let openFileCtx = null;
      try {
        fileTree = await window.codeatlas.file.listDirectory(projectPath);
      } catch { /* */ }

      const projName = projectPath.split(/[\\/]/).pop() || projectPath;
      let instruction = `【当前项目: ${projName}，路径: ${projectPath}】\n${AUTO_RUN_PROMPT}`;
      if (fileTree && fileTree.length > 0) {
        instruction += `\n\n项目文件列表:\n${JSON.stringify(fileTree, null, 2)}`;
      }

      let body: Record<string, any> = {
        instruction,
        open_file: null,
        file_tree: fileTree,
        history: [],
      };

      let currentFix = 0;
      let round = 0;

      setPhase('analyzing');

      while (round < 20) {
        round++;
        if (signal.aborted) break;

        const { message, operations } = await streamAgentResponse(
          body,
          signal,
          (token) => setAgentThought((prev) => prev + token),
        );

        setAgentThought(message);

        const readOps = operations.filter((o: any) => o.type === 'read_file');
        const editOps = operations.filter((o: any) =>
          ['insert_lines', 'replace_lines', 'delete_lines', 'create_file'].includes(o.type),
        );
        const shellOps = operations.filter((o: any) => o.type === 'run_shell');

        // Execute reads → feed back
        let extraContext = '';
        for (const op of readOps) {
          try {
            let fp = op.file || '';
            if (fp && !/^[a-zA-Z]:[\\/]/.test(fp)) {
              fp = projectPath.replace(/\\/g, '/') + '/' + fp.replace(/^[\\/]+/, '');
            }
            if (fp) {
              const fc: FileContent = await window.codeatlas.file.readFile(fp, op.start_line, op.end_line);
              const label = op.start_line
                ? `${op.file}:L${op.start_line}-${op.end_line || op.start_line}`
                : op.file;
              extraContext += `\n\n=== ${label} ===\n\`\`\`\n${fc.content}\n\`\`\`\n`;
              appendLog(`\n  Read: ${label}`);
            }
          } catch (e: any) {
            extraContext += `\n读取失败: ${op.file} — ${e.message}\n`;
          }
        }

        if (extraContext) {
          body = {
            instruction: `读取的文件内容如下，请继续完成任务：\n${extraContext}`,
            open_file: openFileCtx,
            file_tree: fileTree,
            history: [],
          };
          setAgentThought('');
          continue;
        }

        // Execute edits
        for (const op of editOps) {
          try {
            let fp = op.file || '';
            if (fp && !/^[a-zA-Z]:[\\/]/.test(fp)) {
              fp = projectPath.replace(/\\/g, '/') + '/' + fp.replace(/^[\\/]+/, '');
            }
            switch (op.type) {
              case 'insert_lines':
                await window.codeatlas.file.insertLines(fp, op.after_line || 0, op.content || '');
                break;
              case 'replace_lines':
                await window.codeatlas.file.replaceLines(fp, op.start_line || 1, op.end_line || 1, op.content || '');
                break;
              case 'delete_lines':
                await window.codeatlas.file.deleteLines(fp, op.start_line || 1, op.end_line || 1);
                break;
              case 'create_file':
                await window.codeatlas.file.writeFile(fp, op.content || '');
                break;
            }
            appendLog(`\n  Edit: ${op.type} ${op.file || fp}`);
          } catch (e: any) {
            appendLog(`\n  Edit failed: ${op.type} ${op.file} — ${e.message}`);
          }
        }

        // Execute shells (auto-approve)
        for (const op of shellOps) {
          const cmd = (op.content || '').trim();
          if (!cmd) continue;

          // Guess phase from command
          const cmdLower = cmd.toLowerCase();
          if (cmdLower.includes('install') || cmdLower.includes('pip ') || cmdLower.includes('npm i') || cmdLower.includes('yarn add')) {
            setPhase('installing');
          } else if (cmdLower.includes('build') || cmdLower.includes('compile') || cmdLower.includes('tsc') || cmdLower.includes('vite build')) {
            setPhase('building');
          } else {
            setPhase('running');
          }

          appendLog(`\n$ ${cmd}`);
          const { output, exitCode } = await executeShellAndWait(
            cmd,
            (data) => appendLog(data),
            120000,
          );

          appendShellLog(cmd, output, exitCode);

          if (exitCode !== 0) {
            currentFix++;
            setFixCount(currentFix);
            setPhase('fixing');

            if (currentFix > MAX_FIXES) {
              setPhase('failed');
              appendLog(`\n\n  Max fixes (${MAX_FIXES}) reached. Stopping.`);
              setRunning(false);
              return;
            }

            const truncated = output.length > 4000
              ? output.slice(0, 2000) + '\n...(truncated)...\n' + output.slice(-2000)
              : output;

            body = {
              instruction: `【修复 ${currentFix}/${MAX_FIXES}】
命令 \`${cmd}\` 运行失败 (exit ${exitCode})。

输出：
\`\`\`
${truncated}
\`\`\`

请分析错误根本原因，读取相关代码，修改后给出重新运行的命令。不要询问。`,
              open_file: openFileCtx,
              file_tree: fileTree,
              history: [],
            };
            setAgentThought('');
            break; // break shell loop → continue outer loop for fix
          }
        }

        // If no shell or read ops, agent is done
        if (shellOps.length === 0 && readOps.length === 0) {
          if (currentFix === 0 && shellCount === 0) {
            // Agent didn't try to run anything — maybe it analyzed and found nothing to do
            setPhase('failed');
            appendLog('\n\n  Agent did not produce any run commands.');
          } else if (phase !== 'fixing') {
            setPhase('success');
          }
          setRunning(false);
          return;
        }

        // If we got here after executing shell(s), the run completed
        if (shellOps.length > 0) {
          break;
        }
      }

      // If loop finished without explicit success/failure
      setPhase(currentFix > 0 && currentFix <= MAX_FIXES ? 'success' : 'running');
      setRunning(false);

    } catch (e: any) {
      if (e.name !== 'AbortError') {
        appendLog(`\n\n  Error: ${e.message}`);
        setPhase('failed');
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
      onFileChanged?.();
    }
  }, [projectPath, appendLog, appendShellLog, onFileChanged, shellCount]);

  useEffect(() => {
    startAutoRun();
    return () => {
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleStop = () => {
    abortRef.current?.abort();
    setRunning(false);
    setPhase((p) => (p === 'success' ? p : 'failed'));
  };

  const iconForPhase = (p: RunPhase) => {
    if (p === 'success') return '✓';
    if (p === 'failed') return '✗';
    if (p === 'fixing') return '↻';
    return '●';
  };

  const colorForPhase = (p: RunPhase) => {
    if (p === 'success') return '#3fb950';
    if (p === 'failed' || p === 'fixing') return '#f85149';
    return '#8ab4f8';
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: '#0d1117' }}>
      {/* Header */}
      <div className="flex items-center justify-between h-10 shrink-0 px-4 border-b" style={{ borderColor: '#21262d', background: '#161b22' }}>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="#8ab4f8" stroke="none">
              <polygon points="5,3 19,12 5,21" />
            </svg>
            <span className="text-[12px] font-medium" style={{ color: '#e3e2e6' }}>Run Project</span>
          </div>
          <span className="text-[11px]" style={{ color: '#5c6166' }}>
            {projectPath.split(/[\\/]/).pop()}
          </span>
        </div>
        <button
          onClick={running ? handleStop : onClose}
          className="px-3 py-1 rounded-md text-[11px] font-medium transition-colors"
          style={running ? { background: '#f8514920', color: '#f85149' } : { color: '#8e918f' }}
        >
          {running ? 'Stop' : 'Close'}
        </button>
      </div>

      {/* Status bar */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b shrink-0" style={{ borderColor: '#21262d', background: '#0d1117' }}>
        <span
          className="text-[16px] font-bold"
          style={{
            color: colorForPhase(phase),
            animation: running && phase !== 'fixing' ? 'pulse 2s infinite' : undefined,
          }}
        >
          {iconForPhase(phase)}
        </span>
        <div className="flex flex-col">
          <span className="text-[12px] font-medium" style={{ color: '#e3e2e6' }}>
            {PHASE_LABELS[phase]}
          </span>
          {fixCount > 0 && (
            <span className="text-[10px]" style={{ color: '#8b949e' }}>
              Fix attempt {fixCount}/{MAX_FIXES}
            </span>
          )}
        </div>
        {running && (
          <div className="ml-auto flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: colorForPhase(phase) }} />
            <span className="text-[10px]" style={{ color: '#8b949e' }}>
              {phase === 'analyzing' ? 'Reading project files...' :
               phase === 'installing' ? 'Installing deps...' :
               phase === 'building' ? 'Building...' :
               phase === 'running' ? 'Running...' :
               phase === 'fixing' ? 'Analyzing & fixing...' : 'Working...'}
            </span>
          </div>
        )}
      </div>

      {/* Main content: terminal log + agent thought */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Terminal output */}
        <div className="flex-1 overflow-hidden flex flex-col">
          <div className="px-4 py-1.5 border-b flex items-center shrink-0" style={{ borderColor: '#21262d', background: '#161b22' }}>
            <span className="text-[10px] font-medium uppercase tracking-wide" style={{ color: '#8b949e' }}>Terminal</span>
            <span className="ml-auto text-[10px] font-mono" style={{ color: '#484f58' }}>{shellCount} commands</span>
          </div>
          <div ref={logRef} className="flex-1 overflow-y-auto p-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap"
            style={{ color: '#c9d1d9' }}>
            {log || (
              <span style={{ color: '#484f58' }}>Waiting for agent to start...</span>
            )}
          </div>
        </div>

        {/* Agent thought */}
        <div className="shrink-0 border-t" style={{ borderColor: '#21262d', maxHeight: '30%' }}>
          <div className="px-4 py-1.5 border-b flex items-center" style={{ borderColor: '#21262d', background: '#161b22' }}>
            <span className="text-[10px] font-medium uppercase tracking-wide" style={{ color: '#8b949e' }}>Agent</span>
          </div>
          <div className="overflow-y-auto p-4 text-[12px] leading-relaxed" style={{ color: '#8b949e', maxHeight: 120 }}>
            {agentThought || (
              <span style={{ color: '#484f58' }}>Thinking...</span>
            )}
          </div>
        </div>
      </div>

      {/* Bottom bar */}
      <div className="flex items-center justify-between px-4 py-2 border-t shrink-0" style={{ borderColor: '#21262d', background: '#161b22' }}>
        <span className="text-[10px] font-mono" style={{ color: '#484f58' }}>
          {running ? 'Press Stop to cancel' : phase === 'success' ? 'All done — you can close this page' : 'Check terminal output for details'}
        </span>
        <span className="text-[10px]" style={{ color: colorForPhase(phase) }}>
          {phase === 'success' ? 'Exit 0' : phase === 'failed' ? 'Failed' : 'In progress'}
        </span>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
