import { create } from 'zustand';
import type { TopologyNode, TopologyEdge } from '../types/topology';

interface TopologyState {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  applyTopologyCommands: (commands: Array<Record<string, any>>) => void;
  clearAll: () => void;
}

export const useTopologyStore = create<TopologyState>((set) => ({
  nodes: [],
  edges: [],

  applyTopologyCommands: (commands) =>
    set((state) => {
      let currentNodes = [...state.nodes];
      let currentEdges = [...state.edges];

      for (const cmd of commands) {
        switch (cmd.action) {
          case 'upsert_node': {
            if (!cmd.node) break;
            const idx = currentNodes.findIndex((n) => n.id === cmd.node.id);
            if (idx > -1) {
              currentNodes[idx] = cmd.node as TopologyNode;
            } else {
              currentNodes.push(cmd.node as TopologyNode);
            }
            break;
          }

          case 'delete_node': {
            if (!cmd.node) break;
            const nodeId = cmd.node.id;
            currentNodes = currentNodes.filter((n) => n.id !== nodeId);
            currentEdges = currentEdges.filter(
              (e) => e.source !== nodeId && e.target !== nodeId
            );
            break;
          }

          case 'add_edge': {
            if (!cmd.edge) break;
            const already = currentEdges.find(
              (e) => e.source === cmd.edge.source && e.target === cmd.edge.target
            );
            if (!already) {
              currentEdges.push(cmd.edge as TopologyEdge);
            }
            break;
          }

          case 'delete_edge': {
            if (!cmd.edge) break;
            currentEdges = currentEdges.filter(
              (e) =>
                !(e.source === cmd.edge.source && e.target === cmd.edge.target)
            );
            break;
          }
        }
      }

      return { nodes: currentNodes, edges: currentEdges };
    }),

  clearAll: () => set({ nodes: [], edges: [] }),
}));
