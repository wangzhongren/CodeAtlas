import { useState, useEffect, useRef } from 'react';
import type { FeatureNode } from '../types/feature';
import { useTaskStore } from '../store/taskStore';

interface Props {
  feature: FeatureNode | null;
  projectPath: string | null;
  onNavigateToFile: (path: string, line?: number) => void;
  onDrillDown: (node: FeatureNode) => void;
  onSendToAgent?: (context: string) => void;
  onReloadFeatures?: () => void;
}

const COL = {
  surface: '#1a1c1e',
  surfaceVariant: '#282a2d',
  onSurface: '#e3e2e6',
  onSurfaceVariant: '#c4c7c5',
  outline: '#444746',
  outlineSoft: '#303234',
  primary: '#8ab4f8',
  yellow: '#d29922',
};

const LV: Record<number, string> = { 0: '#8b949e', 1: '#8ab4f8', 2: '#3fb950', 3: '#d29922' };

function resolvePath(f: string, projectPath: string | null): string {
  if (/^[a-zA-Z]:[\\/]/.test(f)) return f;
  return projectPath ? `${projectPath.replace(/\\/g, '/')}/${f}` : f;
}

function parseFn(fn: string): { name: string; line?: number } {
  const m = fn.match(/^(.+):(\d+)$/);
  return m ? { name: m[1], line: parseInt(m[2]) } : { name: fn };
}

/* ── Simple Markdown renderer ── */
function Markdown({ text }: { text: string }) {
  if (!text) return null;
  // Split into blocks by double newline
  const blocks = text.split(/\n\n+/);
  return (
    <div className="text-[12px] leading-relaxed space-y-2" style={{ color: '#c9d1d9' }}>
      {blocks.map((block, i) => {
        // Headers
        if (block.match(/^### /)) {
          return <div key={i} className="text-[12px] font-medium pt-1" style={{ color: '#e3e2e6' }}>{block.replace(/^### /, '')}</div>;
        }
        if (block.match(/^## /)) {
          return <div key={i} className="text-[13px] font-semibold pt-2" style={{ color: '#f0f0f0' }}>{block.replace(/^## /, '')}</div>;
        }
        if (block.match(/^# /)) {
          return <div key={i} className="text-[14px] font-bold pt-3" style={{ color: '#fff' }}>{block.replace(/^# /, '')}</div>;
        }
        // List items
        if (block.match(/^[-*] /m)) {
          const items = block.split('\n').filter((l) => l.match(/^[-*] /));
          return (
            <ul key={i} className="space-y-0.5 pl-4" style={{ listStyle: 'disc', color: '#8b949e' }}>
              {items.map((item, j) => (
                <li key={j} style={{ color: '#c9d1d9' }}>
                  {renderInline(item.replace(/^[-*] /, ''))}
                </li>
              ))}
            </ul>
          );
        }
        // Code blocks
        if (block.startsWith('```')) {
          const code = block.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
          return (
            <pre key={i} className="rounded-lg p-3 text-[11px] overflow-x-auto" style={{ background: '#0d1117', color: '#c9d1d9', border: '1px solid #21262d' }}>
              <code>{code}</code>
            </pre>
          );
        }
        // Regular paragraph
        return <p key={i}>{renderInline(block)}</p>;
      })}
    </div>
  );
}

function renderInline(text: string): React.ReactNode {
  // Bold, italic, inline code
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i} className="px-0.5 rounded text-[11px]" style={{ background: '#21262d', color: '#f778ba' }}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
}

export default function FeatureDetail({ feature, projectPath, onNavigateToFile, onDrillDown, onSendToAgent, onReloadFeatures }: Props) {
  const [drilling, setDrilling] = useState<string | null>(null);
  const [drillError, setDrillError] = useState<string | null>(null);
  const [overviewHtml, setOverviewHtml] = useState<string | null>(null);
  const [overviewFiles, setOverviewFiles] = useState<Array<{path:string;description:string}>>([]);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const loadingNodeIds = useRef<Set<string>>(new Set());

  // Collect all files from tree for overview display
  useEffect(() => {
    setOverviewHtml(null);
    setOverviewFiles([]);
    if (!feature || feature.level !== 0) return;

    // Collect files from all descendants
    const allFiles: Array<{path: string; description: string}> = [];
    const collectFiles = (nodes: FeatureNode[]) => {
      for (const n of nodes) {
        for (const f of n.files || []) {
          if (!allFiles.find((x) => x.path === f)) {
            allFiles.push({ path: f, description: n.description || n.flow_description || '' });
          }
        }
        collectFiles(n.children || []);
      }
    };
    collectFiles([feature]);
    setOverviewFiles(allFiles.slice(0, 20));

    // Load cached overview + issues from node data
    const cachedOverview = feature.flow_description;
    if (cachedOverview) {
      setOverviewHtml(cachedOverview);
    } else if (!loadingNodeIds.current.has(feature.id)) {
      handleRefreshOverview();
    }

  }, [feature?.id, feature?.flow_description]);

  if (!feature) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ background: COL.surface }}>
        <div className="text-xs text-center" style={{ color: '#5c6166' }}>
          Select a feature to see its details
        </div>
      </div>
    );
  }

  const handleRefreshOverview = async () => {
    if (!feature || !projectPath) return;
    if (loadingNodeIds.current.has(feature.id)) return; // already loading this node
    setOverviewLoading(true);
    loadingNodeIds.current.add(feature.id);
    const allFiles: string[] = [];
    const collectFiles = (nodes: FeatureNode[]) => { for (const n of nodes) { allFiles.push(...(n.files || [])); collectFiles(n.children || []); } };
    collectFiles([feature]);
    const taskId = `overview_${Date.now()}`;
    useTaskStore.getState().addTask({ id: taskId, type: 'analyze', label: `Analyze: ${feature.label}`, status: 'running', startedAt: Date.now(), detail: 'Exploring code...' });
    try {
      const res = await fetch('/api/v1/features/overview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_path: projectPath, node_id: feature.id, files: [...new Set(allFiles)].slice(0, 10) }),
      });
      const d = await res.json();
      setOverviewHtml(d.overview || '');
      if (d.files?.length) setOverviewFiles(d.files);
      // Update parent component with cached data so re-selecting loads from cache
      onDrillDown({ ...feature, flow_description: d.overview || feature.flow_description, generated: true });
      useTaskStore.getState().updateTask(taskId, { status: 'done', detail: `${d.issues?.length || 0} issues` });
      // Force FeatureList to reload from DB so cached data persists across navigation
      setTimeout(() => onReloadFeatures?.(), 500);
    } catch {
      useTaskStore.getState().updateTask(taskId, { status: 'error', detail: 'Failed' });
    }
    setOverviewLoading(false);
    loadingNodeIds.current.delete(feature.id);
    setTimeout(() => useTaskStore.getState().removeTask(taskId), 3000);
  };

  const handleDrill = async (node: FeatureNode) => {
    if (node.generated && node.children.length > 0) { onDrillDown(node); return; }
    if (node.level >= 3) return;
    setDrilling(node.id);
    setDrillError(null);
    const taskId = `drill_${Date.now()}`;
    useTaskStore.getState().addTask({ id: taskId, type: 'analyze', label: `Analyze: ${node.label}`, status: 'running', startedAt: Date.now(), detail: 'Reading files...' });
    try {
      const res = await fetch('/api/v1/features/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_path: projectPath, node_id: node.id, parent_context: node.flow_description || node.description }),
      });
      const data = await res.json();
      if (data.nodes?.length > 0) {
        onDrillDown({ ...node, children: data.nodes, generated: true });
        useTaskStore.getState().updateTask(taskId, { status: 'done', detail: `${data.nodes.length} steps` });
      } else if (data.error) {
        setDrillError(data.error);
        useTaskStore.getState().updateTask(taskId, { status: 'error', detail: data.error });
      } else {
        setDrillError('No flow steps generated. Try again.');
        useTaskStore.getState().updateTask(taskId, { status: 'error', detail: 'No steps generated' });
      }
    } catch (e: any) {
      setDrillError(e.message || 'Network error');
      useTaskStore.getState().updateTask(taskId, { status: 'error', detail: e.message || 'Failed' });
    }
    setDrilling(null);
    setTimeout(() => useTaskStore.getState().removeTask(taskId), 3000);
  };

  const children = feature.children || [];
  const isOverview = feature.level <= 1; // Level 0 root or Level 1 group → overview page

  return (
    <div className="flex flex-col h-full" style={{ background: COL.surface }}>
      {/* Header */}
      <div className="flex items-center px-4 py-2.5 border-b gap-2 shrink-0" style={{ borderColor: COL.outline }}>
        <span className="text-xs font-medium truncate flex-1" style={{ color: COL.onSurface }}>{feature.label}</span>
        <span className="px-1.5 py-0.5 rounded text-[9px] font-mono shrink-0" style={{ background: LV[feature.level] + '20', color: LV[feature.level] }}>L{feature.level}</span>
        {onSendToAgent && (
          <button onClick={() => {
            const files = (overviewFiles.length > 0 ? overviewFiles : feature.files.map((f: string) => ({ path: f, description: '' })))
              .map((f: any) => f.path).filter(Boolean);
            onSendToAgent(`当前焦点: ${feature.label}\n参考文件: ${files.join(', ') || '无'}`);
          }}
            className="text-[9px] px-2 py-0.5 rounded-full shrink-0 hover:bg-white/10 transition-colors"
            style={{ border: '1px solid #303234', color: COL.primary }}>
            Ask Agent
          </button>
        )}
      </div>

      {/* ── Overview page (Level 0 / Level 1) ── */}
      {isOverview && (
        <div className="flex-1 overflow-y-auto">
          {/* Loading */}
          {overviewLoading && !overviewHtml && (
            <div className="px-4 py-4 text-[11px] flex items-center gap-2" style={{ color: '#5c6166' }}>
              <span className="w-1.5 h-1.5 rounded-full animate-pulse-dot" style={{ background: '#8ab4f8' }} />
              Analyzing structure & issues... (10-30s)
            </div>
          )}

          {/* Description block */}
          {(overviewHtml || feature.flow_description || feature.description) && (
            <div className="px-4 py-3 border-b" style={{ borderColor: COL.outlineSoft }}>
              <div className="mb-2">
                <span className="text-[10px] font-medium uppercase tracking-wide" style={{ color: '#5c6166' }}>Overview</span>
              </div>
              <Markdown text={overviewHtml || feature.flow_description || feature.description || ''} />
            </div>
          )}

          {/* File links */}
          {(feature.files.length > 0 || overviewFiles.length > 0) && (
            <div className="px-4 py-3 border-b" style={{ borderColor: COL.outlineSoft }}>
              <div className="text-[10px] font-medium mb-2 uppercase tracking-wide" style={{ color: '#5c6166' }}>Key Files</div>
              <div className="space-y-1.5">
                {(overviewFiles.length > 0 ? overviewFiles : feature.files.map((f: string) => ({ path: f, description: '' }))).map((f: any) => (
                  <div key={f.path} className="flex items-start gap-2">
                    <button onClick={() => onNavigateToFile(resolvePath(f.path, projectPath))}
                      className="text-[11px] px-2 py-0.5 rounded font-mono transition-colors hover:bg-white/10 shrink-0"
                      style={{ background: COL.surfaceVariant, color: COL.primary }}>
                      {f.path.split(/[\\/]/).pop()}
                    </button>
                    {f.description && (
                      <span className="text-[10px] leading-relaxed" style={{ color: '#5c6166' }}>{f.description}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Children: groups or features */}
          {children.length > 0 && (
            <div className="px-4 py-3">
              <div className="text-[10px] font-medium mb-2 uppercase tracking-wide" style={{ color: '#5c6166' }}>
                {feature.level === 0 ? 'Feature Groups' : 'Features'}
              </div>
              <div className="grid grid-cols-1 gap-1.5">
                {children.map((child) => (
                  <button key={child.id}
                    onClick={() => onDrillDown(child)}
                    disabled={child.level >= 3}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors hover:bg-white/[0.04] disabled:opacity-40"
                    style={{ border: '1px solid #30323440' }}>
                    <div className="w-2 h-2 rounded-full shrink-0" style={{ background: LV[child.level] || '#8e918f' }} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] font-medium truncate" style={{ color: '#c9d1d9' }}>{child.label}</div>
                      {(child.description || child.flow_description) && (
                        <div className="text-[10px] mt-0.5 truncate" style={{ color: '#5c6166' }}>
                          {(child.description || child.flow_description).slice(0, 60)}
                        </div>
                      )}
                      {child.files.length > 0 && (
                        <div className="flex gap-1 mt-1">
                          {child.files.slice(0, 3).map((f) => (
                            <span key={f} className="text-[9px] px-1 rounded font-mono" style={{ background: COL.surfaceVariant, color: COL.primary }}
                              onClick={(e) => { e.stopPropagation(); onNavigateToFile(resolvePath(f, projectPath)); }}>
                              {f.split(/[\\/]/).pop()}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#5c6166" strokeWidth="2" className="shrink-0 opacity-40">
                      <path d="M9 18l6-6-6-6" />
                    </svg>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Feature detail (Level 2+) ── */}
      {!isOverview && (
        <>
          {feature.flow_description && (
            <div className="px-3 py-2 text-[11px] leading-relaxed border-b shrink-0" style={{ color: COL.onSurfaceVariant, borderColor: COL.outlineSoft }}>
              {feature.flow_description}
            </div>
          )}
          <div className="flex-1 overflow-y-auto">
            {drillError && (
              <div className="px-3 py-2 text-[11px]" style={{ color: '#f85149', background: '#261212' }}>
                {drillError}
                <button onClick={() => setDrillError(null)} className="ml-2 underline">Dismiss</button>
              </div>
            )}
            {children.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <button onClick={() => handleDrill(feature)} disabled={drilling === feature.id || feature.level >= 3}
                  className="px-6 py-3 rounded-xl text-xs transition-colors hover:bg-white/5 disabled:opacity-30 border"
                  style={{ color: COL.primary, borderColor: COL.outlineSoft }}>
                  {drilling === feature.id ? (
                    <span className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full animate-pulse-dot" style={{ background: COL.primary }} />
                      Analyzing flow steps...
                    </span>
                  ) : 'Analyze flow steps'}
                </button>
              </div>
            ) : (
              children.map((node) => (
                <div key={node.id} className="border-b transition-colors hover:bg-white/[0.02]" style={{ borderColor: COL.outlineSoft }}>
                  <div className="flex items-start px-3 py-2.5">
                    <button
                      onClick={() => node.level < 3 ? handleDrill(node) : null}
                      disabled={drilling === node.id}
                      className="flex-1 text-left disabled:opacity-50">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full shrink-0" style={{ background: LV[node.level] || '#8e918f' }} />
                        <span className="text-xs font-medium" style={{ color: COL.onSurface }}>{node.label}</span>
                        {drilling === node.id && <span className="text-[10px] animate-pulse" style={{ color: COL.yellow }}>...</span>}
                      </div>
                      {(node.description || node.flow_description) && (
                        <div className="text-[10px] mt-1 ml-4" style={{ color: '#5c6166' }}>
                          {(node.description || node.flow_description).slice(0, 100)}
                        </div>
                      )}
                    </button>
                    {onSendToAgent && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onSendToAgent(`当前焦点: ${feature.label} → ${node.label}\n文件: ${(node.files || []).join(', ') || '无'}`);
                        }} className="text-[9px] px-2 py-0.5 rounded-full hover:bg-white/10 ml-2"
                        style={{ border: '1px solid #303234', color: COL.primary }} title="Send to Agent">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
                        </svg>
                      </button>
                    )}
                  </div>
                  {node.functions.length > 0 && (
                    <div className="px-3 pb-2 ml-4 flex flex-col gap-0.5">
                      {node.functions.map((fn) => {
                        const { name, line } = parseFn(fn);
                        return (
                          <button key={fn}
                            onClick={() => { const t = node.files[0]; if (t) onNavigateToFile(resolvePath(t, projectPath), line); }}
                            className="text-left text-[11px] font-mono py-0.5 px-2 rounded transition-colors hover:underline"
                            style={{ color: '#d29922', background: 'transparent' }}>
                            {name}()
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {node.files.length > 0 && (
                    <div className="px-3 pb-2 ml-4 flex flex-wrap gap-1">
                      {node.files.map((f) => (
                        <button key={f} onClick={() => onNavigateToFile(resolvePath(f, projectPath))}
                          className="text-[9px] px-1.5 py-0.5 rounded font-mono hover:underline"
                          style={{ background: '#1a3350', color: COL.primary }}>
                          {f.split(/[\\/]/).pop()}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
