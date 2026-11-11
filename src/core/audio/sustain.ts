import type { AudioData } from '../types';
import { toMono } from './wav';
import { estimatePitch } from './analysis';

/**
 * Loop-sustain ("freeze"): extends a vowel by crossfade-looping a stable part of
 * it, the way a sampler sustains a note. Simple and reliable: no time-stretching,
 * the pitch and timbre of the looped region are untouched.
 *
 * The result is a new piece of audio: [original attack][loop × n with equal-power
 * crossfades][fade-out], `seconds` long.
 */
export interface SustainOptions {
  seconds: number;
  /** fade-out at the very end (ms) */
  releaseMs?: number;
}

function correlation(x: Float32Array, a: number, b: number, n: number): number {
  let num = 0, ea = 0, eb = 0;
  for (let i = 0; i < n; i++) {
    const u = x[a + i];
    const v = x[b + i];
    num += u * v;
    ea += u * u;
    eb += v * v;
  }
  return ea > 0 && eb > 0 ? num / Math.sqrt(ea * eb) : 0;
}

export function findLoop(audio: AudioData, start: number, end: number): { loopStart: number; loopLen: number; xfade: number } | null {
  const mono = toMono(audio);
  const sr = audio.sampleRate;
  const len = end - start;
  if (len < sr * 0.06) return null;
  // work in the steadier later half of the region, away from the attack
  const regionStart = start + Math.round(len * 0.35);
  const regionEnd = end - Math.round(Math.min(len * 0.08, sr * 0.02));
  const room = regionEnd - regionStart;
  if (room < sr * 0.03) return null;
  const p = estimatePitch(mono.subarray(regionStart, regionEnd), sr);
  const period = p.midi !== null && p.confidence > 0.6 ? sr / (440 * Math.pow(2, (p.midi - 69) / 12)) : sr * 0.01;
  const xfade = Math.max(Math.round(period * 2), Math.min(Math.round(sr * 0.03), Math.floor(room * 0.3)));
  // loop length: as long as the region allows (less audible repetition), a whole number of periods
  const want = Math.min(room - xfade, Math.round(sr * 0.22));
  const cycles = Math.max(2, Math.floor(want / period));
  let best = { len: Math.round(cycles * period), c: -2 };
  // refine around the estimate so the waveform lines up at the seam
  const centre = Math.round(cycles * period);
  const span = Math.max(4, Math.round(period * 0.5));
  const cmpN = Math.min(xfade, Math.round(period * 3));
  for (let L = centre - span; L <= centre + span; L++) {
    if (L < period * 1.5 || regionStart + L + cmpN >= mono.length || L + xfade > room) continue;
    const c = correlation(mono, regionStart, regionStart + L, cmpN);
    if (c > best.c) best = { len: L, c };
  }
  if (best.c < -1) return null;
  return { loopStart: regionStart, loopLen: best.len, xfade: Math.min(xfade, Math.floor(best.len / 2)) };
}

export function sustainRegion(audio: AudioData, start: number, end: number, opts: SustainOptions): AudioData {
  const sr = audio.sampleRate;
  const total = Math.max(1, Math.round(opts.seconds * sr));
  const loop = findLoop(audio, start, end);
  const release = Math.min(Math.round(((opts.releaseMs ?? 120) / 1000) * sr), Math.floor(total / 3));
  const out = audio.channels.map(() => new Float32Array(total));
  if (!loop) {
    // too short or unstable to loop: just copy what exists
    audio.channels.forEach((ch, c) => out[c].set(ch.subarray(start, Math.min(end, start + total))));
  } else {
    const { loopStart, loopLen, xfade } = loop;
    const head = loopStart - start; // attack copied as is
    audio.channels.forEach((ch, c) => {
      const o = out[c];
      for (let i = 0; i < Math.min(total, head + loopLen + xfade); i++) o[i] = ch[start + i] ?? 0;
      // each further pass crossfades the loop's first `xfade` samples over the previous pass' tail
      for (let pos = head + loopLen; pos < total; pos += loopLen) {
        for (let i = 0; i < loopLen + xfade && pos + i < total; i++) {
          const v = ch[loopStart + i] ?? 0;
          if (i < xfade) {
            const t = i / xfade;
            o[pos + i] = o[pos + i] * Math.cos((t * Math.PI) / 2) + v * Math.sin((t * Math.PI) / 2);
          } else o[pos + i] = v;
        }
      }
    });
  }
  for (const o of out) for (let i = 0; i < release; i++) o[total - 1 - i] *= i / release;
  return { sampleRate: sr, channels: out };
}
