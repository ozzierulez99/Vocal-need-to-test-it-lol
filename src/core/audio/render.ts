import type { AudioData, Sequence, Slice, SourceAudio, TrackFilter } from '../types';
import { buildPlan, panGains, trackFilters, type PlannedEvent } from './plan';
import { ticksToFrames, ticksPerBar } from '../time';
import { toMono } from './wav';

/**
 * Offline renderer: mixes planned events into stereo output in plain JS.
 * Sample-accurate placement (absolute tick→frame conversion), cubic-Hermite
 * resampling for playback-rate changes, linear fades (same as the live engine),
 * equal-power panning identical to StereoPannerNode, per-track biquad filters.
 */
export interface RenderOptions {
  sampleRate: number;
  clickFadeMs: number;
  startTick?: number;
  endTick?: number;
  trackIds?: string[];
  respectMuteSolo?: boolean;
  /** cut: hard end at endTick, keep: extend until last event finishes, wrap: fold tail to the start (loop-ready). */
  tail?: 'cut' | 'keep' | 'wrap';
  level?: 'none' | 'prevent-clip' | 'normalize';
  normalizeDb?: number;
}

export interface RenderResult {
  audio: AudioData;
  peak: number;
  /** Peak before any level processing. */
  rawPeak: number;
  appliedGain: number;
  eventCount: number;
}

function hermite(x: Float32Array, pos: number): number {
  const i = Math.floor(pos);
  const t = pos - i;
  const n = x.length;
  const xm1 = x[i - 1 < 0 ? 0 : i - 1] ?? 0;
  const x0 = x[i] ?? 0;
  const x1 = i + 1 < n ? x[i + 1] : 0;
  const x2 = i + 2 < n ? x[i + 2] : 0;
  const c0 = x0;
  const c1 = 0.5 * (x1 - xm1);
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
  return ((c3 * t + c2) * t + c1) * t + c0;
}

/** Linear fade envelope shared conceptually with the live engine. */
export function envelopeAt(t: number, duration: number, fadeIn: number, fadeOut: number): number {
  if (t < 0 || t > duration) return 0;
  let g = 1;
  if (fadeIn > 0 && t < fadeIn) g = t / fadeIn;
  const toEnd = duration - t;
  if (fadeOut > 0 && toEnd < fadeOut) g = Math.min(g, toEnd / fadeOut);
  return g;
}

export function mixEvent(
  out: Float32Array[],
  outStart: number,
  ev: PlannedEvent,
  src: AudioData,
  outRate: number,
): void {
  const chans = src.channels.length > 2 ? [toMono(src)] : src.channels;
  const step = (ev.rate * src.sampleRate) / outRate;
  const outFrames = Math.max(1, Math.round((ev.duration * outRate)));
  const pg = panGains(ev.pan, chans.length);
  const L = out[0];
  const R = out[1];
  const maxPos = ev.srcFrames - 1;
  for (let k = 0; k < outFrames; k++) {
    const o = outStart + k;
    if (o < 0) continue;
    if (o >= L.length) break;
    let pos = k * step;
    if (pos > maxPos) pos = maxPos;
    const idx = ev.reverse ? ev.srcStart + maxPos - pos : ev.srcStart + pos;
    const env = ev.gain * envelopeAt(k / outRate, ev.duration, ev.fadeIn, ev.fadeOut);
    if (env === 0) continue;
    if (pg.mono) {
      const s = hermite(chans[0], idx) * env;
      L[o] += s * pg.l;
      R[o] += s * pg.r;
    } else {
      const sl = hermite(chans[0], idx) * env;
      const sr = hermite(chans[1], idx) * env;
      L[o] += sl * pg.ll + sr * pg.rl;
      R[o] += sr * pg.rr + sl * pg.lr;
    }
  }
}

/** RBJ cookbook biquad, Q = 1/sqrt(2) (matches BiquadFilterNode defaults closely). */
export function applyFilter(ch: Float32Array, sr: number, f: TrackFilter): void {
  const freq = Math.min(sr * 0.45, Math.max(20, f.frequency));
  const w0 = (2 * Math.PI * freq) / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  let b0: number, b1: number, b2: number;
  if (f.type === 'lowpass') {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
  } else {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
  }
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < ch.length; i++) {
    const x = ch[i];
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    ch[i] = y;
  }
}

export function renderSequence(
  seq: Pick<Sequence, 'events' | 'tracks' | 'bpm' | 'timeSig' | 'bars'>,
  slices: Slice[],
  sources: SourceAudio[],
  audio: Map<string, AudioData>,
  opts: RenderOptions,
): RenderResult {
  const sr = opts.sampleRate;
  const startTick = opts.startTick ?? 0;
  const endTick = opts.endTick ?? seq.bars * ticksPerBar(seq.timeSig);
  const plan = buildPlan(seq, slices, sources, {
    bpm: seq.bpm,
    clickFadeMs: opts.clickFadeMs,
    trackIds: opts.trackIds,
    respectMuteSolo: opts.respectMuteSolo ?? true,
    startTick,
    endTick,
  }).filter((p) => audio.has(p.sourceId));
  const baseFrames = ticksToFrames(endTick - startTick, seq.bpm, sr);
  let lastEnd = baseFrames;
  for (const p of plan) {
    const e = ticksToFrames(p.tick - startTick, seq.bpm, sr) + Math.ceil(p.duration * sr) + 1;
    if (e > lastEnd) lastEnd = e;
  }
  const tail = opts.tail ?? 'cut';
  const totalFrames = tail === 'cut' ? baseFrames : lastEnd;
  const filters = trackFilters(seq.tracks);
  const mixL = new Float32Array(totalFrames);
  const mixR = new Float32Array(totalFrames);
  // group by track for per-track filters
  const byTrack = new Map<string, PlannedEvent[]>();
  for (const p of plan) {
    if (!byTrack.has(p.trackId)) byTrack.set(p.trackId, []);
    byTrack.get(p.trackId)!.push(p);
  }
  for (const [trackId, evs] of byTrack) {
    const f = filters.get(trackId);
    const bus = f ? [new Float32Array(totalFrames), new Float32Array(totalFrames)] : [mixL, mixR];
    for (const p of evs) {
      const outStart = ticksToFrames(p.tick - startTick, seq.bpm, sr);
      mixEvent(bus, outStart, p, audio.get(p.sourceId)!, sr);
    }
    if (f) {
      applyFilter(bus[0], sr, f);
      applyFilter(bus[1], sr, f);
      for (let i = 0; i < totalFrames; i++) {
        mixL[i] += bus[0][i];
        mixR[i] += bus[1][i];
      }
    }
  }
  let L = mixL;
  let R = mixR;
  if (tail === 'wrap' && totalFrames > baseFrames && baseFrames > 0) {
    L = mixL.slice(0, baseFrames);
    R = mixR.slice(0, baseFrames);
    for (let i = baseFrames; i < totalFrames; i++) {
      const j = (i - baseFrames) % baseFrames;
      L[j] += mixL[i];
      R[j] += mixR[i];
    }
  }
  let rawPeak = 0;
  for (let i = 0; i < L.length; i++) rawPeak = Math.max(rawPeak, Math.abs(L[i]), Math.abs(R[i]));
  let g = 1;
  const level = opts.level ?? 'prevent-clip';
  if (level === 'normalize' && rawPeak > 0) g = Math.pow(10, (opts.normalizeDb ?? -1) / 20) / rawPeak;
  else if (level === 'prevent-clip' && rawPeak > 0.989) g = 0.989 / rawPeak;
  if (g !== 1) {
    for (let i = 0; i < L.length; i++) {
      L[i] *= g;
      R[i] *= g;
    }
  }
  return {
    audio: { sampleRate: sr, channels: [L, R] },
    peak: rawPeak * g,
    rawPeak,
    appliedGain: g,
    eventCount: plan.length,
  };
}

/** Linear-interpolation resample (used for exporting individual slices at a target rate). */
export function resample(a: AudioData, targetRate: number): AudioData {
  if (a.sampleRate === targetRate) return a;
  const ratio = a.sampleRate / targetRate;
  const n = Math.max(1, Math.round(a.channels[0].length / ratio));
  return {
    sampleRate: targetRate,
    channels: a.channels.map((ch) => {
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = hermite(ch, Math.min(ch.length - 1, i * ratio));
      return out;
    }),
  };
}
