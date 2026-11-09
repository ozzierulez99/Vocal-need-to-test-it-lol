import type { AudioData, Slice, SliceAnalysis, SliceCategory, SliceLevel, SourceAudio } from '../types';
import { analyseRegion, detectOnsets, detectSoundRegions, rmsEnvelope } from '../audio/analysis';
import { toMono } from '../audio/wav';
import { uid } from '../ids';

export const LEVEL_PREFIX: Record<SliceLevel, string> = { phrase: 'P', word: 'W', syllable: 'S', sound: 'x' };
export const CHILD_LEVEL: Record<SliceLevel, SliceLevel> = {
  phrase: 'word',
  word: 'syllable',
  syllable: 'sound',
  sound: 'sound',
};

/** Minimum slice length in frames (~2 ms at 44.1k) to avoid degenerate regions. */
export const MIN_SLICE_FRAMES = 64;

export function makeSlice(
  source: SourceAudio,
  start: number,
  end: number,
  level: SliceLevel,
  extra: Partial<Slice> = {},
): Slice {
  const s = Math.max(0, Math.min(source.frames, Math.round(Math.min(start, end))));
  const e = Math.max(0, Math.min(source.frames, Math.round(Math.max(start, end))));
  return {
    id: extra.id ?? uid('sl'),
    sourceId: source.id,
    start: s,
    end: Math.max(e, Math.min(source.frames, s + MIN_SLICE_FRAMES)),
    name: extra.name ?? `${LEVEL_PREFIX[level]}`,
    level,
    tags: [],
    favourite: false,
    ...extra,
  };
}

export function sliceDuration(s: Slice, source: SourceAudio): number {
  return (s.end - s.start) / source.sampleRate;
}

/** Split a slice at a frame; returns the two halves (first keeps the id). */
export function splitSlice(slice: Slice, frame: number): [Slice, Slice] | null {
  const f = Math.round(frame);
  if (f - slice.start < MIN_SLICE_FRAMES || slice.end - f < MIN_SLICE_FRAMES) return null;
  const a: Slice = { ...slice, end: f, analysis: undefined };
  const b: Slice = { ...slice, id: uid('sl'), start: f, name: `${slice.name}b`, favourite: false, analysis: undefined };
  return [a, b];
}

/** Merge two slices of the same source & level into one spanning both. */
export function mergeSlices(a: Slice, b: Slice): Slice | null {
  if (a.sourceId !== b.sourceId || a.level !== b.level) return null;
  const [first, second] = a.start <= b.start ? [a, b] : [b, a];
  return {
    ...first,
    end: Math.max(first.end, second.end),
    start: Math.min(first.start, second.start),
    tags: Array.from(new Set([...first.tags, ...second.tags])),
    favourite: first.favourite || second.favourite,
    analysis: undefined,
  };
}

/** Create child slices at the next level from internal boundary frames. Parent is kept. */
export function subdivide(
  parent: Slice,
  source: SourceAudio,
  boundaries: number[],
  level: SliceLevel = CHILD_LEVEL[parent.level],
  minFrames = MIN_SLICE_FRAMES,
): Slice[] {
  const sorted = Array.from(new Set(boundaries.map(Math.round)))
    .filter((b) => b > parent.start + minFrames && b < parent.end - minFrames)
    .sort((x, y) => x - y);
  const inner: number[] = [];
  for (const b of sorted) if (!inner.length || b - inner[inner.length - 1] >= minFrames) inner.push(b);
  const edges = [parent.start, ...inner, parent.end];
  const out: Slice[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    if (edges[i + 1] - edges[i] < MIN_SLICE_FRAMES) continue;
    out.push(
      makeSlice(source, edges[i], edges[i + 1], level, {
        parentId: parent.id,
        name: `${parent.name}.${i + 1}`,
      }),
    );
  }
  return out;
}

export type SuggestMethod = 'interval' | 'beat' | 'rhythm' | 'silence' | 'onset' | 'transient';

export interface SuggestParams {
  method: SuggestMethod;
  /** interval: seconds */
  intervalSec?: number;
  /** beat: bpm and division per beat */
  bpm?: number;
  division?: number;
  /** rhythm: pattern of relative durations in beats, e.g. [0.75,0.75,0.5] */
  pattern?: number[];
  /** silence */
  thresholdDb?: number;
  minSilenceMs?: number;
  /** onset/transient */
  sensitivity?: number;
  /** Frame offset of beat 1 for grid methods. */
  gridOffset?: number;
}

/** Suggest boundary frames inside [start, end). Never destructive – only suggestions. */
export function suggestBoundaries(audio: AudioData, start: number, end: number, p: SuggestParams): number[] {
  const sr = audio.sampleRate;
  const out: number[] = [];
  switch (p.method) {
    case 'interval': {
      const step = Math.max(0.01, p.intervalSec ?? 0.25) * sr;
      for (let f = start + step; f < end - MIN_SLICE_FRAMES; f += step) out.push(Math.round(f));
      break;
    }
    case 'beat': {
      const bpm = p.bpm ?? 120;
      const step = (60 / bpm / Math.max(1, p.division ?? 2)) * sr;
      const origin = p.gridOffset ?? start;
      let f = origin + Math.ceil((start - origin) / step + 1e-9) * step;
      for (; f < end - MIN_SLICE_FRAMES; f += step) if (f > start) out.push(Math.round(f));
      break;
    }
    case 'rhythm': {
      const bpm = p.bpm ?? 120;
      const pat = p.pattern?.length ? p.pattern : [0.75, 0.75, 0.5];
      const beat = (60 / bpm) * sr;
      let f = start;
      let i = 0;
      while (true) {
        f += pat[i % pat.length] * beat;
        i++;
        if (f >= end - MIN_SLICE_FRAMES || i > 10000) break;
        out.push(Math.round(f));
      }
      break;
    }
    case 'silence': {
      const sub = { sampleRate: sr, channels: audio.channels.map((c) => c.subarray(start, end)) };
      const regs = detectSoundRegions(sub, { thresholdDb: p.thresholdDb ?? -35, minSilenceMs: p.minSilenceMs ?? 80 });
      for (const r of regs) {
        out.push(start + r.start, start + r.end);
      }
      break;
    }
    case 'onset':
      out.push(...detectOnsets(audio, { sensitivity: p.sensitivity ?? 0.5, start, end }));
      break;
    case 'transient':
      out.push(...detectOnsets(audio, { sensitivity: Math.min(1, (p.sensitivity ?? 0.5) + 0.25), minGapMs: 30, start, end }));
      break;
  }
  return Array.from(new Set(out.filter((f) => f > start && f < end))).sort((a, b) => a - b);
}

/** Turn silence-detected sound regions into slices (gaps are skipped, not sliced). */
export function slicesFromRegions(
  source: SourceAudio,
  regions: { start: number; end: number }[],
  level: SliceLevel,
  extra: Partial<Slice> = {},
): Slice[] {
  return regions
    .filter((r) => r.end - r.start >= MIN_SLICE_FRAMES)
    .map((r, i) => makeSlice(source, r.start, r.end, level, { name: `${LEVEL_PREFIX[level]}${i + 1}`, ...extra }));
}

/** Slices between consecutive boundaries (including region edges). */
export function slicesFromBoundaries(
  source: SourceAudio,
  start: number,
  end: number,
  boundaries: number[],
  level: SliceLevel,
  extra: Partial<Slice> = {},
): Slice[] {
  const edges = [start, ...boundaries.filter((b) => b > start && b < end).sort((a, b) => a - b), end];
  const out: Slice[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    if (edges[i + 1] - edges[i] < MIN_SLICE_FRAMES) continue;
    out.push(makeSlice(source, edges[i], edges[i + 1], level, { name: `${LEVEL_PREFIX[level]}${out.length + 1}`, ...extra }));
  }
  return out;
}

/** Trim leading/trailing near-silence of a region (helps tighten auto-chops). */
export function tightenRegion(audio: AudioData, start: number, end: number, thresholdDb = -40): { start: number; end: number } {
  const x = toMono(audio).subarray(start, end);
  const hop = Math.max(16, Math.round(audio.sampleRate * 0.002));
  const env = rmsEnvelope(x, hop);
  let peak = 0;
  for (const v of env) peak = Math.max(peak, v);
  const thr = peak * Math.pow(10, thresholdDb / 20);
  let a = 0;
  while (a < env.length && env[a] < thr) a++;
  let b = env.length - 1;
  while (b > a && env[b] < thr) b--;
  const s = start + Math.max(0, a - 1) * hop;
  const e = Math.min(end, start + (b + 2) * hop);
  return e - s > MIN_SLICE_FRAMES ? { start: s, end: e } : { start, end };
}

/** Suggest a category from simple features. A tendency, never forced on user-set categories. */
export function suggestCategory(a: SliceAnalysis, durSec: number, level: SliceLevel): SliceCategory {
  if (a.noisiness > 0.55) {
    if (a.attack > 0.75 && durSec < 0.14) return 'consonant';
    return a.intensity < 0.35 && durSec > 0.25 ? 'breath' : 'whisper';
  }
  if (a.attack > 0.8 && durSec < 0.12) return 'percussive';
  if (a.pitch !== null && a.sustain > 0.55 && durSec > 0.35) return level === 'phrase' ? 'sung-note' : 'sustained-vowel';
  if (level === 'word' || level === 'phrase') return a.pitch !== null ? 'word' : 'spoken';
  if (durSec < 0.08) return a.attack > 0.6 ? 'consonant' : 'short-vowel';
  if (a.pitch !== null && durSec < 0.25) return 'short-vowel';
  return 'syllable';
}

export function analyseSlice(slice: Slice, audio: AudioData, globalPeakRms?: number): SliceAnalysis {
  return analyseRegion(audio, slice.start, slice.end, globalPeakRms);
}

export function globalRmsPeak(audio: AudioData): number {
  const env = rmsEnvelope(toMono(audio), Math.round(audio.sampleRate * 0.02));
  let p = 0;
  for (const v of env) p = Math.max(p, v);
  return p || 0.1;
}

/** Recompute stable left-to-right order numbers per source & level. */
export function reorder(slices: Slice[]): Slice[] {
  const groups = new Map<string, Slice[]>();
  for (const s of slices) {
    const k = `${s.sourceId}|${s.level}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(s);
  }
  const order = new Map<string, number>();
  for (const g of groups.values()) g.slice().sort((a, b) => a.start - b.start).forEach((s, i) => order.set(s.id, i));
  return slices.map((s) => (s.order === order.get(s.id) ? s : { ...s, order: order.get(s.id) }));
}

export interface AutoChopResult {
  slices: Slice[];
}

/**
 * One-click chop: phrase level from long pauses, word level from short pauses,
 * syllable level from onsets inside each word. All levels coexist.
 */
export function autoChop(
  source: SourceAudio,
  audio: AudioData,
  opts: { levels?: SliceLevel[]; sensitivity?: number; prefix?: string } = {},
): AutoChopResult {
  const levels = opts.levels ?? ['phrase', 'word', 'syllable'];
  const prefix = opts.prefix ?? '';
  const gpk = globalRmsPeak(audio);
  const all: Slice[] = [];
  const phraseRegs = mergeClose(detectSoundRegions(audio, { thresholdDb: -38, minSilenceMs: 320 }), audio.sampleRate * 0.3);
  const wordRegs = detectSoundRegions(audio, { thresholdDb: -32, minSilenceMs: 45, minSoundMs: 35 });
  const phrases = slicesFromRegions(source, phraseRegs, 'phrase').map((s, i) => ({ ...s, name: `${prefix}P${i + 1}` }));
  const words = slicesFromRegions(source, wordRegs, 'word').map((s, i) => ({ ...s, name: `${prefix}W${i + 1}` }));
  for (const w of words) {
    const p = phrases.find((ph) => w.start >= ph.start - 10 && w.end <= ph.end + 10);
    if (p) w.parentId = p.id;
  }
  if (levels.includes('phrase')) all.push(...phrases);
  if (levels.includes('word')) all.push(...words);
  if (levels.includes('syllable') || levels.includes('sound')) {
    let n = 0;
    for (const w of words) {
      const on = detectOnsets(audio, { sensitivity: opts.sensitivity ?? 0.55, start: w.start, end: w.end, minGapMs: 70 });
      const kids = subdivide(w, source, on, 'syllable', Math.round(source.sampleRate * 0.035));
      if (kids.length <= 1) continue; // single-syllable word: the word itself serves
      for (const k of kids) k.name = `${prefix}S${++n}`;
      if (levels.includes('syllable')) all.push(...kids);
    }
  }
  const withAnalysis = all.map((s) => {
    const analysis = analyseSlice(s, audio, gpk);
    const dur = (s.end - s.start) / source.sampleRate;
    return { ...s, analysis, category: suggestCategory(analysis, dur, s.level), tags: ['auto'] };
  });
  return { slices: reorder(withAnalysis) };
}

function mergeClose(regs: { start: number; end: number }[], gap: number) {
  const out: { start: number; end: number }[] = [];
  for (const r of regs) {
    const last = out[out.length - 1];
    if (last && r.start - last.end < gap) last.end = r.end;
    else out.push({ ...r });
  }
  return out;
}

export function slicePitch(s: Slice, source?: SourceAudio): number | null {
  if (s.rootNote !== undefined && s.rootNote !== null) return s.rootNote;
  if (s.analysis?.pitch != null) return s.analysis.pitch;
  if (source?.rootNote !== undefined) return source.rootNote;
  return null;
}
