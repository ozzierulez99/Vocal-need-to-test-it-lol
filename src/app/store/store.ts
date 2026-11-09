import { create } from 'zustand';
import { produce, type Draft } from 'immer';
import type {
  AudioData,
  Candidate,
  GeneratorSettings,
  ProjectDoc,
  Role,
  SeqEvent,
  Sequence,
  Slice,
  SourceAudio,
  Track,
  ExportSettings,
} from '../../core/types';
import { newProjectDoc } from '../../core/project/project';
import { reorder, analyseSlice, globalRmsPeak, suggestCategory } from '../../core/slicing/slices';
import { ROLE_COLORS } from '../../core/compose/engine';
import { uid } from '../../core/ids';
import { buildPeaks, type PeakPyramid } from '../../core/audio/peaks';

export type View = 'slice' | 'compose' | 'library' | 'export';

export interface Toast {
  id: string;
  kind: 'info' | 'error' | 'success';
  text: string;
}

export interface UIState {
  view: View;
  sourceId: string | null;
  sliceIds: string[];
  eventIds: string[];
  trackId: string | null;
  /** inclusive start bar, exclusive end bar */
  bars: [number, number] | null;
  candidateA: string | null;
  candidateB: string | null;
  /** Which candidate (if any) the transport is auditioning. */
  auditioning: string | null;
  showRecorder: boolean;
  pxPerBeat: number;
}

interface Runtime {
  audio: Map<string, AudioData>;
  assets: Map<string, Uint8Array>;
  peaks: Map<string, PeakPyramid>;
}

export interface AppState {
  doc: ProjectDoc;
  past: ProjectDoc[];
  future: ProjectDoc[];
  dirty: boolean;
  location: string | null;
  rt: Runtime;
  /** bump to force re-render when runtime maps change */
  rtVersion: number;
  ui: UIState;
  toasts: Toast[];
  playing: boolean;
  positionTick: number;

  commit: (label: string, recipe: (d: Draft<ProjectDoc>) => void) => void;
  beginGesture: () => void;
  gesture: (recipe: (d: Draft<ProjectDoc>) => void) => void;
  endGesture: (label: string) => void;
  /** Non-undoable edits (generator/export preferences, candidate list). */
  setPrefs: (recipe: (d: Draft<ProjectDoc>) => void) => void;
  undo: () => void;
  redo: () => void;
  setUI: (patch: Partial<UIState>) => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  dismissToast: (id: string) => void;
  loadDoc: (doc: ProjectDoc, audio: Map<string, AudioData>, assets: Map<string, Uint8Array>, location: string | null) => void;
  markSaved: (location: string) => void;
  addSource: (src: SourceAudio, audio: AudioData, bytes: Uint8Array) => void;
  relinkSource: (id: string, audio: AudioData, bytes: Uint8Array, assetName: string) => void;
  setPlayback: (playing: boolean, tick?: number) => void;
}

const HISTORY_LIMIT = 150;
let gestureSnapshot: ProjectDoc | null = null;

/** Edits that are deliberately excluded from undo history are carried across undo/redo. */
function carryPrefs(target: ProjectDoc, current: ProjectDoc): ProjectDoc {
  return {
    ...target,
    candidates: current.candidates,
    exportSettings: current.exportSettings,
    sequence: { ...target.sequence, settings: current.sequence.settings },
  };
}

export const useStore = create<AppState>((set, get) => ({
  doc: newProjectDoc(),
  past: [],
  future: [],
  dirty: false,
  location: null,
  rt: { audio: new Map(), assets: new Map(), peaks: new Map() },
  rtVersion: 0,
  ui: {
    view: 'slice',
    sourceId: null,
    sliceIds: [],
    eventIds: [],
    trackId: null,
    bars: null,
    candidateA: null,
    candidateB: null,
    auditioning: null,
    showRecorder: false,
    pxPerBeat: 26,
  },
  toasts: [],
  playing: false,
  positionTick: 0,

  commit: (_label, recipe) => {
    const { doc, past } = get();
    const next = produce(doc, recipe);
    if (next === doc) return;
    set({ doc: next, past: [...past.slice(-HISTORY_LIMIT), doc], future: [], dirty: true });
  },
  beginGesture: () => {
    gestureSnapshot = get().doc;
  },
  gesture: (recipe) => {
    set({ doc: produce(get().doc, recipe), dirty: true });
  },
  endGesture: () => {
    const snap = gestureSnapshot;
    gestureSnapshot = null;
    if (!snap || snap === get().doc) return;
    set({ past: [...get().past.slice(-HISTORY_LIMIT), snap], future: [] });
  },
  setPrefs: (recipe) => set({ doc: produce(get().doc, recipe), dirty: true }),
  undo: () => {
    const { past, doc, future } = get();
    if (!past.length) return;
    const prev = carryPrefs(past[past.length - 1], doc);
    set({ doc: prev, past: past.slice(0, -1), future: [doc, ...future], dirty: true });
    pruneSelection();
  },
  redo: () => {
    const { past, doc, future } = get();
    if (!future.length) return;
    const next = carryPrefs(future[0], doc);
    set({ doc: next, past: [...past, doc], future: future.slice(1), dirty: true });
    pruneSelection();
  },
  setUI: (patch) => set({ ui: { ...get().ui, ...patch } }),
  toast: (text, kind = 'info') => {
    const t = { id: uid('t'), kind, text };
    set({ toasts: [...get().toasts.slice(-4), t] });
    setTimeout(() => get().dismissToast(t.id), kind === 'error' ? 8000 : 4000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  loadDoc: (doc, audio, assets, location) => {
    const peaks = new Map<string, PeakPyramid>();
    for (const [id, a] of audio) peaks.set(id, buildPeaks(a));
    set({
      doc,
      past: [],
      future: [],
      dirty: false,
      location,
      rt: { audio, assets, peaks },
      rtVersion: get().rtVersion + 1,
      ui: { ...get().ui, sourceId: doc.sources[0]?.id ?? null, sliceIds: [], eventIds: [], bars: null, candidateA: null, candidateB: null, auditioning: null },
    });
  },
  markSaved: (location) => set({ dirty: false, location }),
  addSource: (src, audio, bytes) => {
    const rt = get().rt;
    rt.audio.set(src.id, audio);
    rt.assets.set(src.assetName, bytes);
    rt.peaks.set(src.id, buildPeaks(audio));
    set({ rtVersion: get().rtVersion + 1 });
    get().commit('Add source', (d) => {
      d.sources.push(src);
    });
    get().setUI({ sourceId: src.id, sliceIds: [] });
  },
  relinkSource: (id, audio, bytes, assetName) => {
    const rt = get().rt;
    rt.audio.set(id, audio);
    rt.assets.set(assetName, bytes);
    rt.peaks.set(id, buildPeaks(audio));
    set({ rtVersion: get().rtVersion + 1 });
    get().commit('Relink source', (d) => {
      const s = d.sources.find((x) => x.id === id);
      if (s) {
        s.missing = false;
        s.assetName = assetName;
        s.frames = audio.channels[0].length;
        s.sampleRate = audio.sampleRate;
        s.channelCount = audio.channels.length;
      }
    });
  },
  setPlayback: (playing, tick) => set({ playing, positionTick: tick ?? get().positionTick }),
}));

function pruneSelection() {
  const { doc, ui, setUI } = useStore.getState();
  const sl = new Set(doc.slices.map((s) => s.id));
  const ev = new Set(doc.sequence.events.map((e) => e.id));
  setUI({ sliceIds: ui.sliceIds.filter((i) => sl.has(i)), eventIds: ui.eventIds.filter((i) => ev.has(i)) });
}

/* ───────────────────────── Domain actions ───────────────────────── */

const S = () => useStore.getState();

export function analysisFor(slice: Slice): Slice {
  const a = S().rt.audio.get(slice.sourceId);
  if (!a) return slice;
  const analysis = analyseSlice(slice, a, globalRmsPeak(a));
  const src = S().doc.sources.find((s) => s.id === slice.sourceId);
  const dur = src ? (slice.end - slice.start) / src.sampleRate : 0;
  return { ...slice, analysis, category: slice.category ?? suggestCategory(analysis, dur, slice.level) };
}

export const actions = {
  addSlices(slices: Slice[], select = true) {
    const analysed = slices.map((s) => (s.analysis ? s : analysisFor(s)));
    S().commit('Add slices', (d) => {
      d.slices.push(...(analysed as any));
      d.slices = reorder(d.slices as Slice[]) as any;
    });
    if (select) S().setUI({ sliceIds: analysed.map((s) => s.id) });
  },
  updateSlice(id: string, patch: Partial<Slice>, label = 'Edit slice') {
    S().commit(label, (d) => {
      const s = d.slices.find((x) => x.id === id);
      if (s) Object.assign(s, patch);
      if (patch.start !== undefined || patch.end !== undefined) d.slices = reorder(d.slices as Slice[]) as any;
    });
  },
  replaceSlices(removeIds: string[], add: Slice[], label: string) {
    const analysed = add.map((s) => (s.analysis ? s : analysisFor(s)));
    S().commit(label, (d) => {
      const rm = new Set(removeIds);
      d.slices = d.slices.filter((s) => !rm.has(s.id));
      d.slices.push(...(analysed as any));
      d.slices = reorder(d.slices as Slice[]) as any;
    });
    S().setUI({ sliceIds: analysed.map((s) => s.id) });
  },
  removeSlices(ids: string[]) {
    const rm = new Set(ids);
    S().commit('Delete slices', (d) => {
      d.slices = d.slices.filter((s) => !rm.has(s.id)).map((s) => (s.parentId && rm.has(s.parentId) ? { ...s, parentId: undefined } : s)) as any;
      d.sequence.events = d.sequence.events.filter((e) => !rm.has(e.sliceId));
      for (const c of d.collections) c.sliceIds = c.sliceIds.filter((i) => !rm.has(i));
      d.sequence.motifs = d.sequence.motifs.filter((m) => m.notes.every((n) => !rm.has(n.sliceId)));
    });
    S().setUI({ sliceIds: [] });
  },
  removeSource(id: string) {
    const ids = S().doc.slices.filter((s) => s.sourceId === id).map((s) => s.id);
    actions.removeSlices(ids);
    S().commit('Remove source', (d) => {
      d.sources = d.sources.filter((s) => s.id !== id);
    });
    S().setUI({ sourceId: S().doc.sources[0]?.id ?? null });
  },
  updateSource(id: string, patch: Partial<SourceAudio>) {
    S().commit('Edit source', (d) => {
      const s = d.sources.find((x) => x.id === id);
      if (s) Object.assign(s, patch);
    });
  },
  updateSeq(patch: Partial<Sequence>, label = 'Edit arrangement') {
    S().commit(label, (d) => {
      Object.assign(d.sequence, patch);
    });
  },
  addTrack(role: Role, name?: string): string {
    const id = uid('trk');
    S().commit('Add layer', (d) => {
      d.sequence.tracks.push({ id, name: name ?? `${role[0].toUpperCase()}${role.slice(1)} layer`, role, mute: false, solo: false, gain: 0, pan: 0, locked: false, color: ROLE_COLORS[role] });
    });
    return id;
  },
  updateTrack(id: string, patch: Partial<Track>, label = 'Edit layer') {
    S().commit(label, (d) => {
      const t = d.sequence.tracks.find((x) => x.id === id);
      if (t) Object.assign(t, patch);
      if (patch.role && t) t.color = ROLE_COLORS[patch.role];
    });
  },
  removeTrack(id: string) {
    S().commit('Delete layer', (d) => {
      d.sequence.tracks = d.sequence.tracks.filter((t) => t.id !== id);
      d.sequence.events = d.sequence.events.filter((e) => e.trackId !== id);
    });
  },
  addEvents(evs: SeqEvent[], select = true) {
    S().commit('Add events', (d) => {
      d.sequence.events.push(...evs);
      d.sequence.events.sort((a, b) => a.tick - b.tick);
    });
    if (select) S().setUI({ eventIds: evs.map((e) => e.id) });
  },
  updateEvents(ids: string[], fn: (e: Draft<SeqEvent>) => void, label = 'Edit events') {
    const set = new Set(ids);
    S().commit(label, (d) => {
      for (const e of d.sequence.events) if (set.has(e.id)) fn(e);
    });
  },
  removeEvents(ids: string[]) {
    const set = new Set(ids);
    S().commit('Delete events', (d) => {
      d.sequence.events = d.sequence.events.filter((e) => !set.has(e.id) || e.locked);
    });
    S().setUI({ eventIds: S().ui.eventIds.filter((i) => S().doc.sequence.events.some((e) => e.id === i)) });
  },
  applyArrangement(out: { tracks: Track[]; events: SeqEvent[]; motifs: Sequence['motifs'] }, label: string) {
    S().commit(label, (d) => {
      d.sequence.tracks = out.tracks as any;
      d.sequence.events = out.events as any;
      d.sequence.motifs = out.motifs as any;
    });
    S().setUI({ eventIds: [] });
  },
  setSettings(patch: Partial<GeneratorSettings>) {
    S().setPrefs((d) => {
      Object.assign(d.sequence.settings, patch);
    });
  },
  setExportSettings(patch: Partial<ExportSettings>) {
    S().setPrefs((d) => {
      Object.assign(d.exportSettings, patch);
    });
  },
  addCandidates(c: Candidate[]) {
    S().setPrefs((d) => {
      // keep favourites and the most recent ideas; long histories bloat project files
      const keep = d.candidates.filter((x) => x.favourite);
      const rest = d.candidates.filter((x) => !x.favourite);
      d.candidates = [...keep, ...rest.slice(-12), ...(c as any)];
    });
  },
  updateCandidate(id: string, patch: Partial<Candidate>) {
    S().setPrefs((d) => {
      const c = d.candidates.find((x) => x.id === id);
      if (c) Object.assign(c, patch);
    });
  },
  removeCandidate(id: string) {
    S().setPrefs((d) => {
      d.candidates = d.candidates.filter((x) => x.id !== id);
    });
    const ui = S().ui;
    S().setUI({ candidateA: ui.candidateA === id ? null : ui.candidateA, candidateB: ui.candidateB === id ? null : ui.candidateB });
  },
  toggleBarLock(bar: number) {
    S().commit('Toggle bar lock', (d) => {
      const i = d.sequence.lockedBars.indexOf(bar);
      if (i >= 0) d.sequence.lockedBars.splice(i, 1);
      else d.sequence.lockedBars.push(bar);
    });
  },
};
