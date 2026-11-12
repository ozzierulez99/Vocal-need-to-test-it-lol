import type { SeqEvent, Slice } from '../core/types';
import { uid } from '../core/ids';
import { ticksPerBar } from '../core/time';
import { engine } from './audio/engine';
import { useStore, actions } from './store/store';
import { effectiveKey } from '../core/beat/fit';
import { SCALES } from '../core/compose/theory';

/**
 * Keyboard sampler: play the selected chop chromatically from the computer
 * keyboard (A W S E D F T G Y H U J K = one octave, Z / X = octave down / up).
 * While the transport plays with "Rec" armed, what you play is written into
 * the selected layer.
 */
const KEYS = ['a', 'w', 's', 'e', 'd', 'f', 't', 'g', 'y', 'h', 'u', 'j', 'k', 'o', 'l'];
let octave = 0;
const held = new Map<string, { tick: number; semis: number; sliceId: string } | null>();

const st = () => useStore.getState();

export function keysSlice(): Slice | null {
  const { doc, ui } = st();
  const byId = (id?: string) => doc.slices.find((s) => s.id === id) ?? null;
  return byId(ui.sliceIds[0]) ?? byId(doc.sequence.events.find((e) => ui.eventIds.includes(e.id))?.sliceId) ?? byId(doc.sequence.events[0]?.sliceId) ?? doc.slices.find((s) => s.analysis?.pitch != null) ?? doc.slices[0] ?? null;
}

/** Offset that puts the "A" key on the nearest key-root to the slice's own pitch (so playing stays in key). */
export function keysBase(slice: Slice): { base: number; tuned: boolean } {
  const { doc } = st();
  const s = doc.sequence.settings;
  const k = doc.beat?.enabled ? effectiveKey(doc.beat) : s.keyRoot != null ? { root: s.keyRoot, scale: s.scale } : null;
  const pitch = slice.rootNote ?? slice.analysis?.pitch;
  if (!k || pitch == null) return { base: 0, tuned: false };
  let d = (((k.root - pitch) % 12) + 12) % 12;
  if (d > 6) d -= 12;
  return { base: d, tuned: true };
}

/** Which of the 13 keys are in the current scale (for the on-screen hint). */
export function keysInScale(): boolean[] {
  const { doc } = st();
  const s = doc.sequence.settings;
  const k = doc.beat?.enabled ? effectiveKey(doc.beat) : s.keyRoot != null ? { root: s.keyRoot, scale: s.scale } : null;
  const pcs = k ? SCALES[k.scale] : null;
  return KEYS.slice(0, 13).map((_, i) => !pcs || pcs.includes(i % 12));
}

function currentTick(): number | null {
  return st().playing ? engine.currentTick() : null;
}

export function handleKeyDown(e: KeyboardEvent): boolean {
  const ui = st().ui;
  if (!ui.keys || e.ctrlKey || e.metaKey || e.altKey) return false;
  const key = e.key.toLowerCase();
  if (key === 'z' || key === 'x') {
    octave = Math.max(-2, Math.min(2, octave + (key === 'x' ? 1 : -1)));
    st().toast(`Keys octave ${octave > 0 ? '+' : ''}${octave}`, 'info');
    return true;
  }
  const idx = KEYS.indexOf(key);
  if (idx < 0) return false;
  if (e.repeat || held.has(key)) return true;
  const slice = keysSlice();
  if (!slice) return true;
  const audio = st().rt.audio.get(slice.sourceId);
  if (!audio) return true;
  const semis = Math.round(keysBase(slice).base) + idx + octave * 12;
  engine.setAudio(slice.sourceId, audio);
  engine.audition(slice.sourceId, slice.start, slice.end, { semitones: semis });
  const tick = ui.keysRecord ? currentTick() : null;
  held.set(key, tick == null ? null : { tick, semis, sliceId: slice.id });
  return true;
}

export function handleKeyUp(e: KeyboardEvent): boolean {
  const key = e.key.toLowerCase();
  if (!held.has(key)) return false;
  const h = held.get(key);
  held.delete(key);
  if (!h) return true;
  const { doc, ui } = st();
  const seq = doc.sequence;
  const now = currentTick() ?? h.tick + seq.grid;
  const grid = seq.snap ? seq.grid : 1;
  const total = seq.bars * ticksPerBar(seq.timeSig);
  const tick = ((Math.round(h.tick / grid) * grid) % total + total) % total;
  let len = now - h.tick;
  if (len <= 0) len += total; // the loop wrapped while the key was held
  len = Math.max(seq.grid / 2, Math.round(len / (grid / 2 || 1)) * (grid / 2 || 1));
  let trackId = ui.trackId ?? seq.tracks.find((t) => t.role === 'lead' && !t.locked)?.id ?? seq.tracks.find((t) => !t.locked)?.id;
  if (!trackId) trackId = actions.addTrack('lead');
  const ev: SeqEvent = { id: uid('ev'), trackId, sliceId: h.sliceId, tick, length: len, offset: 0, gain: 0, semitones: h.semis, reverse: false, fadeIn: 0, fadeOut: 12, pan: 0, velocity: 0.85, locked: false, gesture: 'played' };
  actions.addEvents([ev], false);
  return true;
}

export const KEY_LABELS = KEYS.slice(0, 13).map((k) => k.toUpperCase());
