/**
 * Shared SSE streaming + shell execution helpers.
 * Used by both AgentPanel (chat) and RunPage (auto-run).
 */

export interface StreamResult {
  message: string;
  operations: Array<{
    type: string;
    file: string;
    start_line?: number;
    end_line?: number;
    after_line?: number;
    content?: string;
    pending?: boolean;
  }>;
}

/** Stream an agent response via SSE, calling onToken for each token chunk. */
export async function streamAgentResponse(
  body: Record<string, any>,
  signal: AbortSignal | undefined,
  onToken: (token: string) => void,
): Promise<StreamResult> {
  const res = await fetch('/api/v1/agent/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
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
        onToken(eventData);
      } else if (eventType === 'done') {
        try {
          const d = JSON.parse(eventData);
          fullMessage = d.message || fullMessage;
          finalOps = (d.operations || []).map((op: any) => ({
            ...op,
            pending: op.type === 'run_shell',
          }));
        } catch { /* ignore */ }
      }
    }
  }

  return { message: fullMessage, operations: finalOps };
}

/** Execute a shell command and wait for completion. Returns output + exit code. */
export function executeShellAndWait(
  command: string,
  onData?: (data: string) => void,
  timeoutMs = 60000,
): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve) => {
    const shellId = window.codeatlas.shell.run(command);
    let output = '';
    let resolved = false;

    window.codeatlas.shell.onData((id, data) => {
      if (id !== shellId) return;
      output += data;
      onData?.(data);
    });

    window.codeatlas.shell.onDone((id, code) => {
      if (id !== shellId || resolved) return;
      resolved = true;
      resolve({ output, exitCode: code ?? -1 });
    });

    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      resolve({ output: output + '\n[timeout — still running in background]', exitCode: -1 });
    }, timeoutMs);
  });
}
