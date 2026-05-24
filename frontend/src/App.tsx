import { useState, useCallback, useEffect, useRef } from 'react';
import type { FeatureNode } from './types/feature';
import WelcomePage from './components/WelcomePage';
import FileExplorer from './components/FileExplorer';
import CodeViewer from './components/CodeViewer';
import type { CodeSelection } from './components/CodeViewer';
import FeatureList from './components/FeatureList';
import FeatureDetail from './components/FeatureDetail';
import AgentPanel from './components/AgentPanel';
import RunPage from './components/RunPage';
import ResizeHandle from './components/ResizeHandle';
import StatusBar from './components/StatusBar';
import TitleBar from './components/TitleBar';

const MIN_SIDEBAR = 180;
const MIN_RIGHT = 280;
const MIN_AGENT = 160;
const INITIAL_LEFT = 260;
const INITIAL_RIGHT = 380;
const INITIAL_BOTTOM = 280;

export default function App() {
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [scrollToLine, setScrollToLine] = useState<number | null>(null);
  const [selection, setSelection] = useState<CodeSelection | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedFeature, setSelectedFeature] = useState<FeatureNode | null>(null);
  const [agentContext, setAgentContext] = useState('');
  const [fileVersion, setFileVersion] = useState(0);
  const handleRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  const handleFileChanged = useCallback(() => {
    setFileVersion((v) => v + 1);
    setRefreshKey((k) => k + 1);
  }, []);
  const triggerFeatureReload = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const [leftW, setLeftW] = useState(INITIAL_LEFT);
  const [rightW, setRightW] = useState(INITIAL_RIGHT);
  const [bottomH, setBottomH] = useState(INITIAL_BOTTOM);
  const [showRunPage, setShowRunPage] = useState(false);

  const handleOpenProject = useCallback((p: string) => {
    setProjectPath(p);
    setOpenFile(null);
    setSelection(null);
    setSelectedFeature(null);
  }, []);

  useEffect(() => {
    try { window.codeatlas?.file.onProjectOpened((p: string) => handleOpenProject(p)); } catch { /* */ }
  }, [handleOpenProject]);

  useEffect(() => {
    try {
      window.codeatlas?.file.getProjectPath().then((p: string) => { if (p) setProjectPath(p); });
    } catch { /* */ }
  }, []);

  const handleCloseProject = useCallback(() => { setProjectPath(null); setOpenFile(null); }, []);
  const selectedFeatureRef = useRef(selectedFeature);
  selectedFeatureRef.current = selectedFeature;

  const handleFeaturesLoaded = useCallback(async (list: FeatureNode[]) => {
    const current = selectedFeatureRef.current;
    if (!current) return;
    const find = (nodes: FeatureNode[], id: string): FeatureNode | null => {
      for (const n of nodes) {
        if (n.id === id) return n;
        const found = find(n.children || [], id);
        if (found) return found;
      }
      return null;
    };
    const updated = find(list, current.id);
    if (updated) {
      setSelectedFeature(updated);
      if (!updated.generated && updated.level < 3) {
        try {
          const drillRes = await fetch('/api/v1/features/analyze', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_path: projectPath, node_id: updated.id, parent_context: updated.flow_description || updated.description }),
          });
          const drillData = await drillRes.json();
          if (drillData.nodes?.length > 0) {
            setSelectedFeature({ ...updated, children: drillData.nodes, generated: true });
          }
        } catch { /* ignore */ }
      }
    }
  }, [projectPath]);

  const navigateToFile = (filePath: string, line?: number) => {
    const isAbs = /^[a-zA-Z]:[\\/]/.test(filePath || '');
    const resolved = isAbs ? filePath : `${projectPath?.replace(/\\/g, '/')}/${filePath}`;
    setOpenFile(resolved);
    setScrollToLine(line || null);
  };

  const handleSelectFeature = (node: FeatureNode | null) => {
    setSelectedFeature(node);
  };

  const handleDrillDown = (node: FeatureNode) => {
    setSelectedFeature(node);
  };

  if (!projectPath) {
    return <WelcomePage onOpenProject={handleOpenProject} />;
  }

  return (
    <div className="w-screen h-screen flex flex-col" style={{ background: '#1a1c1e' }}>
      {/* Title bar */}
      <TitleBar projectName={projectPath ? (projectPath.split(/[\\/]/).pop() || '') : ''} />
      <div className="flex items-center justify-between px-4 py-0.5 border-b shrink-0" style={{ borderColor: '#303234', background: '#1a1c1e' }}>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-[10px]" style={{ color: '#5c6166' }}>{projectPath}</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowRunPage(true)}
            title="AI auto-run: analyze, build, run & fix"
            className="flex items-center gap-1.5 text-[10px] px-3 py-1 rounded-md font-medium transition-all hover:opacity-80 active:scale-[0.97]"
            style={{ background: '#1a3350', color: '#8ab4f8', border: '1px solid #8ab4f830' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="#8ab4f8" stroke="none">
              <polygon points="5,3 19,12 5,21" />
            </svg>
            Run
          </button>
          <StatusBar />
          <button onClick={handleCloseProject} className="text-[10px] px-2 py-0.5 rounded-md hover:bg-white/5 transition-colors" style={{ color: '#8e918f' }}>Close Project</button>
        </div>
      </div>

      {/* Main row: left+center | right-agent (full height) */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left + Center + Bottom Features (flex column) */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Top: Explorer + Code Viewer */}
          <div className="flex-1 flex overflow-hidden">
            <div className="shrink-0 border-r overflow-hidden" style={{ width: leftW, borderColor: '#444746' }}>
              <FileExplorer key={refreshKey} projectPath={projectPath} onSelectFile={setOpenFile} onRefresh={handleRefresh} />
            </div>

            <ResizeHandle direction="vertical" onResize={(d) => setLeftW((w) => Math.max(MIN_SIDEBAR, w + d))} />

            <div className="flex-1 flex overflow-hidden">
              <CodeViewer key={fileVersion} filePath={openFile} projectPath={projectPath} scrollToLine={scrollToLine} onSelectionChange={setSelection} />
            </div>
          </div>

          <ResizeHandle direction="horizontal" onResize={(d) => setBottomH((h) => Math.max(MIN_AGENT, h - d))} />

          {/* Bottom: Features + FeatureDetail */}
          <div className="shrink-0 flex overflow-hidden" style={{ height: bottomH, borderTop: '1px solid #252729' }}>
            <div className="shrink-0 border-r overflow-hidden" style={{ width: leftW, borderColor: '#303234' }}>
              <FeatureList
                projectPath={projectPath}
                onSelectFeature={handleSelectFeature}
                selectedId={selectedFeature?.id || null}
                onFeaturesLoaded={handleFeaturesLoaded}
              />
            </div>
            <div className="flex-1 overflow-hidden">
              <FeatureDetail
                feature={selectedFeature}
                projectPath={projectPath}
                onNavigateToFile={navigateToFile}
                onDrillDown={handleDrillDown}
                onSendToAgent={setAgentContext}
                onReloadFeatures={triggerFeatureReload}
              />
            </div>
          </div>
        </div>

        {/* Right: Agent Chat — full height */}
        <ResizeHandle direction="vertical" onResize={(d) => setRightW((w) => Math.max(MIN_RIGHT, w - d))} />
        <div className="shrink-0 border-l flex flex-col" style={{ width: rightW, borderColor: '#444746' }}>
          <AgentPanel projectPath={projectPath} openFilePath={openFile} selection={selection} onClearSelection={() => setSelection(null)} injectContext={agentContext} onConsumeContext={() => setAgentContext('')} onFileChanged={handleFileChanged} />
        </div>
      </div>

      {/* Run Page overlay */}
      {showRunPage && projectPath && (
        <RunPage
          projectPath={projectPath}
          onClose={() => setShowRunPage(false)}
          onFileChanged={handleFileChanged}
        />
      )}
    </div>
  );
}
