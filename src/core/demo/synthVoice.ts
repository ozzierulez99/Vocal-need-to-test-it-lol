import type { AudioData } from '../types';
import { Rng } from '../rng';

/**
 * A small formant-style vocal synthesiser used to produce *synthetic vocal-like*
 * demo and test recordings (vowels with formants, consonant noise bursts,
 * breaths, whispers, hums). It is not speech synthesis – it gives the
 * application realistic-shaped material: syllables with attacks, sustained
 * pitched vowels, gaps and noisy fragments.
 */

type Vowel = 'a' | 'e' | 'i' | 'o' | 'u' | 'm' | 'ae';
type Onset = 's' | 'sh' | 't' | 'k' | 'p' | 'h' | 'ch' | 'n' | 'l' | 'y' | 'w' | 'd' | 'g' | 'b' | 'f';

const FORMANTS: Record<Vowel, [number, number, number][]> = {
  // [freq, bandwidth, gain]
  a: [[800, 80, 1], [1200, 90, 0.5], [2500, 120, 0.25]],
  ae: [[660, 80, 1], [1700, 100, 0.55], [2400, 120, 0.25]],
  e: [[500, 70, 1], [1900, 100, 0.45], [2600, 120, 0.3]],
  i: [[300, 60, 1], [2300, 110, 0.4], [3000, 140, 0.3]],
  o: [[500, 70, 1], [850, 80, 0.6], [2500, 130, 0.15]],
  u: [[330, 60, 1], [800, 80, 0.35], [2300, 130, 0.1]],
  m: [[270, 50, 1], [1100, 200, 0.06], [2500, 300, 0.03]],
};

export interface Syllable {
  onset?: Onset;
  vowel: Vowel;
  /** End vowel for diphthongs (e.g. "yeah" a→e). */
  vowel2?: Vowel;
  pitch: number;
  /** Pitch at the end (glide). */
  pitchEnd?: number;
  dur: number;
  gap?: number;
  gain?: number;
  vibrato?: number;
  coda?: Onset;
  breathy?: number;
}

export type Segment =
  | ({ kind: 'syl' } & Syllable)
  | { kind: 'breath'; dur: number; gain?: number; gap?: number }
  | { kind: 'whisper'; vowel: Vowel; onset?: Onset; dur: number; gain?: number; gap?: number }
  | { kind: 'rest'; dur: number };

function envelope(n: number, a: number, r: number, i: number): number {
  if (i < a) return i / a;
  if (i > n - r) return Math.max(0, (n - i) / r);
  return 1;
}

function formantGain(freq: number, fm: [number, number, number][]): number {
  let g = 0;
  for (const [f, bw, amp] of fm) {
    const d = (freq - f) / (bw / 2);
    g += amp / (1 + d * d);
  }
  return g + 0.12;
}

function lerpFormants(a: Vowel, b: Vowel, t: number): [number, number, number][] {
  return FORMANTS[a].map((fa, i) => {
    const fb = FORMANTS[b][i];
    return [fa[0] + (fb[0] - fa[0]) * t, fa[1] + (fb[1] - fa[1]) * t, fa[2] + (fb[2] - fa[2]) * t] as [number, number, number];
  });
}

class Biquad {
  b0 = 0; b1 = 0; b2 = 0; a1 = 0; a2 = 0; x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  constructor(sr: number, type: 'bp' | 'lp' | 'hp', f: number, q: number) {
    const w = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr;
    const al = Math.sin(w) / (2 * q);
    const c = Math.cos(w);
    let b0, b1, b2;
    if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; }
    else if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
    else { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    const a0 = 1 + al;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = (-2 * c) / a0; this.a2 = (1 - al) / a0;
  }
  run(x: number) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

const ONSETS: Record<Onset, { type: 'noise' | 'voiced'; f: number; q: number; dur: number; gain: number }> = {
  s: { type: 'noise', f: 6500, q: 2, dur: 0.11, gain: 0.35 },
  sh: { type: 'noise', f: 3000, q: 2, dur: 0.12, gain: 0.4 },
  f: { type: 'noise', f: 5000, q: 0.8, dur: 0.08, gain: 0.18 },
  ch: { type: 'noise', f: 3500, q: 1.5, dur: 0.07, gain: 0.6 },
  t: { type: 'noise', f: 4500, q: 1, dur: 0.025, gain: 0.85 },
  k: { type: 'noise', f: 2000, q: 1.5, dur: 0.035, gain: 0.8 },
  p: { type: 'noise', f: 900, q: 0.8, dur: 0.02, gain: 0.85 },
  d: { type: 'noise', f: 3500, q: 1, dur: 0.015, gain: 0.55 },
  g: { type: 'noise', f: 1800, q: 1.2, dur: 0.02, gain: 0.5 },
  b: { type: 'noise', f: 700, q: 0.8, dur: 0.015, gain: 0.55 },
  h: { type: 'noise', f: 1400, q: 0.7, dur: 0.07, gain: 0.25 },
  n: { type: 'voiced', f: 0, q: 0, dur: 0.06, gain: 0.5 },
  l: { type: 'voiced', f: 0, q: 0, dur: 0.05, gain: 0.7 },
  y: { type: 'voiced', f: 0, q: 0, dur: 0.06, gain: 0.8 },
  w: { type: 'voiced', f: 0, q: 0, dur: 0.06, gain: 0.8 },
};

export interface VoiceSpec {
  sampleRate?: number;
  stereo?: boolean;
  seed?: number;
  /** Formant scaling (>1 brighter/smaller voice). */
  formantScale?: number;
  segments: Segment[];
  leadIn?: number;
  tailOut?: number;
  level?: number;
}

export function synthVoice(spec: VoiceSpec): AudioData {
  const sr = spec.sampleRate ?? 44100;
  const rng = new Rng(spec.seed ?? 7);
  const fs = spec.formantScale ?? 1;
  let total = (spec.leadIn ?? 0.15) + (spec.tailOut ?? 0.3);
  for (const s of spec.segments) total += s.dur + ('gap' in s && s.gap ? s.gap : 0) + (s.kind === 'syl' && s.onset ? ONSETS[s.onset].dur : 0);
  const n = Math.ceil(total * sr);
  const out = new Float32Array(n);
  let pos = Math.round((spec.leadIn ?? 0.15) * sr);
  const noise = () => rng.float(-1, 1);
  const scaleF = (fm: [number, number, number][]) => fm.map(([f, b, g]) => [f * fs, b * fs, g] as [number, number, number]);

  const voiced = (start: number, len: number, p0: number, p1: number, v0: Vowel, v1: Vowel, gain: number, vib: number, breathy: number, attackSec = 0.02) => {
    let phase = 0;
    const a = Math.round(attackSec * sr);
    const r = Math.round(0.04 * sr);
    const nb = new Biquad(sr, 'bp', 1500 * fs, 0.6);
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / len;
      const midi = p0 + (p1 - p0) * t + vib * Math.sin((2 * Math.PI * 5.2 * i) / sr) * Math.min(1, i / (0.25 * sr));
      const f0 = 440 * Math.pow(2, (midi - 69) / 12) * (1 + 0.002 * noise());
      phase += f0 / sr;
      if (phase > 1e6) phase -= 1e6;
      const fm = scaleF(lerpFormants(v0, v1, Math.min(1, t * 1.6)));
      let s = 0;
      const maxH = Math.min(48, Math.floor(5500 / f0));
      // compute formant gains once per 64 samples
      for (let h = 1; h <= maxH; h++) {
        const amp = Math.pow(h, -1.1) * formantGain(h * f0, fm);
        s += amp * Math.sin(2 * Math.PI * h * phase);
      }
      s += breathy * nb.run(noise()) * 2;
      out[start + i] += s * gain * 0.35 * envelope(len, a, r, i);
    }
  };

  const noiseBurst = (start: number, len: number, f: number, q: number, gain: number, shape: 'burst' | 'swell' = 'burst') => {
    const bp = new Biquad(sr, 'bp', f, q);
    const hp = new Biquad(sr, 'hp', 300, 0.7);
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / len;
      const env = shape === 'burst' ? Math.min(1, i / (0.002 * sr)) * Math.pow(1 - t, 1.5) : Math.sin(Math.PI * t) ** 1.5;
      out[start + i] += bp.run(hp.run(noise())) * gain * env * 1.6;
    }
  };

  for (const seg of spec.segments) {
    if (seg.kind === 'rest') {
      pos += Math.round(seg.dur * sr);
      continue;
    }
    if (seg.kind === 'breath') {
      const len = Math.round(seg.dur * sr);
      noiseBurst(pos, len, 1300, 0.5, (seg.gain ?? 0.35) * 0.6, 'swell');
      pos += len + Math.round((seg.gap ?? 0) * sr);
      continue;
    }
    if (seg.kind === 'whisper') {
      if (seg.onset) {
        const o = ONSETS[seg.onset];
        const l = Math.round(o.dur * sr);
        noiseBurst(pos, l, o.f, o.q, o.gain * (seg.gain ?? 0.5));
        pos += l;
      }
      const len = Math.round(seg.dur * sr);
      for (const [f, , g] of scaleF(FORMANTS[seg.vowel])) noiseBurst(pos, len, f, 4, g * (seg.gain ?? 0.5) * 0.9, 'swell');
      pos += len + Math.round((seg.gap ?? 0) * sr);
      continue;
    }
    const gain = seg.gain ?? 0.8;
    let attack = 0.03;
    if (seg.onset) {
      const o = ONSETS[seg.onset];
      const l = Math.round(o.dur * sr);
      if (o.type === 'noise') {
        noiseBurst(pos, l, o.f * fs, o.q, o.gain * gain);
        pos += l;
        attack = 0.008;
      } else {
        const v0: Vowel = seg.onset === 'y' ? 'i' : seg.onset === 'w' ? 'u' : 'm';
        voiced(pos, l + 200, seg.pitch, seg.pitch, v0, v0, gain * o.gain, 0, 0, 0.015);
        pos += l;
        attack = 0.01;
      }
    }
    const len = Math.round(seg.dur * sr);
    voiced(pos, len, seg.pitch, seg.pitchEnd ?? seg.pitch, seg.vowel, seg.vowel2 ?? seg.vowel, gain, seg.vibrato ?? 0.15, seg.breathy ?? 0.04, attack);
    pos += len;
    if (seg.coda) {
      const o = ONSETS[seg.coda];
      const l = Math.round(o.dur * sr);
      if (o.type === 'noise') noiseBurst(pos - 200, l, o.f * fs, o.q, o.gain * gain * 0.7);
      pos += l;
    }
    pos += Math.round((seg.gap ?? 0) * sr);
  }
  // normalise
  let pk = 0;
  for (const v of out) pk = Math.max(pk, Math.abs(v));
  const g = (spec.level ?? 0.7) / (pk || 1);
  for (let i = 0; i < n; i++) out[i] *= g;
  if (!spec.stereo) return { sampleRate: sr, channels: [out] };
  // slight stereo width: small delay + level difference
  const R = new Float32Array(n);
  const d = Math.round(0.0004 * sr);
  for (let i = 0; i < n; i++) R[i] = (i >= d ? out[i - d] : 0) * 0.92 + out[i] * 0.08;
  return { sampleRate: sr, channels: [out, R] };
}

const A3 = 57;

/** The demo recordings bundled with the app and used by tests. */
export const DEMO_VOICES: Record<string, { title: string; description: string; spec: VoiceSpec }> = {
  'sung-phrase': {
    title: 'Sung phrase (ethereal)',
    description: 'A floating sung line: "la-la oh yeah, ah ooh" with sustained vowels.',
    spec: {
      seed: 11,
      segments: [
        { kind: 'syl', onset: 'l', vowel: 'a', pitch: A3 + 12, dur: 0.32, gap: 0.06 },
        { kind: 'syl', onset: 'l', vowel: 'a', pitch: A3 + 15, dur: 0.3, gap: 0.09 },
        { kind: 'syl', vowel: 'o', pitch: A3 + 19, pitchEnd: A3 + 17, dur: 0.62, gap: 0.12, vibrato: 0.25 },
        { kind: 'syl', onset: 'y', vowel: 'e', vowel2: 'ae', pitch: A3 + 17, dur: 0.42, gap: 0.42 },
        { kind: 'breath', dur: 0.32, gap: 0.2, gain: 0.3 },
        { kind: 'syl', vowel: 'a', pitch: A3 + 14, dur: 0.85, gap: 0.14, vibrato: 0.3 },
        { kind: 'syl', vowel: 'u', pitch: A3 + 12, pitchEnd: A3 + 10, dur: 0.95, vibrato: 0.3, gain: 0.7 },
      ],
    },
  },
  'spoken-phrase': {
    title: 'Spoken phrase',
    description: 'Spoken word-like syllables with consonant attacks: "take me / to the / light to-night / now".',
    spec: {
      seed: 23,
      segments: [
        { kind: 'syl', onset: 't', vowel: 'e', vowel2: 'i', pitch: 52, pitchEnd: 51, dur: 0.17, coda: 'k', gap: 0.07 },
        { kind: 'syl', onset: 'n', vowel: 'i', pitch: 51, dur: 0.16, gap: 0.16 },
        { kind: 'syl', onset: 't', vowel: 'u', pitch: 53, dur: 0.12, gap: 0.06 },
        { kind: 'syl', onset: 'd', vowel: 'a', pitch: 51, dur: 0.1, gap: 0.12 },
        { kind: 'syl', onset: 'l', vowel: 'a', vowel2: 'i', pitch: 54, pitchEnd: 52, dur: 0.24, coda: 't', gap: 0.09 },
        { kind: 'syl', onset: 't', vowel: 'u', pitch: 52, dur: 0.1, gap: 0.03 },
        { kind: 'syl', onset: 'n', vowel: 'a', vowel2: 'i', pitch: 53, pitchEnd: 49, dur: 0.26, coda: 't', gap: 0.38 },
        { kind: 'syl', onset: 'n', vowel: 'a', vowel2: 'u', pitch: 50, pitchEnd: 47, dur: 0.34, gap: 0.05 },
      ],
    },
  },
  'hum-whisper': {
    title: 'Hum, breath & whisper',
    description: 'Sustained hums, breaths and whispered "haa / shh" for ghost-vocal textures.',
    spec: {
      seed: 31,
      segments: [
        { kind: 'syl', vowel: 'm', pitch: A3 + 7, dur: 1.4, gap: 0.3, vibrato: 0.1, gain: 0.6 },
        { kind: 'breath', dur: 0.5, gap: 0.3, gain: 0.45 },
        { kind: 'whisper', onset: 'h', vowel: 'a', dur: 0.7, gap: 0.35, gain: 0.6 },
        { kind: 'syl', vowel: 'u', pitch: A3 + 12, pitchEnd: A3 + 10, dur: 1.2, gap: 0.3, vibrato: 0.2, gain: 0.55, breathy: 0.15 },
        { kind: 'whisper', onset: 'sh', vowel: 'i', dur: 0.4, gap: 0.3, gain: 0.5 },
        { kind: 'syl', vowel: 'm', pitch: A3 + 3, dur: 1.1, gap: 0.2, gain: 0.55 },
        { kind: 'breath', dur: 0.45, gain: 0.4 },
      ],
    },
  },
  'voice-b': {
    title: 'Second voice (bright, stereo 48k)',
    description: 'A brighter second voice with sharp syllables: "hey / yeah / oh-oh / go / ti-ka".',
    spec: {
      seed: 47,
      sampleRate: 48000,
      stereo: true,
      formantScale: 1.15,
      segments: [
        { kind: 'syl', onset: 'h', vowel: 'e', vowel2: 'i', pitch: 69, dur: 0.22, gap: 0.18 },
        { kind: 'syl', onset: 'y', vowel: 'e', vowel2: 'a', pitch: 67, pitchEnd: 65, dur: 0.3, gap: 0.2 },
        { kind: 'syl', vowel: 'o', pitch: 72, dur: 0.16, gap: 0.05 },
        { kind: 'syl', vowel: 'o', pitch: 69, dur: 0.2, gap: 0.22 },
        { kind: 'syl', onset: 'g', vowel: 'o', vowel2: 'u', pitch: 64, dur: 0.28, gap: 0.2 },
        { kind: 'syl', onset: 't', vowel: 'i', pitch: 76, dur: 0.08, gap: 0.08 },
        { kind: 'syl', onset: 'k', vowel: 'a', pitch: 74, dur: 0.09, gap: 0.08 },
        { kind: 'syl', onset: 'ch', vowel: 'i', pitch: 76, dur: 0.07, gap: 0.08 },
        { kind: 'syl', onset: 'p', vowel: 'a', pitch: 71, dur: 0.1, gap: 0.05 },
      ],
    },
  },
  'chop-attacks': {
    title: 'Sharp syllables',
    description: 'Punchy short syllables for rhythmic chops: "ti ka ta pa chi da".',
    spec: {
      seed: 59,
      segments: [
        { kind: 'syl', onset: 't', vowel: 'i', pitch: 71, dur: 0.07, gap: 0.12 },
        { kind: 'syl', onset: 'k', vowel: 'a', pitch: 69, dur: 0.08, gap: 0.12 },
        { kind: 'syl', onset: 't', vowel: 'a', pitch: 67, dur: 0.09, gap: 0.12 },
        { kind: 'syl', onset: 'p', vowel: 'a', pitch: 64, dur: 0.09, gap: 0.12 },
        { kind: 'syl', onset: 'ch', vowel: 'i', pitch: 72, dur: 0.07, gap: 0.12 },
        { kind: 'syl', onset: 'd', vowel: 'a', vowel2: 'e', pitch: 69, dur: 0.12, gap: 0.12 },
        { kind: 'syl', onset: 'h', vowel: 'e', vowel2: 'i', pitch: 74, dur: 0.18, gap: 0.12 },
        { kind: 'syl', vowel: 'o', pitch: 67, dur: 0.35, gap: 0.05, vibrato: 0.2 },
      ],
    },
  },
};

export function demoVoice(name: keyof typeof DEMO_VOICES | string): AudioData {
  const v = DEMO_VOICES[name];
  if (!v) throw new Error(`Unknown demo voice ${name}`);
  return synthVoice(v.spec);
}
