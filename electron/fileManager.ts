import * as fs from 'fs';
import * as path from 'path';

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileEntry[];
}

export interface FileContent {
  path: string;
  lines: string[];
  content: string;
  lineCount: number;
}

export interface EditResult {
  success: boolean;
  error?: string;
  file?: string;
  backupId?: string;
}

const IGNORE_PATTERNS = [
  'node_modules', '.git', '__pycache__', '.venv', 'venv',
  'dist', '.next', '.nuxt', 'coverage', '.cache',
  '.codeatlas',
  '*.pyc', '*.pyo', '*.exe', '*.dll', '*.so', '*.dylib',
  '.DS_Store', 'Thumbs.db',
];

function shouldIgnore(name: string): boolean {
  return IGNORE_PATTERNS.some((p) => {
    if (p.includes('*')) return new RegExp('^' + p.replace(/\*/g, '.*') + '$').test(name);
    return p === name;
  });
}

export function listDirectory(dirPath: string, depth = 3): FileEntry[] {
  if (depth <= 0) return [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const result: FileEntry[] = [];

    for (const entry of entries) {
      if (shouldIgnore(entry.name)) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const children = listDirectory(fullPath, depth - 1);
        result.push({ name: entry.name, path: fullPath, type: 'directory', children });
      } else if (entry.isFile()) {
        result.push({ name: entry.name, path: fullPath, type: 'file' });
      }
    }
    return result.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch {
    return [];
  }
}

export function readFile(filePath: string, startLine?: number, endLine?: number): FileContent {
  const content = fs.readFileSync(filePath, 'utf-8');
  let lines = content.split('\n');
  if (startLine && endLine) {
    lines = lines.slice(startLine - 1, endLine);
  } else if (startLine) {
    lines = lines.slice(startLine - 1);
  }
  const sliced = lines.join('\n');
  return {
    path: filePath,
    lines,
    content: sliced,
    lineCount: lines.length,
  };
}

function findProjectRoot(filePath: string): string {
  let current = fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()
    ? filePath
    : path.dirname(filePath);
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git')) || fs.existsSync(path.join(current, '.codeatlas'))) {
      return current;
    }
    current = path.dirname(current);
  }
  return path.dirname(filePath);
}

function createBackup(filePath: string, operation: string): string | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const root = findProjectRoot(filePath);
    const rel = path.relative(root, filePath);
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const backupDir = path.join(root, '.codeatlas', 'backups', id);
    fs.mkdirSync(backupDir, { recursive: true });
    const backupFile = path.join(backupDir, 'before');
    fs.copyFileSync(filePath, backupFile);
    fs.writeFileSync(path.join(backupDir, 'meta.json'), JSON.stringify({
      id,
      operation,
      file: rel,
      createdAt: new Date().toISOString(),
    }, null, 2), 'utf-8');
    return id;
  } catch {
    return undefined;
  }
}

export function restoreBackup(projectPath: string, backupId: string): EditResult {
  try {
    const backupDir = path.join(projectPath, '.codeatlas', 'backups', backupId);
    const metaPath = path.join(backupDir, 'meta.json');
    const backupFile = path.join(backupDir, 'before');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    const target = path.join(projectPath, meta.file);
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(backupFile, target);
    return { success: true, file: target, backupId };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

export function writeFile(filePath: string, content: string): EditResult {
  try {
    const backupId = createBackup(filePath, 'write_file');
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true, file: filePath, backupId };
  } catch (e: any) {
    return { success: false, error: e.message, file: filePath };
  }
}

export function insertLines(filePath: string, afterLine: number, content: string): EditResult {
  try {
    const backupId = createBackup(filePath, 'insert_lines');
    const fc = readFile(filePath);
    const newLines = [...fc.lines];
    newLines.splice(afterLine, 0, ...content.split('\n'));
    fs.writeFileSync(filePath, newLines.join('\n'), 'utf-8');
    return { success: true, file: filePath, backupId };
  } catch (e: any) {
    return { success: false, error: e.message, file: filePath };
  }
}

export function replaceLines(
  filePath: string, startLine: number, endLine: number, content: string
): EditResult {
  try {
    const backupId = createBackup(filePath, 'replace_lines');
    const fc = readFile(filePath);
    const newLines = [...fc.lines];
    newLines.splice(startLine - 1, endLine - startLine + 1, ...content.split('\n'));
    fs.writeFileSync(filePath, newLines.join('\n'), 'utf-8');
    return { success: true, file: filePath, backupId };
  } catch (e: any) {
    return { success: false, error: e.message, file: filePath };
  }
}

export function deleteLines(filePath: string, startLine: number, endLine: number): EditResult {
  try {
    const backupId = createBackup(filePath, 'delete_lines');
    const fc = readFile(filePath);
    const newLines = [...fc.lines];
    newLines.splice(startLine - 1, endLine - startLine + 1);
    fs.writeFileSync(filePath, newLines.join('\n'), 'utf-8');
    return { success: true, file: filePath, backupId };
  } catch (e: any) {
    return { success: false, error: e.message, file: filePath };
  }
}

export function getProjectName(dirPath: string): string {
  return path.basename(dirPath);
}

/* ── Shell execution ── */
import { spawn, ChildProcess } from 'child_process';

interface RunningProcess {
  child: ChildProcess;
  logFile: string;
}

const runningProcesses = new Map<string, RunningProcess>();

export function runShell(
  command: string,
  cwd: string,
  onData: (data: string) => void,
  onDone: (code: number | null) => void,
  onError: (err: string) => void,
): string {
  const id = `shell_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  // Write output to a log file as well
  const logDir = path.join(cwd, '.codeatlas-logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${id}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  const log = (text: string) => {
    logStream.write(text);
    onData(text);
  };

  // Use spawn for streaming, supports long-running processes
  const child = spawn(command, [], {
    cwd,
    shell: true,
    env: { ...process.env, FORCE_COLOR: '1' },
  });

  runningProcesses.set(id, { child, logFile });

  log(`$ ${command}\n\n`);

  child.stdout?.on('data', (d: Buffer) => log(d.toString()));
  child.stderr?.on('data', (d: Buffer) => log(d.toString()));

  child.on('close', (code) => {
    log(`\n[exit ${code}]\n`);
    logStream.end();
    runningProcesses.delete(id);
    onDone(code);
  });

  child.on('error', (err) => {
    log(`\n[error: ${err.message}]\n`);
    logStream.end();
    runningProcesses.delete(id);
    onError(err.message);
  });

  return id;
}

export function getShellLogFile(id: string): string | null {
  const proc = runningProcesses.get(id);
  return proc ? proc.logFile : null;
}

export function readLogFile(logFile: string): string {
  try { return fs.readFileSync(logFile, 'utf-8'); } catch { return ''; }
}

export function killShell(id: string): boolean {
  const child = runningProcesses.get(id);
  if (child) {
    child.kill();
    runningProcesses.delete(id);
    return true;
  }
  return false;
}
