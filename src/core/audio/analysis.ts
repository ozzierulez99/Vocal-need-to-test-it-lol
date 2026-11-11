import type { AudioData, SliceAnalysis } from '../types';
import { toMono } from './wav';
import { hzToMidi } from '../time';

/**
 * Deliberately simple, approximate analysis. None of this claims linguistic
 * understanding: it measures loudness, attack, noisiness and a rough pitch.
 */

/** RMS envelope with hop size in frames. */
export function rmsEnvelope(x: Float32Array, hop: number, win = hop * 2): Float32Array {
  const n = Math.max(1, Math.ceil(x.length / hop));
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = i * hop;
    const e = Math.min(x.length, s + win);
    let acc = 0;
    for (let j = s; j < e; j++) acc += x[j] * x[j];
    env[i] = e > s ? Math.sqrt(acc / (e - s)) : 0;
  }
  return env;
}

export const toDb = (x: number) => (x <= 1e-9 ? -180 : 20 * Math.log10(x));

export interface Region {
  start: number;
  end: number;
}

/**
 * Silence / low-energy detection. Returns non-silent regions (frames).
 * thresholdDb is relative to the loudest RMS window.
 */
export function detectSoundRegions(
  audio: AudioData,
  opts: { thresholdDb?: number; minSilenceMs?: number; minSoundMs?: number; padMs?: number } = {},
): Region[] {
  const { thresholdDb = -35, minSilenceMs = 80, minSoundMs = 40, padMs = 8 } = opts;
  const x = toMono(audio);
  const sr = audio.sampleRate;
  const hop = Math.max(16, Math.round(sr * 0.005));
  const env = rmsEnvelope(x, hop);
  let peak = 0;
  for (const v of env) peak = Math.max(peak, v);
  if (peak <= 0) return [];
  const thr = peak * Math.pow(10, thresholdDb / 20);
  const minSil = Math.ceil((minSilenceMs / 1000) * sr / hop);
  const minSnd = Math.ceil((minSoundMs / 1000) * sr / hop);
  const regions: Region[] = [];
  let i = 0;
  while (i < env.length) {
    while (i < env.length && env[i] < thr) i++;
    if (i >= env.length) break;
    const s = i;
    let silentRun = 0;
    let lastLoud = i;
    while (i < env.length) {
      if (env[i] >= thr) {
        lastLoud = i;
        silentRun = 0;
      } else if (++silentRun >= minSil) break;
      i++;
    }
    if (lastLoud - s + 1 >= minSnd) regions.push({ start: s * hop, end: Math.min(x.length, (lastLoud + 1) * hop + hop) });
  }
  const pad = Math.round((padMs / 1000) * sr);
  return regions.map((r) => ({ start: Math.max(0, r.start - pad), end: Math.min(x.length, r.end + pad) }));
}

/**
 * Basic onset detection from positive log-energy flux with an adaptive threshold.
 * Returns onset frames. Sensitivity 0..1 (higher = more onsets).
 */
export function detectOnsets(
  audio: AudioData,
  opts: { sensitivity?: number; minGapMs?: number; start?: number; end?: number } = {},
): number[] {
  const { sensitivity = 0.5, minGapMs = 60 } = opts;
  const full = toMono(audio);
  const s0 = Math.max(0, opts.start ?? 0);
  const e0 = Math.min(full.length, opts.end ?? full.length);
  const x = full.subarray(s0, e0);
  const sr = audio.sampleRate;
  const hop = Math.max(32, Math.round(sr * 0.004));
  const env = rmsEnvelope(x, hop, hop * 3);
  let peak = 0;
  for (const v of env) peak = Math.max(peak, v);
  if (peak <= 0) return [];
  const floor = peak * 0.02;
  const logE = Array.from(env, (v) => Math.log10(Math.max(v, floor)));
  const flux = new Float32Array(env.length);
  const lag = 3;
  for (let i = lag; i < env.length; i++) flux[i] = Math.max(0, logE[i] - logE[i - lag]);
  const win = 25;
  const k = 1.6 - sensitivity * 1.2;
  const minAbs = 0.25 - sensitivity * 0.18;
  const onsets: number[] = [];
  const minGap = Math.round((minGapMs / 1000) * sr / hop);
  let last = -1e9;
  for (let i = 1; i < flux.length - 1; i++) {
    if (flux[i] < flux[i - 1] || flux[i] < flux[i + 1]) continue;
    let mean = 0;
    let cnt = 0;
    for (let j = Math.max(0, i - win); j < Math.min(flux.length, i + win); j++) {
      mean += flux[j];
      cnt++;
    }
    mean /= cnt;
    if (flux[i] > Math.max(minAbs, mean * (1 + k)) && env[i] > peak * 0.04 && i - last >= minGap) {
      // Walk back to the start of the rise for a tighter boundary.
      let j = i;
      while (j > 0 && j > i - lag - 2 && env[j - 1] < env[j]) j--;
      onsets.push(s0 + j * hop);
      last = i;
    }
  }
  return onsets;
}

/** YIN on a single window. */
function yinWindow(frame: Float32Array, sr: number, minHz = 70, maxHz = 1000): { midi: number | null; confidence: number } {
  const W = frame.length;
  const maxLag = Math.min(Math.floor(sr / minHz), Math.floor(W / 2));
  const minLag = Math.floor(sr / maxHz);
  if (maxLag <= minLag + 2) return { midi: null, confidence: 0 };
  const d = new Float32Array(maxLag + 1);
  const len = W - maxLag;
  for (let tau = 1; tau <= maxLag; tau++) {
    let acc = 0;
    for (let i = 0; i < len; i++) {
      const diff = frame[i] - frame[i + tau];
      acc += diff * diff;
    }
    d[tau] = acc;
  }
  const cmnd = new Float32Array(maxLag + 1);
  cmnd[0] = 1;
  let run = 0;
  for (let tau = 1; tau <= maxLag; tau++) {
    run += d[tau];
    cmnd[tau] = run > 0 ? (d[tau] * tau) / run : 1;
  }
  let tauEst = -1;
  for (let tau = minLag; tau <= maxLag; tau++) {
    if (cmnd[tau] < 0.2) {
      while (tau + 1 <= maxLag && cmnd[tau + 1] < cmnd[tau]) tau++;
      tauEst = tau;
      break;
    }
  }
  if (tauEst < 0) {
    let m = 1;
    for (let tau = minLag; tau <= maxLag; tau++)
      if (cmnd[tau] < m) {
        m = cmnd[tau];
        tauEst = tau;
      }
    if (tauEst < 0 || m > 0.45) return { midi: null, confidence: Math.max(0, 1 - m) * 0.5 };
  }
  let t = tauEst;
  if (tauEst > 1 && tauEst < maxLag) {
    const a = cmnd[tauEst - 1];
    const b = cmnd[tauEst];
    const c = cmnd[tauEst + 1];
    const den = a + c - 2 * b;
    if (Math.abs(den) > 1e-9) t = tauEst + (a - c) / (2 * den);
  }
  return { midi: hzToMidi(sr / t), confidence: Math.max(0, Math.min(1, 1 - cmnd[tauEst])) };
}

/**
 * Rough pitch + periodicity estimate. Examines several loud windows and keeps the
 * most periodic one, so a consonant burst does not hide the vowel that follows.
 */
export function estimatePitch(x: Float32Array, sr: number): { midi: number | null; confidence: number } {
  const W = Math.min(x.length, Math.round(sr * 0.045));
  if (W < (sr / 70) * 1.2) return { midi: null, confidence: 0 };
  const hop = Math.max(1, Math.round(W / 2));
  const wins: { s: number; e: number }[] = [];
  let maxE = 0;
  for (let s = 0; s + W <= x.length; s += hop) {
    let e = 0;
    for (let i = s; i < s + W; i++) e += x[i] * x[i];
    wins.push({ s, e });
    if (e > maxE) maxE = e;
  }
  const loud = wins.filter((w) => w.e >= maxE * 0.25);
  const step = Math.max(1, Math.floor(loud.length / 8));
  let best: { midi: number | null; confidence: number } = { midi: null, confidence: 0 };
  for (let i = 0; i < loud.length; i += step) {
    const r = yinWindow(x.subarray(loud[i].s, loud[i].s + W), sr);
    if (r.confidence > best.confidence) best = r;
  }
  return best;
}

/** Feature extraction for one region of a source. */
export function analyseRegion(audio: AudioData, start: number, end: number, globalPeakRms = 0.3): SliceAnalysis {
  const mono = toMono(audio);
  const s = Math.max(0, Math.floor(start));
  const e = Math.min(mono.length, Math.floor(end));
  const x = mono.subarray(s, Math.max(s + 1, e));
  const sr = audio.sampleRate;
  let acc = 0;
  let peak = 0;
  let zc = 0;
  for (let i = 0; i < x.length; i++) {
    acc += x[i] * x[i];
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
    if (i > 0 && (x[i] >= 0) !== (x[i - 1] >= 0)) zc++;
  }
  const rms = Math.sqrt(acc / Math.max(1, x.length));
  const hop = Math.max(16, Math.round(sr * 0.005));
  const env = rmsEnvelope(x, hop);
  let envPeak = 0;
  let envPeakIdx = 0;
  env.forEach((v, i) => {
    if (v > envPeak) {
      envPeak = v;
      envPeakIdx = i;
    }
  });
  const attackMs = (envPeakIdx * hop * 1000) / sr;
  const startLevel = env.length ? env[0] / (envPeak || 1) : 0;
  // Sharp = reaches its peak quickly and starts from low level.
  const attack = Math.max(0, Math.min(1, (1 - attackMs / 120) * 0.75 + (1 - startLevel) * 0.25));
  let plateau = 0;
  for (const v of env) if (v >= envPeak * 0.5) plateau++;
  const sustain = env.length ? plateau / env.length : 0;
  const zcr = (zc / Math.max(1, x.length)) * (sr / 44100);
  const zcrNorm = Math.max(0, Math.min(1, (zcr - 0.02) / 0.25));
  const pitch = estimatePitch(x, sr);
  // Aperiodic (whispered/breathy/consonant) material scores high.
  const noisiness = Math.max(0, Math.min(1, 0.7 * (1 - pitch.confidence) + 0.3 * zcrNorm));
  const intensity = Math.max(0, Math.min(1, rms / Math.max(1e-6, globalPeakRms)));
  // Perceptual onset: where the envelope first reaches half of its peak (fine 2 ms hop).
  const fineHop = Math.max(8, Math.round(sr * 0.002));
  const fine = rmsEnvelope(x.subarray(0, Math.min(x.length, Math.round(sr * 0.25))), fineHop, fineHop * 2);
  let finePeak = 0;
  for (const v of fine) finePeak = Math.max(finePeak, v);
  let onsetIdx = 0;
  while (onsetIdx < fine.length && fine[onsetIdx] < Math.max(finePeak, envPeak * 0.6) * 0.5) onsetIdx++;
  const onset = onsetIdx >= fine.length ? 0 : Math.max(0, (onsetIdx - 1) * fineHop);
  return {
    onset,
    rms,
    peak,
    attack,
    sustain,
    noisiness,
    pitch: pitch.confidence > 0.68 && noisiness < 0.5 ? pitch.midi : null,
    pitchConfidence: pitch.confidence,
    intensity,
  };
}


/** Frame-wise pitch track on a decimated copy (fast enough for whole recordings). */
export interface PitchFrame {
  /** frame position in the original audio */
  pos: number;
  midi: number | null;
  confidence: number;
  rms: number;
}

export function pitchTrack(audio: AudioData, hopMs = 10): { frames: PitchFrame[]; hop: number } {
  const mono = toMono(audio);
  const factor = Math.max(1, Math.floor(audio.sampleRate / 11025));
  const sr = audio.sampleRate / factor;
  const n = Math.floor(mono.length / factor);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let a = 0;
    for (let j = 0; j < factor; j++) a += mono[i * factor + j];
    x[i] = a / factor;
  }
  const W = Math.round(sr * 0.04);
  const hop = Math.max(1, Math.round((sr * hopMs) / 1000));
  const frames: PitchFrame[] = [];
  for (let s = 0; s + W <= n; s += hop) {
    const win = x.subarray(s, s + W);
    let e = 0;
    for (let i = 0; i < W; i++) e += win[i] * win[i];
    const rms = Math.sqrt(e / W);
    const p = rms > 1e-4 ? yinWindow(win, sr, 75, 1100) : { midi: null, confidence: 0 };
    frames.push({ pos: s * factor, midi: p.midi, confidence: p.confidence, rms });
  }
  return { frames, hop: hop * factor };
}

export interface VowelRegion {
  start: number;
  end: number;
  /** median MIDI pitch of the region */
  pitch: number;
}

/**
 * "Vowel mining": finds stable, clearly pitched stretches (sung or spoken
 * vowels) regardless of word boundaries. These make the cleanest chop material
 * because their pitch is well defined and they start right at the vowel.
 */
export function findVowels(audio: AudioData, opts: { minMs?: number; tolerance?: number; maxMs?: number } = {}): VowelRegion[] {
  const { minMs = 70, tolerance = 0.7, maxMs = 2500 } = opts;
  const { frames, hop } = pitchTrack(audio);
  let peak = 0;
  for (const f of frames) peak = Math.max(peak, f.rms);
  if (peak <= 0) return [];
  const voiced = (f: PitchFrame) => f.midi !== null && f.confidence > 0.82 && f.rms > peak * 0.05;
  const out: VowelRegion[] = [];
  const total = audio.channels[0].length;
  let i = 0;
  while (i < frames.length) {
    if (!voiced(frames[i])) {
      i++;
      continue;
    }
    const startIdx = i;
    const pitches: number[] = [frames[i].midi!];
    let ref = frames[i].midi!;
    let misses = 0;
    i++;
    while (i < frames.length) {
      const f = frames[i];
      const ok = voiced(f) && Math.abs(f.midi! - ref) <= tolerance;
      if (ok) {
        pitches.push(f.midi!);
        // slow running reference follows gentle drift but not note changes
        ref = ref * 0.8 + f.midi! * 0.2;
        misses = 0;
      } else if (++misses > 2) break;
      i++;
    }
    const endIdx = i - misses;
    const start = Math.max(0, frames[startIdx].pos - Math.round(audio.sampleRate * 0.006));
    const end = Math.min(total, frames[Math.min(frames.length - 1, endIdx)].pos + hop);
    const ms = ((end - start) / audio.sampleRate) * 1000;
    if (ms >= minMs) {
      const sorted = pitches.slice().sort((a, b) => a - b);
      out.push({ start, end: Math.min(end, start + Math.round((maxMs / 1000) * audio.sampleRate)), pitch: sorted[Math.floor(sorted.length / 2)] });
    }
    i = Math.max(i, startIdx + 1);
  }
  return out;
}
