import { useTaskStore } from '../store/taskStore';
import type { BackgroundTask } from '../store/taskStore';

function TaskItem({ task }: { task: BackgroundTask }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-[10px]">
      <span className="w-1.5 h-1.5 rounded-full animate-pulse-dot shrink-0"
        style={{ background: task.status === 'error' ? '#f85149' : '#d29922' }} />
      <span className="truncate flex-1" style={{ color: '#c9d1d9' }}>{task.label}</span>
      <span className="text-[9px] shrink-0" style={{ color: '#5c6166' }}>{task.detail}</span>
    </div>
  );
}

export default function StatusBar() {
  const { tasks, visible, toggleVisible, setVisible } = useTaskStore();
  const running = tasks.filter((t) => t.status === 'running');

  return (
    <div className="relative shrink-0">
      <button
        onClick={toggleVisible}
        className="flex items-center gap-1.5 px-2 py-0.5 text-[10px] rounded transition-colors hover:bg-white/5"
        style={{ color: running.length > 0 ? '#d29922' : '#484f58' }}>
        {running.length > 0 ? (
          <>
            <span className="w-1.5 h-1.5 rounded-full animate-pulse-dot" style={{ background: '#d29922' }} />
            <span>{running.length}</span>
          </>
        ) : (
          <span style={{ color: '#484f58' }}>0</span>
        )}
      </button>

      {visible && (
        <div
          className="absolute right-0 top-full mt-1 w-64 rounded-lg border card-elevation z-50"
          style={{ background: '#161b22', borderColor: '#21262d' }}>
          <div className="px-3 py-1.5 border-b text-[10px] font-medium flex items-center justify-between"
            style={{ borderColor: '#21262d', color: '#8b949e' }}>
            <span>{running.length > 0 ? `Running (${running.length})` : 'No running tasks'}</span>
            <button onClick={() => setVisible(false)} style={{ color: '#484f58' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          {running.length === 0 ? (
            <div className="px-3 py-3 text-[10px] text-center" style={{ color: '#5c6166' }}>
              All tasks completed
            </div>
          ) : (
            running.map((t) => <TaskItem key={t.id} task={t} />)
          )}
        </div>
      )}
    </div>
  );
}
