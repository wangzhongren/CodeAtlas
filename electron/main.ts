import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { startBackend, stopBackend } from './backendLauncher';
import {
  listDirectory, readFile, writeFile,
  insertLines, replaceLines, deleteLines,
  runShell, killShell, getShellLogFile, readLogFile,
} from './fileManager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let projectPath: string = '';

function resolveProjectPath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  return path.join(projectPath, filePath);
}

function registerIpcHandlers(): void {
  // Window controls
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) { mainWindow?.unmaximize(); }
    else { mainWindow?.maximize(); }
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false);

  // File operations
  ipcMain.handle('file:getProjectPath', () => projectPath);

  ipcMain.handle('file:openProject', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      title: '选择项目文件夹',
    });
    if (result.canceled || !result.filePaths.length) return null;
    projectPath = result.filePaths[0];
    mainWindow?.webContents.send('project:opened', projectPath);
    return projectPath;
  });

  ipcMain.handle('file:listDirectory', (_e, dirPath: string) => {
    return listDirectory(resolveProjectPath(dirPath));
  });

  ipcMain.handle('file:readFile', (_e, filePath: string, startLine?: number, endLine?: number) => {
    return readFile(resolveProjectPath(filePath), startLine, endLine);
  });

  ipcMain.handle('file:writeFile', (_e, filePath: string, content: string) => {
    return writeFile(resolveProjectPath(filePath), content);
  });

  ipcMain.handle('file:insertLines', (_e, filePath: string, afterLine: number, content: string) => {
    return insertLines(resolveProjectPath(filePath), afterLine, content);
  });

  ipcMain.handle('file:replaceLines', (_e, filePath: string, startLine: number, endLine: number, content: string) => {
    return replaceLines(resolveProjectPath(filePath), startLine, endLine, content);
  });

  ipcMain.handle('file:deleteLines', (_e, filePath: string, startLine: number, endLine: number) => {
    return deleteLines(resolveProjectPath(filePath), startLine, endLine);
  });

  // Shell execution — streaming via event
  ipcMain.on('shell:run', (event, command: string) => {
    const cwd = projectPath || process.cwd();
    const id = runShell(
      command, cwd,
      (data) => {
        if (!mainWindow?.isDestroyed()) {
          mainWindow?.webContents.send('shell:data', { id, data });
        }
      },
      (code) => {
        if (!mainWindow?.isDestroyed()) {
          mainWindow?.webContents.send('shell:done', { id, code });
        }
      },
      (err) => {
        if (!mainWindow?.isDestroyed()) {
          mainWindow?.webContents.send('shell:error', { id, error: err });
        }
      },
    );
    event.returnValue = id;
  });

  ipcMain.on('shell:kill', (_e, id: string) => {
    killShell(id);
  });

  ipcMain.handle('shell:getLogFile', (_e, id: string) => {
    return getShellLogFile(id);
  });

  ipcMain.handle('shell:readLog', (_e, logFile: string) => {
    return readLogFile(logFile);
  });
}

function getPreloadPath(): string {
  const candidates = [
    path.join(__dirname, 'preload.js'),
    path.join(__dirname, 'preload.mjs'),
  ];
  console.log('[main] preload candidates:', candidates);
  return candidates[0];
}

function createWindow(): void {
  const preloadPath = getPreloadPath();
  console.log('[main] preload path:', preloadPath);
  console.log('[main] __dirname:', __dirname);

  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 700,
    title: 'CodeAtlas CodeAtlas',
    backgroundColor: '#1a1c1e',
    frame: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(async () => {
  registerIpcHandlers();

  // Start Python backend
  try {
    await startBackend();
    console.log('Backend started on port 19850');
  } catch (e) {
    console.error('Failed to start backend:', e);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopBackend();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopBackend();
});
