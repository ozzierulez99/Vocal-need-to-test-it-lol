import type { BeatChord, BeatContext, BeatKey, BeatRhythm, MidiNote, ScaleName } from '../types';
import { PPQ } from '../types';
import { NOTE_NAMES } from '../time';
import { SCALES } from '../compose/theory';

/**
 * Beat analysis for “Fit to my beat”: reads a chord-progression / arp MIDI and
 * extracts the key & scale, a chord timeline, and a rhythm/space profile.
 * Deliberately simple, explainable methods (pitch-class profiles and chord
 * templates) – no machine learning.
 */

// Krumhansl–Kessler key profiles
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const TEMPLATES: { q: BeatChord['quality']; iv: number[]; suffix: string }[] = [
  { q: 'maj', iv: [0, 4, 7], suffix: '' },
  { q: 'min', iv: [0, 3, 7], suffix: 'm' },
  { q: 'dim', iv: [0, 3, 6], suffix: 'dim' },
  { q: 'aug', iv: [0, 4, 8], suffix: 'aug' },
  { q: 'sus2', iv: [0, 2, 7], suffix: 'sus2' },
  { q: 'sus4', iv: [0, 5, 7], suffix: 'sus4' },
  { q: '7', iv: [0, 4, 7, 10], suffix: '7' },
  { q: 'maj7', iv: [0, 4, 7, 11], suffix: 'maj7' },
  { q: 'm7', iv: [0, 3, 7, 10], suffix: 'm7' },
];

const pc = (m: number) => ((Math.round(m) % 12) + 12) % 12;
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const FLAT_MAJOR_ROOTS = new Set([5, 10, 3, 8, 1, 6]);

/** Flat keys (F, Bb, Eb… and their relative minors/modes) are spelled with flats. */
export function prefersFlats(root: number, scale: ScaleName): boolean {
  const majorEquivalent = scale === 'major' || scale === 'major-pentatonic' ? root : scale === 'dorian' ? (root + 10) % 12 : scale === 'phrygian' ? (root + 8) % 12 : (root + 3) % 12;
  return FLAT_MAJOR_ROOTS.has(majorEquivalent);
}

export function noteName(pcValue: number, flats: boolean) {
  const i = ((pcValue % 12) + 12) % 12;
  return flats ? FLAT_NAMES[i] : NOTE_NAMES[i];
}

function correlate(a: number[], b: number[]) {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

export function barTicks(timeSig: [number, number]) {
  return (PPQ * 4 * timeSig[0]) / timeSig[1];
}

/** Weighted pitch-class histogram of the notes sounding in [start, end). Bass notes count extra. */
export function pcWeights(notes: MidiNote[], start = -Infinity, end = Infinity): { w: number[]; bass: number | null } {
  const w = new Array(12).fill(0);
  let bassPitch = Infinity;
  let bassW = 0;
  for (const n of notes) {
    const ov = Math.min(end, n.tick + n.length) - Math.max(start, n.tick);
    if (ov <= 0) continue;
    const weight = (Math.min(ov, PPQ * 4) / PPQ) * (0.5 + 0.5 * n.velocity);
    w[pc(n.pitch)] += weight;
    if (n.pitch < bassPitch) {
      bassPitch = n.pitch;
      bassW = weight;
    }
  }
  if (bassPitch !== Infinity) w[pc(bassPitch)] += bassW * 0.6;
  return { w, bass: bassPitch === Infinity ? null : pc(bassPitch) };
}

export function detectChord(w: number[], bass: number | null): { root: number; quality: BeatChord['quality']; pcs: number[]; score: number } | null {
  const total = w.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const used = w.filter((x) => x > total * 0.04).length;
  if (used === 1) {
    const r = w.indexOf(Math.max(...w));
    return { root: r, quality: 'note', pcs: [r], score: 1 };
  }
  let best: { root: number; quality: BeatChord['quality']; pcs: number[]; score: number } | null = null;
  for (let root = 0; root < 12; root++) {
    for (const t of TEMPLATES) {
      const pcs = t.iv.map((i) => (root + i) % 12);
      // a 7th chord must really contain its 7th
      if (t.iv.length === 4 && w[pcs[3]] < total * 0.12) continue;
      if (w[root] < total * 0.08) continue;
      let inW = 0;
      for (const p of pcs) inW += w[p];
      const outW = total - inW;
      let score = (inW - 0.7 * outW) / total;
      if (bass === root) score += 0.12;
      if (t.iv.length === 3 && (t.q === 'sus2' || t.q === 'sus4' || t.q === 'aug' || t.q === 'dim')) score -= 0.04; // prefer plain triads on ties
      if (t.iv.length === 4) score += 0.02;
      if (!best || score > best.score) best = { root, quality: t.q, pcs, score };
    }
  }
  return best;
}

export function chordSymbol(root: number, q: BeatChord['quality'], flats = false) {
  if (q === 'note') return noteName(root, flats);
  return noteName(root, flats) + (TEMPLATES.find((t) => t.q === q)?.suffix ?? '');
}

export function analyseRhythm(notes: MidiNote[], timeSig: [number, number], lengthTicks: number): Omit<BeatRhythm, 'harmonicRhythm'> {
  const step = PPQ / 4;
  const bar = barTicks(timeSig);
  const spb = Math.round(bar / step);
  const bars = Math.max(1, Math.round(lengthTicks / bar));
  const onsetTicks = Array.from(new Set(notes.map((n) => Math.round(n.tick / step) * step))).sort((a, b) => a - b);
  const steps = new Array(spb).fill(0);
  const sounding = new Array(spb).fill(0);
  const perBar = new Array(bars).fill(0);
  for (const t of onsetTicks) {
    const b = Math.floor(t / bar);
    if (b >= bars) continue;
    steps[Math.round((t - b * bar) / step) % spb] += 1 / bars;
    perBar[b]++;
  }
  for (let b = 0; b < bars; b++)
    for (let s = 0; s < spb; s++) {
      const t = b * bar + s * step + step / 2;
      if (notes.some((n) => n.tick <= t && n.tick + n.length > t)) sounding[s] += 1 / bars;
    }
  // simultaneity: notes per onset cluster
  const clusters = new Map<number, number>();
  for (const n of notes) {
    const k = Math.round(n.tick / 30);
    clusters.set(k, (clusters.get(k) ?? 0) + 1);
  }
  const perOnset = notes.length / Math.max(1, clusters.size);
  const beats = (lengthTicks / PPQ) * (timeSig[1] / 4);
  const onsetsPerBeat = onsetTicks.length / Math.max(1, beats);
  // sustain: how long notes are held (pads ≈ 1, plucks/arps ≈ 0.1–0.2)
  const sustain = notes.reduce((a, n) => a + Math.min(1, n.length / (PPQ * 1.5)), 0) / Math.max(1, notes.length);
  // syncopation: off-beat onsets whose preceding on-beat position is empty (anticipations / push)
  let sync = 0;
  const byBar = new Map<number, Set<number>>();
  for (const t of onsetTicks) {
    const b = Math.floor(t / bar);
    if (!byBar.has(b)) byBar.set(b, new Set());
    byBar.get(b)!.add(Math.round((t - b * bar) / step));
  }
  for (const set of byBar.values())
    for (const st of set) {
      if (st % 2 === 1 && !set.has(st - 1)) sync += 1;
      else if (st % 4 === 2 && !set.has(st - 2)) sync += 0.5;
    }
  const kind: BeatRhythm['kind'] = perOnset >= 2.3 ? 'chords' : perOnset <= 1.35 ? (onsetsPerBeat >= 1.8 ? 'arp' : 'melody') : 'mixed';
  const pitches = notes.map((n) => n.pitch).sort((a, b) => a - b);
  const maxBar = Math.max(1, ...perBar);
  return {
    steps: steps.map((v) => Math.min(1, v)),
    sounding: sounding.map((v) => Math.min(1, v)),
    onsetsPerBeat,
    syncopation: onsetTicks.length ? sync / onsetTicks.length : 0,
    sustain,
    kind,
    register: pitches[Math.floor(pitches.length / 2)] ?? 60,
    densityPerBar: perBar.map((v) => v / maxBar),
  };
}

export function detectChords(notes: MidiNote[], timeSig: [number, number], lengthTicks: number, kind: BeatRhythm['kind']): BeatChord[] {
  const beat = (PPQ * 4) / timeSig[1];
  const bar = barTicks(timeSig);
  // arps and lines spread a chord over time, so listen over half a bar
  const win = kind === 'chords' || kind === 'mixed' ? beat : Math.max(beat, bar / 2);
  const out: BeatChord[] = [];
  for (let t = 0; t < lengthTicks; t += win) {
    const { w, bass } = pcWeights(notes, t, t + win);
    const c = detectChord(w, bass);
    if (!c) {
      if (out.length) out[out.length - 1].length += win;
      continue;
    }
    const sym = chordSymbol(c.root, c.quality);
    const prev = out[out.length - 1];
    if (prev && prev.symbol === sym) prev.length += win;
    else out.push({ tick: t, length: win, root: c.root, quality: c.quality, symbol: sym, pcs: c.pcs });
  }
  // fold very short chords (passing notes) into their neighbour
  for (let i = out.length - 1; i > 0; i--) {
    if (out[i].length < beat && out.length > 1) {
      out[i - 1].length += out[i].length;
      out.splice(i, 1);
    }
  }
  if (out.length && out[0].tick > 0) {
    out[0].length += out[0].tick;
    out[0].tick = 0;
  }
  return out;
}

export function detectKey(notes: MidiNote[], chords: BeatChord[]): BeatKey {
  const { w } = pcWeights(notes);
  // In loop-based music the first chord is the strongest tonal cue (Am–F–C–G is A minor, not C major).
  const c0 = chords[0];
  const last = chords[chords.length - 1];
  const scored: { root: number; scale: ScaleName; score: number }[] = [];
  for (let r = 0; r < 12; r++) {
    for (const [scale, prof] of [['major', MAJOR], ['minor', MINOR]] as const) {
      const rot = prof.map((_, i) => prof[(i - r + 12) % 12]);
      let score = correlate(w, rot);
      // penalise keys whose scale leaves out notes that are clearly played
      const tot = w.reduce((a, b) => a + b, 0) || 1;
      const inScale = new Set(SCALES[scale].map((i) => (r + i) % 12));
      let outW = 0;
      for (let i = 0; i < 12; i++) if (!inScale.has(i)) outW += w[i];
      score -= (outW / tot) * 0.6;
      if (c0 && c0.root === r) {
        const minorish = c0.quality === 'min' || c0.quality === 'm7';
        const majorish = c0.quality === 'maj' || c0.quality === 'maj7' || c0.quality === '7';
        if ((scale === 'minor' && minorish) || (scale === 'major' && majorish)) score += 0.14;
        else score += 0.03;
      }
      if (last && last.root === r && chords.length > 1) score += 0.02;
      scored.push({ root: r, scale, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  let scale: ScaleName = best.scale;
  // modal refinement from the actual pitch-class evidence
  const total = w.reduce((a, b) => a + b, 0) || 1;
  const at = (i: number) => w[(best.root + i) % 12] / total;
  if (best.scale === 'minor') {
    if (at(9) > 0.04 && at(9) > at(8) * 1.6) scale = 'dorian';
    else if (at(1) > 0.04 && at(1) > at(2) * 1.6) scale = 'phrygian';
    else if (at(11) > 0.04 && at(11) > at(10) * 1.6) scale = 'harmonic-minor';
  }
  const second = scored[1];
  const confidence = Math.max(0, Math.min(1, ((best.score - second.score) / 0.12) * 0.6 + Math.max(0, best.score) * 0.4));
  const alternatives = scored.slice(1, 4).map((x) => ({ root: x.root, scale: x.scale, score: x.score }));
  // pentatonic variant is always a safe, narrower option
  alternatives.push({ root: best.root, scale: best.scale === 'major' ? 'major-pentatonic' : 'minor-pentatonic', score: best.score });
  return { root: best.root, scale, confidence, alternatives };
}

export function keyName(root: number, scale: ScaleName) {
  const label: Record<ScaleName, string> = {
    major: 'major', minor: 'minor', dorian: 'dorian', phrygian: 'phrygian', 'minor-pentatonic': 'minor pentatonic',
    'major-pentatonic': 'major pentatonic', 'harmonic-minor': 'harmonic minor', chromatic: 'chromatic',
  };
  return `${noteName(root, prefersFlats(root, scale))} ${label[scale]}`;
}

export function scalePcs(root: number, scale: ScaleName): number[] {
  return SCALES[scale].map((i) => (root + i) % 12);
}

/** Full analysis of a beat MIDI (percussion already excluded). */
export function analyseBeat(notes: MidiNote[], opts: { name: string; bpm?: number; timeSig?: [number, number] }): BeatContext {
  if (!notes.length) throw new Error('The MIDI file has no pitched notes to analyse.');
  const timeSig = opts.timeSig ?? [4, 4];
  const bar = barTicks(timeSig);
  // start the loop at the first bar that contains notes
  const firstBar = Math.floor(Math.min(...notes.map((n) => n.tick)) / bar) * bar;
  const shifted = notes.map((n) => ({ ...n, tick: n.tick - firstBar })).sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
  const end = Math.max(...shifted.map((n) => n.tick + n.length));
  const lengthTicks = Math.max(bar, Math.ceil((end - bar * 0.1) / bar) * bar);
  const rhythmBase = analyseRhythm(shifted, timeSig, lengthTicks);
  const chords = detectChords(shifted, timeSig, lengthTicks, rhythmBase.kind);
  const changes = chords.length;
  const harmonicRhythm = Math.max(0.25, Math.round(((lengthTicks / bar) / Math.max(1, changes)) * 4) / 4);
  const key = detectKey(shifted, chords);
  const flats = prefersFlats(key.root, key.scale);
  for (const c of chords) c.symbol = chordSymbol(c.root, c.quality, flats);
  return {
    name: opts.name,
    notes: shifted,
    bpm: opts.bpm,
    timeSig,
    lengthTicks,
    key,
    chords,
    rhythm: { ...rhythmBase, harmonicRhythm },
    fit: { harmonize: true, rhythm: 'complement', preview: true, previewGain: -12 },
    enabled: true,
  };
}
