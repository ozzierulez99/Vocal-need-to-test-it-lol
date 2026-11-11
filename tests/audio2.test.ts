import { describe, it, expect } from 'vitest';
import { renderSequence } from '../src/core/audio/render';
import { buildPlan, framesConsumed, pitchEnvAt } from '../src/core/audio/plan';
import { findVowels, estimatePitch, analyseRegion } from '../src/core/audio/analysis';
import { sustainRegion, findLoop } from '../src/core/audio/sustain';
import { demoVoice } from '../src/core/demo/synthVoice';
import type { SeqEvent, Track, AudioData } from '../src/core/types';
import { constSource, rampSource, seqWith, sliceOf } from './helpers';

const SR = 48000;
const BPM = 120; // 1 tick = 25 frames
const P = Math.SQRT1_2;
const ev = (p: Partial<SeqEvent>): SeqEvent => ({ id: p.id ?? 'e1', trackId: 't', sliceId: 'sl1', tick: 0, length: 3840, offset: 0, gain: 0, semitones: 0, reverse: false, fadeIn: 0, fadeOut: 0, pan: 0, velocity: 0.8, locked: false, ...p });
const track = (extra: Partial<Track> = {}): Track => ({ id: 't', name: 't', role: 'lead', mute: false, solo: false, gain: 0, pan: 0, locked: false, color: '#fff', ...extra });
const plan = (events: SeqEvent[], slices: any[], src: any, tr = track(), groove?: any) => buildPlan({ events, tracks: [tr], groove }, slices, [src], { bpm: BPM, clickFadeMs: 0 });

describe('onset alignment (pre-roll)', () => {
  const r = rampSource('r', SR, SR);
  const withOnset = { ...sliceOf(r.src, 10000, 30000), analysis: { onset: 1200 } as any };
  it('starts early so the slice onset lands exactly on the grid', () => {
    const [p] = plan([ev({ tick: 960 })], [withOnset], r.src);
    expect(p.gridTime).toBeCloseTo(0.5, 9);
    expect(p.time).toBeCloseTo(0.5 - 1200 / SR, 9);
    const out = renderSequence(seqWith({ bpm: BPM, bars: 2, events: [ev({ tick: 960 })], tracks: [track()] }), [withOnset], [r.src], new Map([['r', r.audio]]), { sampleRate: SR, clickFadeMs: 0, level: 'none', tail: 'cut' });
    const L = out.audio.channels[0];
    expect(L[24000 - 1201]).toBe(0);
    expect(L[24000 - 1200]).toBeCloseTo((10000 / SR) * P, 6); // slice start, early
    expect(L[24000]).toBeCloseTo((11200 / SR) * P, 6); // the onset frame sits on the beat
  });
  it('keeps the gate measured from the grid', () => {
    const [p] = plan([ev({ tick: 960, length: 96 })], [withOnset], r.src); // gate 0.05 s
    expect(p.duration).toBeCloseTo(0.05 + 1200 / SR, 6);
  });
  it('clips the pre-roll at time zero without shifting the onset', () => {
    const [p] = plan([ev({ tick: 24 })], [withOnset], r.src); // grid at 600 frames < 1200 pre-roll
    expect(p.time).toBe(0);
    expect(p.srcStart).toBe(10000 + 600);
  });
  it('can be switched off per event, and is skipped for offsets and reversed events', () => {
    expect(plan([ev({ tick: 960, align: false })], [withOnset], r.src)[0].time).toBeCloseTo(0.5, 9);
    expect(plan([ev({ tick: 960, offset: 500 })], [withOnset], r.src)[0].time).toBeCloseTo(0.5, 9);
    expect(plan([ev({ tick: 960, reverse: true })], [withOnset], r.src)[0].time).toBeCloseTo(0.5, 9);
  });
  it('measures the onset of a consonant + vowel slice', () => {
    const x = new Float32Array(SR / 2);
    for (let i = 0; i < x.length; i++) x[i] = (i < 2400 ? 0.02 : 0.5) * Math.sin((2 * Math.PI * 220 * i) / SR); // quiet 50 ms, then loud
    const a = analyseRegion({ sampleRate: SR, channels: [x] }, 0, x.length);
    expect(Math.abs(a.onset! - 2400)).toBeLessThan(250);
  });
});

describe('choke, swing and humanise', () => {
  const c = constSource('c', SR, 0.5, SR);
  const sl = sliceOf(c.src, 0, SR);
  it('choke cuts the previous note on the layer; stacked notes are left alone', () => {
    const evs = [ev({ id: 'a', tick: 0 }), ev({ id: 'b', tick: 0, semitones: 12 }), ev({ id: 'c', tick: 480 })];
    const free = plan(evs, [sl], c.src);
    expect(free[0].duration).toBeCloseTo(1, 6);
    const choked = plan(evs, [sl], c.src, track({ choke: true }));
    const byId = Object.fromEntries(choked.map((p) => [p.eventId, p]));
    expect(byId.c.time).toBeCloseTo(0.25, 9);
    expect(byId.a.duration).toBeCloseTo(0.25, 6); // both notes of the stack are cut by c…
    expect(byId.b.duration).toBeCloseTo(0.25, 6);
    expect(byId.a.time).toBe(byId.b.time); // …but they do not choke each other
  });
  it('swing delays only off-beat sixteenths', () => {
    const evs = [0, 240, 480, 720, 160].map((tick, i) => ev({ id: `e${i}`, tick, length: 100 }));
    const pl = plan(evs, [sl], c.src, track(), { swing: 0.3, humanize: 0 });
    const t = Object.fromEntries(pl.map((p) => [p.tick, p.gridTime]));
    const step = 0.125;
    expect(t[0]).toBe(0);
    expect(t[240]).toBeCloseTo(step + 0.3 * step, 9);
    expect(t[480]).toBeCloseTo(2 * step, 9);
    expect(t[720]).toBeCloseTo(3 * step + 0.3 * step, 9);
    expect(t[160]).toBeCloseTo((160 / 240) * step, 9); // triplet position untouched
  });
  it('humanise is small, deterministic and leaves the model untouched', () => {
    const evs = Array.from({ length: 16 }, (_, i) => ev({ id: `h${i}`, tick: i * 240, length: 100 }));
    const a = plan(evs, [sl], c.src, track(), { swing: 0, humanize: 1 });
    const b = plan(evs, [sl], c.src, track(), { swing: 0, humanize: 1 });
    expect(a.map((p) => p.gridTime)).toEqual(b.map((p) => p.gridTime));
    let moved = 0;
    for (const p of a) {
      const d = Math.abs(p.gridTime - (p.tick / 240) * 0.125);
      expect(d).toBeLessThan(0.0125);
      if (d > 1e-6) moved++;
    }
    expect(moved).toBeGreaterThan(8);
    expect(evs.every((e, i) => e.tick === i * 240)).toBe(true);
  });
});

describe('pitch glides', () => {
  const r = rampSource('r', SR * 2, SR);
  const sl = sliceOf(r.src, 0, SR * 2);
  it('integrates the pitch envelope exactly', () => {
    const p = { rate: 1, duration: 1, glideIn: { semis: -12, sec: 0.5 }, glideOut: { semis: -12, sec: 0.25 } };
    let num = 0;
    const N = 200000;
    for (let i = 0; i < N; i++) num += Math.pow(2, pitchEnvAt(p, (i + 0.5) / N) / 12) / N;
    expect(framesConsumed(p, SR, 1) / SR).toBeCloseTo(num, 5);
    expect(framesConsumed({ rate: 2, duration: 1 }, SR, 0.5)).toBe(SR);
  });
  it('renders a scoop: slower at first, then at pitch', () => {
    const e = ev({ length: 960, glideIn: [-12, 250] }); // half a second, first half scooping up an octave
    const [p] = plan([e], [sl], r.src);
    const out = renderSequence(seqWith({ bpm: BPM, bars: 1, events: [e], tracks: [track()] }), [sl], [r.src], new Map([['r', r.audio]]), { sampleRate: SR, clickFadeMs: 0, level: 'none', tail: 'cut' });
    const L = out.audio.channels[0];
    const posAt = (k: number) => (L[k] / P) * SR * 2; // ramp value → source frame
    expect(posAt(12000)).toBeCloseTo(framesConsumed(p, SR, 0.25), -1);
    expect(posAt(12000)).toBeLessThan(12000 * 0.8); // consumed less than at full speed
    expect(posAt(18000) - posAt(12000)).toBeCloseTo(6000, -1); // after the scoop: normal speed
  });
  it('a tape-stop fall never reads past the slice', () => {
    const short = sliceOf(r.src, 0, 4800);
    const [p] = plan([ev({ glideOut: [-24, 80] })], [short], r.src);
    expect(framesConsumed(p, SR, p.duration)).toBeLessThanOrEqual(4800);
    expect(p.duration).toBeGreaterThan(0.1); // slowing down makes the note last longer than 0.1 s
  });
});

describe('vowel mining', () => {
  it('finds the sung notes of the demo phrase with accurate pitch', () => {
    const a = demoVoice('sung-phrase');
    const v = findVowels(a);
    expect(v.length).toBeGreaterThanOrEqual(5);
    const pitches = v.map((x) => Math.round(x.pitch));
    for (const target of [69, 72, 71, 69]) expect(pitches.some((p) => Math.abs(p - target) <= 1)).toBe(true);
    for (const r of v) {
      expect(r.end - r.start).toBeGreaterThan(a.sampleRate * 0.07);
      const p = estimatePitch(a.channels[0].subarray(r.start, r.end), a.sampleRate);
      expect(p.confidence).toBeGreaterThan(0.8);
    }
  });
  it('ignores breaths and whispers', () => {
    const a = demoVoice('hum-whisper');
    const v = findVowels(a);
    expect(v.length).toBeGreaterThanOrEqual(3);
    expect(v.length).toBeLessThanOrEqual(6);
  });
});

describe('loop-sustain', () => {
  const tone = (hz: number, sec: number): AudioData => ({ sampleRate: SR, channels: [Float32Array.from({ length: SR * sec }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / SR) * Math.min(1, i / 480))] });
  it('extends a short tone to the requested length without clicks or pitch change', () => {
    const a = tone(220, 0.3);
    const out = sustainRegion(a, 0, a.channels[0].length, { seconds: 3 });
    const y = out.channels[0];
    expect(y.length).toBe(3 * SR);
    let maxJump = 0;
    for (let i = 1; i < y.length; i++) maxJump = Math.max(maxJump, Math.abs(y[i] - y[i - 1]));
    expect(maxJump).toBeLessThan(0.5 * 2 * Math.PI * 220 / SR * 1.5); // no step larger than the sine's own slope
    for (const at of [0.5, 1.5, 2.5]) {
      const p = estimatePitch(y.subarray(at * SR, at * SR + 4800), SR);
      expect(Math.abs(p.midi! - 57)).toBeLessThan(0.15);
    }
    let rms = 0;
    for (let i = SR; i < 2 * SR; i++) rms += y[i] * y[i];
    expect(Math.sqrt(rms / SR)).toBeGreaterThan(0.3); // level holds through the loop
    expect(Math.abs(y[y.length - 1])).toBeLessThan(0.01); // released
  });
  it('sustains a real vowel from the demo voice', () => {
    const a = demoVoice('sung-phrase');
    const v = findVowels(a).sort((x, y2) => y2.end - y2.start - (x.end - x.start))[0];
    expect(findLoop(a, v.start, v.end)).not.toBeNull();
    const out = sustainRegion(a, v.start, v.end, { seconds: 4 });
    const p = estimatePitch(out.channels[0].subarray(2 * a.sampleRate, 2 * a.sampleRate + 4410), a.sampleRate);
    expect(Math.abs(p.midi! - v.pitch)).toBeLessThan(0.4);
  });
  it('falls back to a plain copy when the region is too short to loop', () => {
    const a = tone(220, 0.03);
    const out = sustainRegion(a, 0, a.channels[0].length, { seconds: 1 });
    expect(out.channels[0].length).toBe(SR);
  });
});
