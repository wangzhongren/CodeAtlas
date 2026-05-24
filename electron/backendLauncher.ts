import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { app } from 'electron';

let backendProcess: ChildProcess | null = null;

export function getBackendDir(): string {
  return path.join(app.getAppPath(), '..', 'backend');
}

export function startBackend(): Promise<void> {
  return new Promise((resolve, reject) => {
    const backendDir = getBackendDir();
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

    backendProcess = spawn(pythonCmd, ['-m', 'uvicorn', 'main:app', '--port', '19850'], {
      cwd: backendDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEATLAS_LLM_API_KEY: process.env.CODEATLAS_LLM_API_KEY || 'THKEY_6d3da9f716fb4033bfd4fb50',
        CODEATLAS_LLM_BASE_URL: process.env.CODEATLAS_LLM_BASE_URL || 'https://aiproxy2.abujlb.com/deepseek/v1',
      },
    });

    backendProcess.stdout?.on('data', (data: Buffer) => {
      const msg = data.toString();
      if (msg.includes('Uvicorn running on')) {
        resolve();
      }
    });

    backendProcess.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString();
      // Uvicorn logs to stderr
      if (msg.includes('Uvicorn running on') || msg.includes('Application startup complete')) {
        resolve();
      }
    });

    backendProcess.on('error', (err) => reject(err));
    backendProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`Backend exited with code ${code}`);
      }
    });

    // Timeout after 15s
    setTimeout(() => resolve(), 15000);
  });
}

export function stopBackend(): void {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
}
