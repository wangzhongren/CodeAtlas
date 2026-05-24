import { useState, useEffect, useCallback } from 'react';
import type { FileEntry } from '../types/electron.d';

interface Props {
  projectPath: string | null;
  onSelectFile: (path: string) => void;
  onRefresh: () => void;
}

function TreeItem({
  entry,
  depth,
  onSelect,
}: {
  entry: FileEntry;
  depth: number;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 1);

  if (entry.type === 'directory') {
    return (
      <div>
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1.5 w-full text-left py-1 px-2 rounded-md text-xs hover:bg-white/5 transition-colors"
          style={{ paddingLeft: 8 + depth * 14, color: '#8ab4f8' }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}>
            <path d="M9 18l6-6-6-6" />
          </svg>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="shrink-0" opacity="0.6">
            <path d="M2 6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6z" />
          </svg>
          <span className="truncate font-medium">{entry.name}</span>
        </button>
        {open && entry.children?.map((child) => (
          <TreeItem key={child.path} entry={child} depth={depth + 1} onSelect={onSelect} />
        ))}
      </div>
    );
  }

  return (
    <button
      onClick={() => onSelect(entry.path)}
      className="flex items-center gap-1.5 w-full text-left py-1 px-2 rounded-md text-xs hover:bg-white/5 transition-colors truncate"
      style={{ paddingLeft: 8 + depth * 14 + 20, color: '#c4c7c5' }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0" opacity="0.5">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <span className="truncate">{entry.name}</span>
    </button>
  );
}

export default function FileExplorer({ projectPath, onSelectFile, onRefresh }: Props) {
  const [tree, setTree] = useState<FileEntry[]>([]);

  const loadTree = useCallback(async () => {
    if (!projectPath) return;
    try {
      const data = await window.codeatlas.file.listDirectory(projectPath);
      setTree(data);
    } catch { /* Electron IPC not available in browser dev */ }
  }, [projectPath]);

  useEffect(() => { loadTree(); }, [loadTree]);

  const handleOpenProject = async () => {
    try {
      const p = await window.codeatlas.file.openProject();
      if (p) onRefresh();
    } catch { /* Electron IPC not available */ }
  };

  // Fallback for browser dev mode
  const isElectron = typeof window.codeatlas !== 'undefined';

  return (
    <div className="flex flex-col h-full" style={{ background: '#282a2d' }}>
      <div className="flex items-center justify-between px-3 py-2.5 border-b" style={{ borderColor: '#444746' }}>
        <span className="text-xs font-medium uppercase tracking-wide" style={{ color: '#c4c7c5' }}>
          Explorer
        </span>
        <div className="flex gap-1">
          <button onClick={loadTree} className="p-1 rounded-md hover:bg-white/5" title="Refresh">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8e918f" strokeWidth="2">
              <path d="M1 4v6h6M23 20v-6h-6" /><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
            </svg>
          </button>
          {isElectron && (
            <button onClick={handleOpenProject} className="p-1 rounded-md hover:bg-white/5" title="Open Folder">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8e918f" strokeWidth="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {projectPath ? (
          tree.length > 0 ? (
            tree.map((entry) => (
              <TreeItem key={entry.path} entry={entry} depth={0} onSelect={onSelectFile} />
            ))
          ) : (
            <div className="text-xs text-center mt-8" style={{ color: '#8e918f' }}>
              Empty project
            </div>
          )
        ) : (
          <div className="p-4 text-center">
            {isElectron ? (
              <button
                onClick={handleOpenProject}
                className="px-4 py-2 rounded-full text-xs font-medium border transition-colors hover:bg-white/5"
                style={{ borderColor: '#8ab4f8', color: '#8ab4f8' }}
              >
                Open Folder
              </button>
            ) : (
              <div className="text-xs" style={{ color: '#8e918f' }}>
                Run in Electron to browse files
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
