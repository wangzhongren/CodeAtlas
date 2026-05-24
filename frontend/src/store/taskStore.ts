import { create } from 'zustand';

export interface BackgroundTask {
  id: string;
  type: 'shell' | 'analyze' | 'summarize';
  label: string;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  detail: string;
  exitCode?: number | null;
}

interface TaskState {
  tasks: BackgroundTask[];
  addTask: (task: BackgroundTask) => void;
  updateTask: (id: string, update: Partial<BackgroundTask>) => void;
  removeTask: (id: string) => void;
  visible: boolean;
  toggleVisible: () => void;
  setVisible: (v: boolean) => void;
}

export const useTaskStore = create<TaskState>((set) => ({
  tasks: [],
  visible: false,

  addTask: (task) =>
    set((s) => ({ tasks: [...s.tasks.filter((t) => t.id !== task.id), task] })),

  updateTask: (id, update) =>
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...update } : t)),
    })),

  removeTask: (id) =>
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),

  toggleVisible: () => set((s) => ({ visible: !s.visible })),
  setVisible: (v) => set({ visible: v }),
}));
