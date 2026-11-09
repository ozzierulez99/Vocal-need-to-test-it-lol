import { describe, it, expect } from 'vitest';
import { detectSoundRegions, detectOnsets, estimatePitch } from '../src/core/audio/analysis';
import { autoChop, makeSlice, splitSlice, mergeSlices, subdivide, suggestBoundaries, slicesFromBoundaries, MIN_SLICE_FRAMES } from '../src/core/slicing/slices';
import { demoVoice } from '../src/core/demo/synthVoice';
import { sourceFor } from './helpers';
import type { AudioData } from '../src/core/types';

const SR = 44100;
function bursts(times: [number, number][], total: number, freq = 220): AudioData {
  const x = new Float32Array(Math.round(total * SR));
  for (const [s, e] of times) for (let i = Math.round(s * SR); i < Math.round(e * SR); i++) x[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / SR);
  return { sampleRate: SR, channels: [x] };
}

describe('analysis', () => {
  it('finds sound regions separated by silence', () => {
    const a = bursts([[0.1, 0.4], [0.7, 0.9], [1.3, 1.6]], 2);
    const r = detectSoundRegions(a, { minSilenceMs: 100 });
    expect(r.length).toBe(3);
    expect(Math.abs(r[0].start / SR - 0.1)).toBeLessThan(0.02);
    expect(Math.abs(r[2].end / SR - 1.6)).toBeLessThan(0.03);
  });

  it('detects amplitude onsets', () => {
    const a = bursts([[0.2, 0.35], [0.5, 0.65], [0.8, 0.95]], 1.2);
    const on = detectOnsets(a, { sensitivity: 0.5 });
    expect(on.length).toBe(3);
    [0.2, 0.5, 0.8].forEach((t, i) => expect(Math.abs(on[i] / SR - t)).toBeLessThan(0.02));
  });

  it('estimates the pitch of a periodic tone', () => {
    const a = bursts([[0, 0.3]], 0.3, 220);
    const p = estimatePitch(a.channels[0], SR);
    expect(p.midi).not.toBeNull();
    expect(Math.abs(p.midi! - 57)).toBeLessThan(0.3); // A3
    const noise = Float32Array.from({ length: SR / 4 }, () => Math.random() * 2 - 1);
    expect(estimatePitch(noise, SR).confidence).toBeLessThan(0.55);
  });

  it('auto-chops a demo vocal into coexisting levels with analysis', () => {
    const a = demoVoice('sung-phrase');
    const { slices } = autoChop(sourceFor('s', a), a);
    const levels = new Set(slices.map((s) => s.level));
    expect(levels.has('phrase')).toBe(true);
    expect(levels.has('word')).toBe(true);
    const words = slices.filter((s) => s.level === 'word');
    expect(words.length).toBeGreaterThanOrEqual(5);
    expect(slices.every((s) => s.analysis && s.category)).toBe(true);
    const pitched = words.filter((w) => w.analysis!.pitch !== null);
    expect(pitched.length).toBeGreaterThanOrEqual(4);
    // first sung note is A4 (69)
    expect(Math.abs(words[0].analysis!.pitch! - 69)).toBeLessThan(1);
  });

  it('separates noisy and sustained material', () => {
    const a = demoVoice('hum-whisper');
    const { slices } = autoChop(sourceFor('h', a), a);
    const w = slices.filter((s) => s.level === 'word');
    expect(w.some((s) => s.category === 'sustained-vowel' || s.category === 'sung-note')).toBe(true);
    expect(w.some((s) => s.category === 'breath' || s.category === 'whisper')).toBe(true);
  });
});

describe('slice editing', () => {
  const a = bursts([[0, 1]], 1);
  const src = sourceFor('x', a);
  it('creates clamped, minimum-size slices', () => {
    const s = makeSlice(src, 500, -20, 'word');
    expect(s.start).toBe(0);
    expect(s.end).toBe(500);
    expect(makeSlice(src, 100, 100, 'word').end - 100).toBe(MIN_SLICE_FRAMES);
  });
  it('splits and merges', () => {
    const s = makeSlice(src, 0, 10000, 'word', { id: 'w' });
    const [l, r] = splitSlice(s, 4000)!;
    expect([l.start, l.end, r.start, r.end]).toEqual([0, 4000, 4000, 10000]);
    expect(l.id).toBe('w');
    expect(r.id).not.toBe('w');
    expect(splitSlice(s, 10)).toBeNull();
    const m = mergeSlices(r, l)!;
    expect([m.start, m.end]).toEqual([0, 10000]);
    expect(mergeSlices(l, { ...r, level: 'phrase' })).toBeNull();
  });
  it('subdivides into child slices while keeping the parent', () => {
    const p = makeSlice(src, 0, 30000, 'word', { id: 'p', name: 'W1' });
    const kids = subdivide(p, src, [10000, 20000, 5, 29990]);
    expect(kids.map((k) => [k.start, k.end])).toEqual([[0, 10000], [10000, 20000], [20000, 30000]]);
    expect(kids.every((k) => k.parentId === 'p' && k.level === 'syllable')).toBe(true);
  });
  it('suggests boundaries by interval, beat grid and rhythm', () => {
    expect(suggestBoundaries(a, 0, SR, { method: 'interval', intervalSec: 0.25 })).toEqual([11025, 22050, 33075]);
    expect(suggestBoundaries(a, 0, SR, { method: 'beat', bpm: 120, division: 1 })).toEqual([22050]);
    const r = suggestBoundaries(a, 0, SR, { method: 'rhythm', bpm: 120, pattern: [0.75, 0.75, 0.5] });
    expect(r[0]).toBe(Math.round(0.375 * SR));
    const sl = slicesFromBoundaries(src, 0, SR, [11025, 22050], 'sound');
    expect(sl.length).toBe(3);
    expect(sl[2].end).toBe(SR);
  });
  it('suggests silence and onset boundaries', () => {
    const b = bursts([[0.1, 0.3], [0.5, 0.7]], 1);
    const s = suggestBoundaries(b, 0, SR, { method: 'silence' });
    expect(s.length).toBe(4);
    const o = suggestBoundaries(b, 0, SR, { method: 'onset' });
    expect(o.length).toBe(2);
  });
});
