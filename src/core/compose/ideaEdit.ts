import type { SeqEvent, Slice, SourceAudio } from '../types';
import { slicePitch } from '../slicing/slices';
import { Rng } from '../rng';

/**
 * Edits on a finished idea that keep its music intact: swapping one chop for
 * another keeps every note's pitch (by retuning the new chop) and its rhythm.
 */

const lenOf = (s: Slice) => s.end - s.start;

/** Semitone shift that makes `to` sound at the pitch `from` was played at (same note; same octave when within reach). */
export function pitchShiftBetween(from: Slice, to: Slice, sources: SourceAudio[]): number | null {
  const so = (s: Slice) => sources.find((x) => x.id === s.sourceId);
  const a = slicePitch(from, so(from));
  const b = slicePitch(to, so(to));
  if (a === null || b === null) return null;
  // Same absolute pitch when that stays within an octave of the new chop's own pitch
  // (more would sound chipmunked or sludgy); otherwise fold by octaves – same note name.
  let d = a - b;
  while (d > 12) d -= 12;
  while (d < -12) d += 12;
  return d;
}

export function swapChop(events: SeqEvent[], fromId: string, toId: string, slices: Slice[], sources: SourceAudio[]): SeqEvent[] {
  const from = slices.find((s) => s.id === fromId);
  const to = slices.find((s) => s.id === toId);
  if (!from || !to || fromId === toId) return events;
  const shift = pitchShiftBetween(from, to, sources);
  const newLen = lenOf(to);
  return events.map((e) => {
    if (e.sliceId !== fromId || e.locked) return e;
    let semitones = e.semitones + (shift === null ? 0 : shift);
    semitones = Math.round(semitones * 100) / 100;
    // offsets point into the old chop (microchops); scale them into the new one
    const offset = e.offset > 0 ? Math.min(Math.round((e.offset / Math.max(1, lenOf(from))) * newLen), Math.max(0, newLen - 256)) : 0;
    return { ...e, sliceId: toId, semitones, offset };
  });
}

/** How well `b` could stand in for `a`: similar length, both pitched or both not, similar attack. */
export function chopSimilarity(a: Slice, b: Slice, sources: SourceAudio[]): number {
  const sa = sources.find((x) => x.id === a.sourceId);
  const sb = sources.find((x) => x.id === b.sourceId);
  const da = lenOf(a) / (sa?.sampleRate ?? 44100);
  const db = lenOf(b) / (sb?.sampleRate ?? 44100);
  const dur = Math.exp(-Math.abs(Math.log(Math.max(0.01, da) / Math.max(0.01, db))));
  const pa = slicePitch(a, sa) !== null;
  const pb = slicePitch(b, sb) !== null;
  const pitch = pa === pb ? 1 : 0.4;
  const att = 1 - Math.abs((a.analysis?.attack ?? 0.5) - (b.analysis?.attack ?? 0.5));
  const noise = 1 - Math.abs((a.analysis?.noisiness ?? 0.3) - (b.analysis?.noisiness ?? 0.3));
  return dur * 0.4 + pitch * 0.3 + att * 0.15 + noise * 0.15;
}

/** Chops ranked as replacements for `a` (best first, excluding itself and phrase-length slices unless `a` is one). */
export function similarChops(a: Slice, slices: Slice[], sources: SourceAudio[], exclude: Set<string> = new Set()): Slice[] {
  return slices
    .filter((s) => s.id !== a.id && !exclude.has(s.id) && (a.level === 'phrase' || s.level !== 'phrase'))
    .map((s) => ({ s, v: chopSimilarity(a, s, sources) }))
    .sort((x, y) => y.v - x.v)
    .map((x) => x.s);
}

/** Every chop in the idea is replaced by a similar, different one (pitch and rhythm kept). */
export function shuffleChops(events: SeqEvent[], slices: Slice[], sources: SourceAudio[], seed: number): SeqEvent[] {
  const rng = new Rng(`${seed}|shuffle`);
  const used = Array.from(new Set(events.map((e) => e.sliceId)));
  const taken = new Set<string>();
  let out = events;
  for (const id of used) {
    const a = slices.find((s) => s.id === id);
    if (!a) continue;
    const pool = similarChops(a, slices, sources, new Set([...used, ...taken])).slice(0, 5);
    if (!pool.length) continue;
    const b = pool[Math.floor(rng.next() * pool.length)];
    taken.add(b.id);
    out = swapChop(out, id, b.id, slices, sources);
  }
  return out;
}

/** Move a whole idea up or down (playback-rate transposition). */
export function transposeIdea(events: SeqEvent[], semis: number): SeqEvent[] {
  return events.map((e) => ({ ...e, semitones: Math.max(-36, Math.min(36, e.semitones + semis)) }));
}
