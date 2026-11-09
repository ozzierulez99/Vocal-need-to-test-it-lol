import React, { useEffect, useState } from 'react';
import { useStore } from './app/store/store';
import { TopBar } from './app/components/TopBar';
import { SliceView } from './app/views/SliceView';
import { ComposeView } from './app/views/ComposeView';
import { LibraryView } from './app/views/LibraryView';
import { ExportView } from './app/views/ExportView';
import { BeatView } from './app/views/BeatView';
import { loadBeatBytes } from './app/services/beatService';
import { importAudioFiles } from './app/services/projectService';
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
  const [dragging, setDragging] = useState(false);

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
    // drag & drop anywhere: MIDI → beat context, audio → vocal sources
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onEnter = (e: DragEvent) => { if (hasFiles(e)) { depth++; setDragging(true); } };
    const onLeave = () => { depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const onOver = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const onDrop = async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      const midis = files.filter((f) => /\.midi?$/i.test(f.name));
      const audio = files.filter((f) => !/\.midi?$/i.test(f.name) && !/\.vcsz$/i.test(f.name));
      if (audio.length) await importAudioFiles(await Promise.all(audio.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
      if (midis.length) {
        const f = midis[0];
        if (loadBeatBytes(new Uint8Array(await f.arrayBuffer()), f.name)) useStore.getState().setUI({ view: 'beat' });
      } else if (audio.length) useStore.getState().setUI({ view: 'slice' });
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', before);
    };
  }, []);

  return (
    <div className="app">
      <TopBar />
      {view === 'slice' && <SliceView />}
      {view === 'beat' && <BeatView />}
      {view === 'compose' && <ComposeView />}
      {view === 'library' && <LibraryView />}
      {view === 'export' && <ExportView />}
      {showRecorder && <Recorder />}
      <ProjectPicker />
      {dragging && (
        <div className="drop-overlay" data-testid="drop-overlay">
          <div>Drop a beat MIDI (chords / arp) or vocal audio</div>
        </div>
      )}
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
