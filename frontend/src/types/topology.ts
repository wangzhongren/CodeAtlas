export interface TopologyNode {
  id: string;
  label: string;
  type: 'module' | 'class' | 'function';
  layer: number;
  file?: string; // source file path, used for navigation
}

export interface TopologyEdge {
  source: string;
  target: string;
  type: 'call' | 'inherit' | 'depend';
}

export interface TopologyCommand {
  action: 'upsert_node' | 'delete_node' | 'add_edge' | 'delete_edge';
  node?: TopologyNode | { id: string };
  edge?: TopologyEdge | { source: string; target: string };
}
