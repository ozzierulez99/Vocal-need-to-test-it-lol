import { describe, it, expect } from 'vitest';
import { generate, defaultSettings } from '../src/core/compose/engine';
import { swapChop, shuffleChops, transposeIdea, similarChops, pitchShiftBetween } from '../src/core/compose/ideaEdit';
import { detectVocalKey } from '../src/core/compose/vocalKey';
import { slicePitch } from '../src/core/slicing/slices';
import type { Slice, SourceAudio } from '../src/core/types';
import { demoProject, slicesOf } from './helpers';

const { slices, sources } = demoProject();
const pitchOf = (id: string) => {
  const s = slices.find((x) => x.id === id)!;
  return slicePitch(s, sources.find((x) => x.id === s.sourceId));
};
const out = generate({ settings: defaultSettings({ seed: 5, mode: 'melodic', direction: 'drain', sliceIds: slicesOf('sung-phrase') }), slices, sources, bpm: 140, timeSig: [4, 4] });

describe('swapping chops in an idea', () => {
  const pitchedUsed = Array.from(new Set(out.events.map((e) => e.sliceId))).filter((id) => pitchOf(id) !== null);
  const from = slices.find((s) => s.id === pitchedUsed[0])!;
  const to = similarChops(from, slices, sources).find((s) => pitchOf(s.id) !== null && Math.abs(pitchOf(s.id)! - pitchOf(from.id)!) > 0.5)!;
  const swapped = swapChop(out.events, from.id, to.id, slices, sources);
  it('replaces every use of the chop and nothing else', () => {
    expect(swapped.some((e) => e.sliceId === from.id)).toBe(false);
    expect(swapped.filter((e) => e.sliceId === to.id).length).toBe(out.events.filter((e) => e.sliceId === from.id).length + out.events.filter((e) => e.sliceId === to.id).length);
    out.events.forEach((e, i) => {
      if (e.sliceId !== from.id) expect(swapped[i]).toBe(e);
    });
  });
  it('keeps the rhythm and the melody (same pitch class)', () => {
    out.events.forEach((e, i) => {
      if (e.sliceId !== from.id) return;
      const s = swapped[i];
      expect([s.tick, s.length]).toEqual([e.tick, e.length]);
      const before = pitchOf(from.id)! + e.semitones;
      const after = pitchOf(to.id)! + s.semitones;
      const d = (((Math.round(after - before) % 12) + 12) % 12);
      expect(d).toBe(0);
      // the exact same pitch when the two chops are sung within an octave of each other
      if (Math.abs(pitchOf(from.id)! - pitchOf(to.id)!) <= 12) expect(Math.abs(after - before)).toBeLessThan(0.01);
    });
  });
  it('never retunes a chop by more than an octave', () => {
    for (const t of slices.slice(0, 60)) {
      const d = pitchShiftBetween(from, t, sources);
      if (d !== null) expect(Math.abs(d)).toBeLessThanOrEqual(12);
    }
  });
  it('similar chops prefer the same kind of sound', () => {
    const breathy = slices.find((s) => s.sourceId === 'hum-whisper' && pitchOf(s.id) === null && s.level !== 'phrase')!;
    const top = similarChops(breathy, slices, sources).slice(0, 5);
    expect(top.filter((s) => pitchOf(s.id) === null).length).toBeGreaterThanOrEqual(3);
  });
});

describe('shuffle and transpose', () => {
  it('shuffle changes the chops but not the rhythm, and is seeded', () => {
    const a = shuffleChops(out.events, slices, sources, 1);
    const b = shuffleChops(out.events, slices, sources, 1);
    expect(a).toEqual(b);
    expect(a.map((e) => [e.tick, e.length, e.trackId])).toEqual(out.events.map((e) => [e.tick, e.length, e.trackId]));
    const changed = a.filter((e, i) => e.sliceId !== out.events[i].sliceId).length;
    expect(changed).toBeGreaterThan(out.events.length / 2);
  });
  it('transposes the whole idea', () => {
    const t = transposeIdea(out.events, 12);
    t.forEach((e, i) => expect(e.semitones).toBe(Math.min(36, out.events[i].semitones + 12)));
  });
});

describe('vocal key detection', () => {
  const src: SourceAudio = { id: 'k', name: 'k', assetName: 'k.wav', kind: 'import', sampleRate: 44100, channelCount: 1, frames: 44100 * 20, createdAt: 0 };
  const mk = (pitch: number, i: number, dur = 0.4): Slice => ({ id: `n${i}`, sourceId: 'k', name: `n${i}`, level: 'syllable', start: i * 20000, end: i * 20000 + Math.round(dur * 44100), tags: [], favourite: false, analysis: { pitch, pitchConfidence: 0.9, attack: 0.3, sustain: 0.7, noisiness: 0.1, intensity: 0.7, rms: 0.2, peak: 0.6 } as any });
  it('finds C major from a C major melody', () => {
    const mel = [60, 62, 64, 65, 67, 64, 60, 67, 72, 71, 67, 65, 64, 62, 60];
    const k = detectVocalKey(mel.map((p, i) => mk(p, i)), [src])!;
    expect([k.root, k.scale]).toEqual([0, 'major']);
  });
  it('finds A minor from an A minor melody', () => {
    const mel = [69, 72, 76, 74, 72, 71, 69, 64, 69, 72, 69, 67, 65, 64, 69];
    const k = detectVocalKey(mel.map((p, i) => mk(p, i, i === 0 || i === mel.length - 1 ? 1.2 : 0.4)), [src])!;
    expect([k.root, k.scale.includes('minor') || k.scale === 'dorian' || k.scale === 'phrygian']).toEqual([9, true]);
  });
  it('returns null without pitched material', () => {
    expect(detectVocalKey(slices.filter((s) => s.sourceId === 'hum-whisper' && pitchOf(s.id) === null), sources)).toBeNull();
  });
});
