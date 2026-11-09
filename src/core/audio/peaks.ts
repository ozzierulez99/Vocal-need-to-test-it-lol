import type { AudioData } from '../types';

/**
 * Multi-resolution min/max peak cache for fast waveform drawing.
 * Level 0 has one min/max pair per BASE frames, each following level halves the resolution.
 */
export interface PeakPyramid {
  base: number;
  levels: { min: Float32Array; max: Float32Array; framesPerPeak: number }[];
  frames: number;
}

export function buildPeaks(audio: AudioData, base = 64): PeakPyramid {
  const n = audio.channels[0]?.length ?? 0;
  const count = Math.ceil(n / base);
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let lo = 1;
    let hi = -1;
    const s = i * base;
    const e = Math.min(n, s + base);
    for (const ch of audio.channels) {
      for (let j = s; j < e; j++) {
        const x = ch[j];
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
    }
    min[i] = lo > hi ? 0 : lo;
    max[i] = lo > hi ? 0 : hi;
  }
  const levels = [{ min, max, framesPerPeak: base }];
  while (levels[levels.length - 1].min.length > 512) {
    const prev = levels[levels.length - 1];
    const c = Math.ceil(prev.min.length / 2);
    const mn = new Float32Array(c);
    const mx = new Float32Array(c);
    for (let i = 0; i < c; i++) {
      const a = 2 * i;
      const b = Math.min(prev.min.length - 1, a + 1);
      mn[i] = Math.min(prev.min[a], prev.min[b]);
      mx[i] = Math.max(prev.max[a], prev.max[b]);
    }
    levels.push({ min: mn, max: mx, framesPerPeak: prev.framesPerPeak * 2 });
  }
  return { base, levels, frames: n };
}

/** Sample the pyramid for `columns` pixel columns covering frames [start, end). */
export function peaksForRange(p: PeakPyramid, start: number, end: number, columns: number) {
  const fpc = (end - start) / Math.max(1, columns);
  let level = p.levels[0];
  for (const l of p.levels) if (l.framesPerPeak <= fpc) level = l;
  const mins = new Float32Array(columns);
  const maxs = new Float32Array(columns);
  for (let x = 0; x < columns; x++) {
    const f0 = start + x * fpc;
    const f1 = f0 + fpc;
    let i0 = Math.floor(f0 / level.framesPerPeak);
    let i1 = Math.max(i0 + 1, Math.ceil(f1 / level.framesPerPeak));
    i0 = Math.max(0, i0);
    i1 = Math.min(level.min.length, i1);
    let lo = 0;
    let hi = 0;
    for (let i = i0; i < i1; i++) {
      if (level.min[i] < lo) lo = level.min[i];
      if (level.max[i] > hi) hi = level.max[i];
    }
    mins[x] = lo;
    maxs[x] = hi;
  }
  return { mins, maxs };
}
