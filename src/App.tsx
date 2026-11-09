import React, { useEffect } from 'react';
import { useStore } from './app/store/store';
import { TopBar } from './app/components/TopBar';
import { SliceView } from './app/views/SliceView';
import { ComposeView } from './app/views/ComposeView';
import { LibraryView } from './app/views/LibraryView';
import { ExportView } from './app/views/ExportView';
import { Recorder } from './app/components/Recorder';
import { ProjectPicker } from './app/components/ProjectPicker';
import { togglePlay, stop } from './app/transport';
import { saveCurrent } from './app/services/projectService';
import { platform } from './app/platform/platform';

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export function App() {
  const view = useStore((s) => s.ui.view);
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  const showRecorder = useStore((s) => s.ui.showRecorder);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveCurrent(e.shiftKey);
        return;
      }
      if (isTyping(e)) return;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        useStore.getState().undo();
      } else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        useStore.getState().redo();
      } else if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'Escape') stop();
    };
    window.addEventListener('keydown', onKey);
    const before = (e: BeforeUnloadEvent) => {
      if (useStore.getState().dirty && platform.kind === 'browser') e.preventDefault();
    };
    window.addEventListener('beforeunload', before);
    window.vcs?.onBeforeClose(async () => {
      const st = useStore.getState();
      if (!st.dirty || window.confirm('Close without saving the current project? Choose Cancel to keep working.')) void window.vcs!.invoke('app:confirm-close');
    });
    (window as any).__vcs = { useStore };
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', before);
    };
  }, []);

  return (
    <div className="app">
      <TopBar />
      {view === 'slice' && <SliceView />}
      {view === 'compose' && <ComposeView />}
      {view === 'library' && <LibraryView />}
      {view === 'export' && <ExportView />}
      {showRecorder && <Recorder />}
      <ProjectPicker />
      <div className="toasts" data-testid="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
