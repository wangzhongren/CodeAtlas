import { useState, useEffect } from 'react';

export default function TitleBar({ projectName }: { projectName: string }) {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    try {
      window.codeatlas?.window?.isMaximized().then(setIsMaximized);
    } catch { /* browser */ }
  }, []);

  const handleMinimize = () => { try { window.codeatlas?.window?.minimize(); } catch { /* */ } };
  const handleMaximize = () => { try { window.codeatlas?.window?.maximize(); setIsMaximized(!isMaximized); } catch { /* */ } };
  const handleClose = () => { try { window.codeatlas?.window?.close(); } catch { /* */ } };

  return (
    <div
      className="flex items-center justify-between h-9 shrink-0 select-none"
      style={{ background: '#16181a', WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Left: app icon + title */}
      <div className="flex items-center gap-2.5 pl-3">
        <div className="w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-bold"
          style={{ background: '#003a75', color: '#8ab4f8' }}>
          ZT
        </div>
        <span className="text-[11px] font-medium" style={{ color: '#c4c7c5' }}>
          CodeAtlas CodeAtlas
        </span>
        {projectName && (
          <>
            <span className="text-[11px]" style={{ color: '#5c6166' }}>—</span>
            <span className="text-[11px]" style={{ color: '#8e918f' }}>{projectName}</span>
          </>
        )}
      </div>

      {/* Right: window controls */}
      <div className="flex" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          onClick={handleMinimize}
          className="w-11 h-9 flex items-center justify-center transition-colors hover:bg-white/[0.06]"
          style={{ color: '#8e918f' }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10"><rect y="4" width="10" height="1.5" fill="currentColor" /></svg>
        </button>
        <button
          onClick={handleMaximize}
          className="w-11 h-9 flex items-center justify-center transition-colors hover:bg-white/[0.06]"
          style={{ color: '#8e918f' }}
        >
          {isMaximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="1.5" y="0" width="8.5" height="8.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <rect x="0" y="1.5" width="8.5" height="8.5" fill="#16181a" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
          )}
        </button>
        <button
          onClick={handleClose}
          className="w-11 h-9 flex items-center justify-center transition-colors hover:bg-[#e81123]"
          style={{ color: '#8e918f' }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1.2" /></svg>
        </button>
      </div>
    </div>
  );
}
