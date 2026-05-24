import { useState, useEffect, useCallback } from 'react';

interface FeatureNode {
  id: string;
  label: string;
  level: number;
  parent_id: string | null;
  description: string;
  flow_description: string;
  files: string[];
  functions: string[];
  children: FeatureNode[];
  generated: boolean;
}

interface Props {
  projectPath: string | null;
  onNavigateToFile: (path: string) => void;
}

const COL = {
  surface: '#1a1c1e',
  surfaceVariant: '#282a2d',
  onSurface: '#e3e2e6',
  onSurfaceVariant: '#c4c7c5',
  outline: '#444746',
  outlineSoft: '#303234',
  primary: '#8ab4f8',
  green: '#3fb950',
  yellow: '#d29922',
};

const LEVEL_COLORS: Record<number, string> = {
  1: '#8ab4f8',
  2: '#3fb950',
  3: '#d29922',
};

export default function FeaturePanel({ projectPath, onNavigateToFile }: Props) {
  const [features, setFeatures] = useState<FeatureNode[]>([]);
  const [selected, setSelected] = useState<FeatureNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [drilling, setDrilling] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  // Load persisted features on mount / project change
  const loadFeatures = useCallback(async () => {
    if (!projectPath) return;
    try {
      const res = await fetch(`/api/v1/features?project_path=${encodeURIComponent(projectPath)}`);
      const data = await res.json();
      setFeatures(data.features || []);
    } catch { /* */ }
  }, [projectPath]);

  useEffect(() => { loadFeatures(); }, [loadFeatures]);

  // Poll for code changes from bottom agent
  useEffect(() => {
    if (!projectPath) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/v1/changes/pending?project_path=${encodeURIComponent(projectPath)}`);
        const data = await res.json();
        if (data.has_pending) {
          setPolling(true);
          // Reload features since they may have been regenerated
          await loadFeatures();
          setPolling(false);
        }
      } catch { /* */ }
    }, 5000); // poll every 5 seconds
    return () => clearInterval(interval);
  }, [projectPath, loadFeatures]);

  // Generate top-level features
  const handleGenerate = async () => {
    if (!projectPath) return;
    setLoading(true);
    try {
      let fileTree: any[] = [];
      try {
        fileTree = await window.codeatlas.file.listDirectory(projectPath);
      } catch { /* */ }
      const res = await fetch('/api/v1/features/analyze-top', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_path: projectPath, file_tree: fileTree }),
      });
      const data = await res.json();
      if (data.features) {
        setFeatures(data.features);
        setSelected(null);
      }
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  // Drill down into a node
  const handleDrillDown = async (node: FeatureNode) => {
    if (node.generated && node.children.length > 0) {
      setSelected(node);
      return;
    }
    setDrilling(node.id);
    try {
      const res = await fetch('/api/v1/features/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_path: projectPath,
          node_id: node.id,
          parent_context: node.flow_description || node.description,
        }),
      });
      const data = await res.json();
      if (data.nodes?.length > 0) {
        const updated = { ...node, children: data.nodes, generated: true };
        setSelected(updated);
        // Update in tree too
        setFeatures((prev) => updateNodeInTree(prev, updated));
      }
    } catch (e) { console.error(e); }
    setDrilling(null);
  };

  const handleBack = () => {
    setSelected(null);
  };

  const handleSelectAndDrill = (node: FeatureNode) => {
    if (node.level < 3) {
      handleDrillDown(node);
    } else {
      // Level 3: show code files
      setSelected(node);
    }
  };

  const items = selected?.children?.length ? selected.children : features;

  return (
    <div className="flex flex-col h-full" style={{ background: COL.surface }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b shrink-0" style={{ borderColor: COL.outline }}>
        <div className="flex items-center gap-2 min-w-0">
          {selected && (
            <button onClick={handleBack} className="p-0.5 rounded hover:bg-white/5 shrink-0" style={{ color: COL.onSurfaceVariant }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </button>
          )}
          <span className="text-xs font-medium uppercase tracking-wide truncate" style={{ color: COL.onSurfaceVariant }}>
            {selected ? selected.label : 'Features'}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {polling && <span className="text-[9px] animate-pulse" style={{ color: COL.yellow }}>syncing...</span>}
          <button
            onClick={handleGenerate}
            disabled={loading || !projectPath}
            className="text-[10px] px-2 py-1 rounded-full transition-colors hover:opacity-80 disabled:opacity-30"
            style={{ background: '#003a75', color: COL.primary }}
          >
            {loading ? 'Analyzing...' : features.length > 0 ? 'Refresh' : 'Analyze'}
          </button>
        </div>
      </div>

      {/* Selected node detail */}
      {selected && (
        <div className="px-3 py-2.5 border-b space-y-1.5 shrink-0" style={{ borderColor: COL.outlineSoft }}>
          <div className="flex items-center gap-1.5">
            <span className="px-1.5 py-0.5 rounded text-[9px] font-medium" style={{ background: LEVEL_COLORS[selected.level] + '20', color: LEVEL_COLORS[selected.level] }}>
              L{selected.level}
            </span>
            <span className="text-xs font-medium" style={{ color: COL.onSurface }}>{selected.label}</span>
          </div>
          <div className="text-[11px] leading-relaxed" style={{ color: COL.onSurfaceVariant }}>
            {selected.description || selected.flow_description}
          </div>
          {/* Files */}
          {selected.files.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {selected.files.map((f) => (
                <button
                  key={f}
                  onClick={() => {
                    const isAbs = /^[a-zA-Z]:[\\/]/.test(f);
                    onNavigateToFile(isAbs ? f : (projectPath ? `${projectPath.replace(/\\/g, '/')}/${f}` : f));
                  }}
                  className="text-[10px] px-1.5 py-0.5 rounded font-mono transition-colors hover:bg-white/10"
                  style={{ background: COL.surfaceVariant, color: COL.primary }}
                  title={f}
                >
                  {f.split(/[\\/]/).pop()}
                </button>
              ))}
            </div>
          )}
          {/* Functions */}
          {selected.functions.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {selected.functions.map((fn) => (
                <span key={fn} className="text-[10px] px-1.5 py-0.5 rounded font-mono"
                  style={{ background: '#262016', color: '#fce8b2' }}>
                  {fn}()
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Node list */}
      <div className="flex-1 overflow-y-auto py-1">
        {features.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center h-full gap-3 px-4">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#5c6166" strokeWidth="1.5">
              <circle cx="12" cy="5" r="2" /><circle cx="5" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
              <circle cx="12" cy="19" r="2" /><line x1="12" y1="7" x2="5" y2="10" />
              <line x1="12" y1="7" x2="19" y2="10" /><line x1="7" y1="13" x2="5" y2="10" />
              <line x1="17" y1="13" x2="19" y2="10" /><line x1="12" y1="17" x2="7" y2="14" />
              <line x1="12" y1="17" x2="17" y2="14" />
            </svg>
            <div className="text-xs text-center" style={{ color: '#5c6166' }}>
              Click <span style={{ color: COL.primary }}>Analyze</span> to discover project features
            </div>
          </div>
        )}

        {items.map((node) => (
          <button
            key={node.id}
            onClick={() => handleSelectAndDrill(node)}
            disabled={drilling === node.id}
            className="w-full text-left px-3 py-2.5 border-b transition-colors hover:bg-white/[0.03] disabled:opacity-50"
            style={{ borderColor: COL.outlineSoft }}
          >
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full shrink-0" style={{ background: LEVEL_COLORS[node.level] || '#8e918f' }} />
              <span className="text-xs font-medium truncate" style={{ color: COL.onSurface }}>
                {node.label}
                {drilling === node.id && <span className="ml-1 animate-pulse" style={{ color: COL.yellow }}>...</span>}
              </span>
              {!node.generated && node.level < 3 && (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={COL.onSurfaceVariant} strokeWidth="2" className="ml-auto shrink-0 opacity-40">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              )}
              {node.generated && node.children.length > 0 && (
                <span className="ml-auto text-[9px] shrink-0" style={{ color: '#5c6166' }}>{node.children.length}</span>
              )}
            </div>
            <div className="text-[10px] mt-0.5 ml-4 truncate" style={{ color: '#5c6166' }}>
              {node.description.slice(0, 60) || node.flow_description.slice(0, 60)}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── Tree update helper ── */
function updateNodeInTree(nodes: FeatureNode[], updated: FeatureNode): FeatureNode[] {
  return nodes.map((n) => {
    if (n.id === updated.id) return updated;
    if (n.children?.length) {
      return { ...n, children: updateNodeInTree(n.children, updated) };
    }
    return n;
  });
}
