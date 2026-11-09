import { describe, it, expect } from 'vitest';
import { renderSequence } from '../src/core/audio/render';
import { buildPlan } from '../src/core/audio/plan';
import type { SeqEvent, Track } from '../src/core/types';
import { constSource, rampSource, seqWith, sliceOf } from './helpers';

const SR = 48000; // with 120 BPM one tick = 25 frames exactly
const BPM = 120;
const P = Math.SQRT1_2; // centre pan gain for mono sources

function ev(partial: Partial<SeqEvent>): SeqEvent {
  return { id: partial.id ?? 'e1', trackId: 'trk-lead', sliceId: 'sl1', tick: 0, length: 3840 * 4, offset: 0, gain: 0, semitones: 0, reverse: false, fadeIn: 0, fadeOut: 0, pan: 0, velocity: 0.8, locked: false, ...partial };
}
const track = (id = 'trk-lead', extra: Partial<Track> = {}): Track => ({ id, name: id, role: 'lead', mute: false, solo: false, gain: 0, pan: 0, locked: false, color: '#fff', ...extra });

function render(events: SeqEvent[], srcs: any[], slices: any[], opts: any = {}, tracks = [track()]) {
  const audio = new Map(srcs.map((s) => [s.src.id, s.audio]));
  return renderSequence(seqWith({ bpm: BPM, bars: opts.bars ?? 4, events, tracks }), slices, srcs.map((s) => s.src), audio, { sampleRate: SR, clickFadeMs: 0, level: 'none', tail: 'cut', ...opts });
}

describe('offline renderer', () => {
  it('places events sample-accurately', () => {
    const c = constSource('c', 4800, 0.5, SR);
    const r = render([ev({ tick: 960 })], [c], [sliceOf(c.src, 0, 4800)]);
    const L = r.audio.channels[0];
    expect(L[23999]).toBe(0);
    expect(L[24000]).toBeCloseTo(0.5 * P, 6);
    expect(L[28799]).toBeCloseTo(0.5 * P, 6);
    expect(L[28800]).toBe(0);
  });

  it('reads exactly the slice region', () => {
    const r0 = rampSource('r', SR, SR);
    const r = render([ev({})], [r0], [sliceOf(r0.src, 10000, 20000)]);
    const L = r.audio.channels[0];
    expect(L[0]).toBeCloseTo((10000 / SR) * P, 6);
    expect(L[9999]).toBeCloseTo((19999 / SR) * P, 6);
    expect(L[10000]).toBe(0);
  });

  it('honours slice offsets (microchops)', () => {
    const r0 = rampSource('r', SR, SR);
    const r = render([ev({ offset: 1000 })], [r0], [sliceOf(r0.src, 10000, 20000)]);
    expect(r.audio.channels[0][0]).toBeCloseTo((11000 / SR) * P, 6);
    expect(r.audio.channels[0][8999]).toBeCloseTo((19999 / SR) * P, 6);
    expect(r.audio.channels[0][9000]).toBe(0);
  });

  it('reverses slices', () => {
    const r0 = rampSource('r', SR, SR);
    const r = render([ev({ reverse: true })], [r0], [sliceOf(r0.src, 10000, 20000)]);
    const L = r.audio.channels[0];
    expect(L[0]).toBeCloseTo((19999 / SR) * P, 6);
    expect(L[9999]).toBeCloseTo((10000 / SR) * P, 6);
  });

  it('cuts playback at the gate length', () => {
    const c = constSource('c', SR, 0.5, SR);
    const r = render([ev({ length: 96 })], [c], [sliceOf(c.src, 0, SR)]); // 96 ticks = 2400 frames
    expect(r.audio.channels[0][2399]).toBeCloseTo(0.5 * P, 6);
    expect(r.audio.channels[0][2400]).toBe(0);
  });

  it('transposes by playback rate (pitch and duration change together)', () => {
    const r0 = rampSource('r', SR, SR);
    const r = render([ev({ semitones: 12 })], [r0], [sliceOf(r0.src, 10000, 20000)]);
    const L = r.audio.channels[0];
    expect(L[100]).toBeCloseTo(((10000 + 200) / SR) * P, 5);
    expect(L[4998]).toBeGreaterThan(0);
    expect(L[5001]).toBe(0);
    const plan = buildPlan(seqWith({ events: [ev({ semitones: -12 })], tracks: [track()] }), [sliceOf(r0.src, 10000, 20000)], [r0.src], { bpm: BPM, clickFadeMs: 0 });
    expect(plan[0].duration).toBeCloseTo(20000 / SR, 6);
  });

  it('applies event and track gain in dB', () => {
    const c = constSource('c', 4800, 0.5, SR);
    const r = render([ev({ gain: -6.0206 })], [c], [sliceOf(c.src, 0, 4800)], {}, [track('trk-lead', { gain: -6.0206 })]);
    expect(r.audio.channels[0][100]).toBeCloseTo(0.125 * P, 4);
  });

  it('applies linear fades and click-guard fades', () => {
    const c = constSource('c', 4800, 0.5, SR);
    const r = render([ev({ fadeIn: 10 })], [c], [sliceOf(c.src, 0, 4800)]);
    const L = r.audio.channels[0];
    expect(L[0]).toBe(0);
    expect(L[240]).toBeCloseTo(0.25 * P, 3);
    const g = render([ev({})], [c], [sliceOf(c.src, 0, 4800)], { clickFadeMs: 3 });
    const G = g.audio.channels[0];
    expect(G[0]).toBe(0);
    let maxJump = 0;
    for (let i = 1; i < 6000; i++) maxJump = Math.max(maxJump, Math.abs(G[i] - G[i - 1]));
    expect(maxJump).toBeLessThan(0.01); // no click at either boundary
  });

  it('sums overlapping and repeated events', () => {
    const c = constSource('c', 4800, 0.25, SR);
    const sl = sliceOf(c.src, 0, 4800);
    const r = render([ev({ id: 'a' }), ev({ id: 'b' }), ev({ id: 'c', tick: 96 })], [c], [sl]);
    expect(r.audio.channels[0][100]).toBeCloseTo(0.5 * P, 6);
    expect(r.audio.channels[0][2500]).toBeCloseTo(0.75 * P, 6);
    expect(r.eventCount).toBe(3);
  });

  it('renders very short slices', () => {
    const c = constSource('c', 1000, 0.5, SR);
    const r = render([ev({})], [c], [sliceOf(c.src, 100, 164)]);
    let n = 0;
    for (const v of r.audio.channels[0]) if (v !== 0) n++;
    expect(n).toBe(64);
  });

  it('handles stereo sources and panning', () => {
    const st = { src: { ...constSource('s', 4800, 0.5, SR, 2).src }, audio: { sampleRate: SR, channels: [new Float32Array(4800).fill(0.4), new Float32Array(4800).fill(0.2)] } };
    const r = render([ev({})], [st], [sliceOf(st.src, 0, 4800)]);
    expect(r.audio.channels[0][10]).toBeCloseTo(0.4, 6);
    expect(r.audio.channels[1][10]).toBeCloseTo(0.2, 6);
    const c = constSource('c', 4800, 0.5, SR);
    const left = render([ev({ pan: -1 })], [c], [sliceOf(c.src, 0, 4800)]);
    expect(left.audio.channels[0][10]).toBeCloseTo(0.5, 6);
    expect(left.audio.channels[1][10]).toBeCloseTo(0, 6);
  });

  it('resamples sources with a different sample rate', () => {
    const c = constSource('c', 2400, 0.5, 24000); // 0.1 s
    const r = render([ev({})], [c], [sliceOf(c.src, 0, 2400)]);
    let n = 0;
    for (const v of r.audio.channels[0]) if (v !== 0) n++;
    expect(Math.abs(n - 4800)).toBeLessThanOrEqual(1);
  });

  it('produces exact export durations', () => {
    const c = constSource('c', 480, 0.5, SR);
    const r = render([ev({})], [c], [sliceOf(c.src, 0, 480)], { bars: 2, sampleRate: 44100 });
    expect(r.audio.channels[0].length).toBe(4 * 44100); // 2 bars of 4/4 at 120 BPM = 4 s
    const range = render([ev({})], [c], [sliceOf(c.src, 0, 480)], { startTick: 3840, endTick: 3840 * 2 });
    expect(range.audio.channels[0].length).toBe(2 * SR);
  });

  it('prevents clipping and can normalise', () => {
    const c = constSource('c', 4800, 0.9, SR);
    const sl = sliceOf(c.src, 0, 4800);
    const evs = ['a', 'b', 'c', 'd'].map((id) => ev({ id }));
    const pc = render(evs, [c], [sl], { level: 'prevent-clip' });
    expect(pc.rawPeak).toBeGreaterThan(1);
    expect(pc.peak).toBeLessThanOrEqual(0.99);
    const nm = render([ev({ gain: -20 })], [c], [sl], { level: 'normalize' });
    expect(nm.peak).toBeCloseTo(Math.pow(10, -1 / 20), 5);
  });

  it('respects mute and solo', () => {
    const c = constSource('c', 4800, 0.5, SR);
    const sl = sliceOf(c.src, 0, 4800);
    const evs = [ev({ id: 'a', trackId: 't1' }), ev({ id: 'b', trackId: 't2', tick: 960 })];
    const muted = render(evs, [c], [sl], {}, [track('t1', { mute: true }), track('t2')]);
    expect(muted.eventCount).toBe(1);
    const solo = render(evs, [c], [sl], {}, [track('t1', { solo: true }), track('t2')]);
    expect(solo.eventCount).toBe(1);
    expect(solo.audio.channels[0][10]).not.toBe(0);
    const stem = render(evs, [c], [sl], { trackIds: ['t2'] }, [track('t1', { solo: true }), track('t2')]);
    expect(stem.audio.channels[0][10]).toBe(0);
    expect(stem.eventCount).toBe(1);
  });

  it('folds the tail back for loop-ready audio', () => {
    const c = constSource('c', SR, 0.5, SR);
    const sl = sliceOf(c.src, 0, SR);
    const r = render([ev({ tick: 3840 - 480 })], [c], [sl], { bars: 1, tail: 'wrap' }); // starts 0.25 s before the loop end, lasts 1 s
    expect(r.audio.channels[0].length).toBe(2 * SR);
    expect(r.audio.channels[0][100]).toBeCloseTo(0.5 * P, 6); // wrapped tail
    const keep = render([ev({ tick: 3840 - 480 })], [c], [sl], { bars: 1, tail: 'keep' });
    expect(keep.audio.channels[0].length).toBeGreaterThan(2 * SR);
  });

  it('skips events whose source is missing', () => {
    const c = constSource('c', 4800, 0.5, SR);
    const r = render([ev({})], [{ src: { ...c.src, missing: true }, audio: c.audio }], [sliceOf(c.src, 0, 4800)]);
    expect(r.eventCount).toBe(0);
  });

  it('applies a track filter', () => {
    const noise = { sampleRate: SR, channels: [Float32Array.from({ length: SR }, (_, i) => (i % 2 ? 0.5 : -0.5))] };
    const n = { src: { ...constSource('n', SR, 0, SR).src }, audio: noise };
    const r = render([ev({})], [n], [sliceOf(n.src, 0, SR)], {}, [track('trk-lead', { filter: { type: 'lowpass', frequency: 500 } })]);
    let pk = 0;
    for (let i = 2000; i < 40000; i++) pk = Math.max(pk, Math.abs(r.audio.channels[0][i]));
    expect(pk).toBeLessThan(0.01); // Nyquist tone removed by the lowpass
  });
});
