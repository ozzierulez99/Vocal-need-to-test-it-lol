import type { BeatKey, MidiNote, Slice, SourceAudio } from '../types';
import { detectKey } from '../beat/analyze';
import { slicePitch } from '../slicing/slices';

/**
 * Estimates the key a vocal is sung in from its pitched slices (duration and
 * confidence weighted), using the same key finder as Beat Fit. Ideas written
 * in the vocal's own key need the least transposition, so they sound the most
 * natural. Returns null when there is too little pitched material.
 */
export function detectVocalKey(slices: Slice[], sources: SourceAudio[]): BeatKey | null {
  const src = new Map(sources.map((s) => [s.id, s]));
  const notes: MidiNote[] = [];
  let tick = 0;
  for (const s of slices) {
    if (s.level === 'phrase') continue; // phrases repeat what their words contain
    const so = src.get(s.sourceId);
    if (!so || so.kind === 'derived') continue;
    const p = slicePitch(s, so);
    const conf = s.rootNote != null ? 1 : s.analysis?.pitchConfidence ?? 0;
    if (p === null || conf < 0.6 || (s.analysis?.noisiness ?? 0) > 0.5) continue;
    const dur = (s.end - s.start) / so.sampleRate;
    // ticks only carry weight here: ~1 beat per 0.5 s of sound
    const length = Math.max(60, Math.round(dur * 1920));
    notes.push({ tick, length, pitch: Math.round(p), velocity: Math.min(1, 0.4 + conf * 0.6) });
    tick += length;
  }
  const distinct = new Set(notes.map((n) => n.pitch % 12)).size;
  if (notes.length < 3 || distinct < 2) return null;
  return detectKey(notes, []);
}
