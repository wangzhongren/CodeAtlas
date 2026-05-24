import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { useTopologyStore } from '../store/topologyStore';
import type { TopologyNode, TopologyCommand } from '../types/topology';

const COL = {
  bg: '#1a1c1e',
  surface: '#282a2d',
  onSurface: '#e3e2e6',
  onSurfaceVariant: '#c4c7c5',
  outline: '#444746',
  outlineSoft: '#303234',
  primary: '#8ab4f8',
};

const NODE_COLORS: Record<string, { fill: string; stroke: string; text: string; dot: string }> = {
  module:  { fill: '#1e2535', stroke: '#8ab4f8', text: '#d6e3ff', dot: '#8ab4f8' },
  class:   { fill: '#1b2a1e', stroke: '#b4d7a8', text: '#cce8c7', dot: '#b4d7a8' },
  function:{ fill: '#262016', stroke: '#fdd663', text: '#fce8b2', dot: '#fdd663' },
};

const EDGE_COLORS: Record<string, string> = {
  call: '#fdd663',
  inherit: '#b4d7a8',
  depend: '#8ab4f8',
};

/* ── Simple layered graph layout ── */
function graphLayout(nodes: TopologyNode[]): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  // Group nodes by type into layers
  const groups: Record<string, TopologyNode[]> = { module: [], class: [], function: [] };
  for (const n of nodes) {
    (groups[n.type] ??= []).push(n);
  }

  const layerOrder = ['module', 'class', 'function'];
  const cols = layerOrder.filter((t) => groups[t].length > 0);
  const colW = cols.length > 0 ? 800 / cols.length : 400;

  cols.forEach((type, colIdx) => {
    const list = groups[type];
    const cx = colIdx * colW + colW / 2 + 60;
    list.forEach((node, i) => {
      pos.set(node.id, { x: cx, y: 60 + i * 64 + 32 });
    });
  });

  return pos;
}

function edgePath(src: { x: number; y: number }, tgt: { x: number; y: number }): string {
  const dx = (tgt.x - src.x) * 0.5;
  return `M ${src.x} ${src.y} C ${src.x + dx} ${src.y}, ${tgt.x - dx} ${tgt.y}, ${tgt.x} ${tgt.y}`;
}

/* ── Node popup ── */
function NodePopup({ node, onClose, onGotoFile }: {
  node: TopologyNode; onClose: () => void; onGotoFile: (node: TopologyNode) => void;
}) {
  return (
    <div className="card-elevation rounded-2xl p-4 w-64 animate-fade-in"
      style={{ background: COL.surface, border: `1px solid ${COL.outlineSoft}` }}>
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full" style={{ background: NODE_COLORS[node.type]?.dot || '#8e918f' }} />
          <span className="text-xs font-medium" style={{ color: COL.onSurface }}>{node.label}</span>
        </div>
        <button onClick={onClose} style={{ color: COL.onSurfaceVariant }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="text-[10px] font-mono mb-3 px-2 py-1 rounded-lg break-all"
        style={{ background: '#0d1117', color: '#8e918f' }}>
        {node.id}
      </div>
      <div className="flex gap-2 text-[10px]">
        <span className="px-2 py-0.5 rounded-full" style={{ background: COL.outlineSoft, color: COL.onSurfaceVariant, textTransform: 'capitalize' }}>
          {node.type}
        </span>
        <button onClick={() => onGotoFile(node)}
          className="px-2 py-0.5 rounded-full transition-colors hover:bg-white/10"
          style={{ background: '#003a75', color: COL.primary }}>
          Open file
        </button>
      </div>
    </div>
  );
}

/* ── Main Component ── */
export default function TopologyCanvas({ onNavigateToFile }: { onNavigateToFile?: (path: string) => void }) {
  const { nodes, edges, applyTopologyCommands, clearAll } = useTopologyStore();
  const [connected, setConnected] = useState(false);
  const [selectedNode, setSelectedNode] = useState<TopologyNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const positions = useMemo(() => graphLayout(nodes), [nodes]);
  const totalH = useMemo(() => Math.max(600, 100 + nodes.length * 64), [nodes]);

  const connectSSE = useCallback(() => {
    esRef.current?.close();
    const es = new EventSource('/api/v1/topology/stream');
    esRef.current = es;
    es.addEventListener('topology_update', (e: MessageEvent) => {
      try { applyTopologyCommands(JSON.parse(e.data) as TopologyCommand[]); } catch { /* ignore */ }
    });
    es.addEventListener('ping', () => {});
    es.onopen = () => setConnected(true);
    es.onerror = () => {
      setConnected(false);
      es.close();
      esRef.current = null;
      retryRef.current = setTimeout(connectSSE, 2500);
    };
  }, [applyTopologyCommands]);

  useEffect(() => {
    connectSSE();
    return () => {
      esRef.current?.close();
      if (retryRef.current) clearTimeout(retryRef.current);
    };
  }, [connectSSE]);

  const handleNodeClick = (node: TopologyNode) => {
    setSelectedNode(selectedNode?.id === node.id ? null : node);
  };

  const handleGotoFile = (node: TopologyNode) => {
    // Use file field if present, otherwise try to extract from id
    const filePath = node.file || node.id;
    onNavigateToFile?.(filePath);
  };

  const handleClear = () => {
    clearAll();
    setSelectedNode(null);
  };

  return (
    <div className="flex flex-col h-full" style={{ background: COL.surface }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b shrink-0" style={{ borderColor: COL.outline }}>
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${connected ? 'animate-pulse-dot' : ''}`}
            style={{ background: connected ? '#34a853' : '#8e918f' }} />
          <span className="text-xs font-medium uppercase tracking-wide" style={{ color: COL.onSurfaceVariant }}>Graph</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px]" style={{ color: '#5c6166' }}>{nodes.length} nodes · {edges.length} edges</span>
          <button onClick={handleClear} className="text-[10px] px-2 py-0.5 rounded-full border transition-colors hover:bg-white/5"
            style={{ borderColor: COL.outline, color: COL.onSurfaceVariant }}>Clear</button>
        </div>
      </div>

      {/* SVG */}
      <div className="flex-1 overflow-auto relative">
        <svg width="100%" height="100%" viewBox={`0 0 1000 ${totalH}`}
          style={{ minWidth: 960, minHeight: totalH }}>

          <defs>
            {['call', 'inherit', 'depend'].map((t) => (
              <marker key={t} id={`gh-${t}`} viewBox="0 0 10 10" refX="9" refY="5"
                markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                <path d="M0 0l10 5-10 5z" fill={EDGE_COLORS[t]} />
              </marker>
            ))}
            <filter id="gh-glow">
              <feGaussianBlur stdDeviation="2.5" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>

          {/* Edges */}
          <g>
            {edges.map((edge, i) => {
              const src = positions.get(edge.source);
              const tgt = positions.get(edge.target);
              if (!src || !tgt) return null;
              const active = hoveredNode === edge.source || hoveredNode === edge.target;
              const color = EDGE_COLORS[edge.type] || COL.outline;
              return (
                <g key={`e-${i}`}>
                  <path d={edgePath(src, tgt)} fill="none" stroke={color}
                    strokeWidth={active ? 3 : 1.5} strokeDasharray={edge.type === 'call' ? '6 4' : undefined}
                    opacity={active ? 0.9 : 0.35} markerEnd={`url(#gh-${edge.type})`}
                    style={{ transition: 'opacity 0.2s, stroke-width 0.2s' }} />
                </g>
              );
            })}
          </g>

          {/* Nodes */}
          {nodes.map((node) => {
            const pos = positions.get(node.id);
            if (!pos) return null;
            const c = NODE_COLORS[node.type] || NODE_COLORS.function;
            const isSelected = selectedNode?.id === node.id;
            const isHovered = hoveredNode === node.id;
            const NODE_W = isSelected ? 200 : 160;
            const NODE_H = 46;
            const x = pos.x - NODE_W / 2;
            const y = pos.y - NODE_H / 2;

            return (
              <g key={node.id} className="node-enter cursor-pointer"
                onClick={() => handleNodeClick(node)}
                onMouseEnter={() => setHoveredNode(node.id)}
                onMouseLeave={() => setHoveredNode(null)}
                style={{ transition: 'transform 0.2s' }}>
                {/* Shadow */}
                <rect x={x + 2} y={y + 2} width={NODE_W} height={NODE_H} rx={12}
                  fill="#000" opacity={isSelected ? 0.3 : 0.15} />
                {/* Card */}
                <rect x={x} y={y} width={NODE_W} height={NODE_H} rx={12}
                  fill={isSelected ? c.fill : COL.surface}
                  fillOpacity={isSelected ? 1 : 0.9}
                  stroke={isHovered || isSelected ? c.dot : c.stroke}
                  strokeWidth={isHovered || isSelected ? 2 : 1}
                  strokeOpacity={isSelected ? 1 : 0.4}
                  style={{ transition: 'all 0.2s' }}
                  filter={isHovered ? 'url(#gh-glow)' : undefined} />
                {/* Accent dot */}
                <circle cx={x + 16} cy={y + NODE_H / 2} r={6} fill={c.dot} fillOpacity={0.3} />
                <circle cx={x + 16} cy={y + NODE_H / 2} r={3} fill={c.dot} />
                {/* Label */}
                <text x={x + 30} y={y + NODE_H / 2 + 1} dominantBaseline="middle"
                  fill={c.text} fontSize={13} fontWeight={isSelected ? 600 : 500}
                  fontFamily="'JetBrains Mono','Google Sans',monospace">
                  {node.label.length > (isSelected ? 22 : 16) ? node.label.slice(0, (isSelected ? 22 : 16) - 1) + '…' : node.label}
                </text>
              </g>
            );
          })}

          {/* Empty state */}
          {nodes.length === 0 && (
            <g>
              <text x={500} y={totalH / 2 - 20} textAnchor="middle" fill={COL.onSurfaceVariant} fontSize={13} fontWeight={500}>
                No topology data yet
              </text>
              <text x={500} y={totalH / 2 + 10} textAnchor="middle" fill="#5c6166" fontSize={11}>
                Use the Agent to modify code, the graph will build automatically
              </text>
            </g>
          )}
        </svg>

        {/* Node detail popup */}
        {selectedNode && positions.has(selectedNode.id) && (() => {
          const pos = positions.get(selectedNode.id)!;
          const popX = Math.min(pos.x + 120, 760);
          const popY = Math.max(pos.y - 60, 10);
          return (
            <div className="absolute z-20" style={{ left: popX, top: popY }}>
              <NodePopup node={selectedNode} onClose={() => setSelectedNode(null)} onGotoFile={handleGotoFile} />
            </div>
          );
        })()}
      </div>
    </div>
  );
}
