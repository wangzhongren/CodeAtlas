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
}

export interface CodeAtlasAPI {
  file: {
    openProject: () => Promise<string | null>;
    listDirectory: (dirPath: string) => Promise<FileEntry[]>;
    readFile: (filePath: string, startLine?: number, endLine?: number) => Promise<FileContent>;
    writeFile: (filePath: string, content: string) => Promise<EditResult>;
    insertLines: (filePath: string, afterLine: number, content: string) => Promise<EditResult>;
    replaceLines: (filePath: string, startLine: number, endLine: number, content: string) => Promise<EditResult>;
    deleteLines: (filePath: string, startLine: number, endLine: number) => Promise<EditResult>;
    getProjectPath: () => Promise<string>;
    onProjectOpened: (cb: (path: string) => void) => void;
  };
  shell: {
    run: (command: string) => string;
    kill: (id: string) => void;
    getLogFile: (id: string) => Promise<string | null>;
    readLog: (logFile: string) => Promise<string>;
    onData: (cb: (id: string, data: string) => void) => void;
    onDone: (cb: (id: string, code: number | null) => void) => void;
    onError: (cb: (id: string, error: string) => void) => void;
  };
  backend: {
    getUrl: () => string;
  };
  window: {
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
  };
}

declare global {
  interface Window {
    codeatlas: CodeAtlasAPI;
  }
}
