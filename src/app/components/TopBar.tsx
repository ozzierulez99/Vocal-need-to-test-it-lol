import React, { useEffect, useRef, useState } from 'react';
import { useStore, actions } from '../store/store';
import { play, stop, audition } from '../transport';
import { formatBarBeat, ticksPerBar } from '../../core/time';
import { NumberField, Select } from './ui';
import { newProject, openProject, saveCurrent, exportBundle, importBundleBytes, loadExample, addDemoVoice } from '../services/projectService';
import { EXAMPLES } from '../../core/demo/examples';
import { DEMO_VOICES } from '../../core/demo/synthVoice';
import { platform, type Recent } from '../platform/platform';
import type { View } from '../store/store';
import { Help } from './Help';

const VIEWS: { id: View; label: string; key: string }[] = [
  { id: 'slice', label: 'Sources & Slices', key: '1' },
  { id: 'compose', label: 'Compose & Explore', key: '2' },
  { id: 'library', label: 'Library', key: '3' },
  { id: 'export', label: 'Export', key: '4' },
];

function Position() {
  const tick = useStore((s) => s.positionTick);
  const sig = useStore((s) => s.doc.sequence.timeSig);
  return <span className="pos" data-testid="position">{formatBarBeat(Math.max(0, tick), sig)}</span>;
}

function ProjectMenu() {
  const [open, setOpen] = useState<null | 'main' | 'examples' | 'recent' | 'demo'>(null);
  const [recent, setRecent] = useState<Recent[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, []);
  const [diskExamples, setDiskExamples] = useState<Recent[]>([]);
  useEffect(() => {
    if (open === 'recent') void platform.recent().then(setRecent);
    if (open === 'examples') void platform.examples().then(setDiskExamples);
  }, [open]);
  const guardDirty = () => !useStore.getState().dirty || window.confirm('Discard unsaved changes to the current project?');
  const item = (label: string, fn: () => void, kbd?: string, testid?: string) => (
    <button data-testid={testid} onClick={() => { setOpen(null); fn(); }}>
      <span>{label}</span>
      {kbd && <kbd>{kbd}</kbd>}
    </button>
  );
  const importBundle = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.vcsz';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (f) await importBundleBytes(new Uint8Array(await f.arrayBuffer()));
    };
    input.click();
  };
  return (
    <div className="menu" ref={ref}>
      <button className="btn" data-testid="project-menu" onClick={() => setOpen(open ? null : 'main')}>Project ▾</button>
      {open === 'main' && (
        <div className="menu-pop">
          {item('New project', () => guardDirty() && newProject(), undefined, 'menu-new')}
          {item('Open…', () => guardDirty() && openProject(), undefined, 'menu-open')}
          <button onClick={() => setOpen('recent')}><span>Open recent</span><kbd>▸</kbd></button>
          <hr />
          {item('Save', () => saveCurrent(), 'Ctrl+S', 'menu-save')}
          {item('Save as…', () => saveCurrent(true), 'Ctrl+Shift+S')}
          <hr />
          {item('Export portable bundle (.vcsz)', () => exportBundle(), undefined, 'menu-bundle')}
          {item('Import bundle (.vcsz)…', () => guardDirty() && importBundle())}
          <hr />
          <button data-testid="menu-examples" onClick={() => setOpen('examples')}><span>Example projects</span><kbd>▸</kbd></button>
          <button data-testid="menu-demo" onClick={() => setOpen('demo')}><span>Add demo vocal</span><kbd>▸</kbd></button>
        </div>
      )}
      {open === 'examples' && (
        <div className="menu-pop">
          <div className="label">Workflow examples (synthetic vocals)</div>
          {Object.entries(EXAMPLES).map(([k, e]) => item(e.title, () => guardDirty() && loadExample(k), undefined, `example-${k}`))}
          {diskExamples.length > 0 && (
            <>
              <hr />
              <div className="label">Example project folders on disk</div>
              {diskExamples.map((r) => item(r.name, () => guardDirty() && openProject(r.location)))}
            </>
          )}
        </div>
      )}
      {open === 'demo' && (
        <div className="menu-pop">
          <div className="label">Synthetic vocal-like recordings</div>
          {Object.entries(DEMO_VOICES).map(([k, v]) => item(v.title, () => addDemoVoice(k), undefined, `demo-${k}`))}
        </div>
      )}
      {open === 'recent' && (
        <div className="menu-pop">
          <div className="label">Recent projects</div>
          {!recent.length && <div className="dim" style={{ padding: 10 }}>Nothing yet</div>}
          {recent.map((r) => item(r.name, () => guardDirty() && openProject(r.location), undefined))}
        </div>
      )}
    </div>
  );
}

export function TopBar() {
  const view = useStore((s) => s.ui.view);
  const setUI = useStore((s) => s.setUI);
  const name = useStore((s) => s.doc.name);
  const dirty = useStore((s) => s.dirty);
  const playing = useStore((s) => s.playing);
  const seq = useStore((s) => s.doc.sequence);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const auditioning = useStore((s) => s.ui.auditioning);
  const candLabel = useStore((s) => s.doc.candidates.find((c) => c.id === s.ui.auditioning)?.label);
  const commit = useStore((s) => s.commit);
  const [help, setHelp] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
      if (e.altKey && VIEWS.some((v) => v.key === e.key)) setUI({ view: VIEWS.find((v) => v.key === e.key)!.id });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setUI]);
  const bar = ticksPerBar(seq.timeSig);
  return (
    <div className="topbar">
      <div className="brand">
        <div className="logo" />
        <span className="brand-text">Vocal Chop Studio</span>
      </div>
      <ProjectMenu />
      <div className="project-name">
        <input data-testid="project-name" value={name} onChange={(e) => commit('Rename project', (d) => void (d.name = e.target.value))} onKeyDown={(e) => !e.ctrlKey && !e.metaKey && e.stopPropagation()} />
        {dirty && <span className="dirty-dot" title="Unsaved changes" />}
      </div>
      <nav className="nav">
        {VIEWS.map((v) => (
          <button key={v.id} data-testid={`nav-${v.id}`} className={view === v.id ? 'on' : ''} onClick={() => setUI({ view: v.id })} title={`Alt+${v.key}`}>
            {v.label}
          </button>
        ))}
      </nav>
      <div className="spacer" />
      <button className="btn ghost" data-testid="help-btn" onClick={() => setHelp(true)} title="Shortcuts & gestures">?</button>
      {help && <Help onClose={() => setHelp(false)} />}
      <button className="btn ghost" data-testid="undo" disabled={!canUndo} onClick={() => useStore.getState().undo()} title="Undo (Ctrl+Z)">↶</button>
      <button className="btn ghost" data-testid="redo" disabled={!canRedo} onClick={() => useStore.getState().redo()} title="Redo (Ctrl+Shift+Z)">↷</button>
      <div className="transport">
        {auditioning && (
          <span className="auditioning-chip" data-testid="auditioning" title="Click to return to the arrangement" onClick={() => audition(null)}>
            ▶ {candLabel ?? 'candidate'} ✕
          </span>
        )}
        <button className={`play-btn ${playing ? 'playing' : ''}`} data-testid="play" onClick={() => (playing ? stop() : play())} title="Play / stop (Space)">
          {playing ? '■' : '▶'}
        </button>
        <button className="btn ghost small" data-testid="rewind" onClick={() => { stop(true); }} title="Stop and return to start (Esc)">⏮</button>
        <Position />
        <button className={`btn small ${seq.loop.enabled ? 'active' : ''}`} data-testid="loop" onClick={() => actions.updateSeq({ loop: { ...seq.loop, enabled: !seq.loop.enabled } }, 'Toggle loop')} title="Loop">⟳ Loop</button>
        <NumberField testid="bpm" value={seq.bpm} min={40} max={260} step={1} width={60} suffix="bpm" onChange={(v) => actions.updateSeq({ bpm: v }, 'Change tempo')} />
        <Select testid="timesig" value={`${seq.timeSig[0]}/${seq.timeSig[1]}`} options={['4/4', '3/4', '6/8', '5/4', '7/8'].map((v) => ({ value: v, label: v }))} onChange={(v) => {
          const [a, b] = v.split('/').map(Number) as [number, number];
          const nb = (a * 3840) / 4 * (4 / b);
          actions.updateSeq({ timeSig: [a, b], loop: { ...seq.loop, startTick: 0, endTick: seq.bars * nb } }, 'Change time signature');
        }} />
        <NumberField testid="bars" value={seq.bars} min={1} max={64} width={52} suffix="bars" onChange={(v) => {
          const full = seq.loop.endTick >= seq.bars * bar;
          actions.updateSeq({ bars: v, loop: { ...seq.loop, endTick: full ? v * bar : Math.min(seq.loop.endTick, v * bar) } }, 'Change length');
        }} />
      </div>
    </div>
  );
}
