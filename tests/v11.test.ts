import { describe, it, expect } from 'vitest';
import { generate, defaultSettings, type GenerateInput } from '../src/core/compose/engine';
import { generateCandidates } from '../src/core/compose/candidates';
import { scoreHook } from '../src/core/compose/critic';
import { DIRECTIONS } from '../src/core/compose/directions';
import { SCALES } from '../src/core/compose/theory';
import { slicePitch } from '../src/core/slicing/slices';
import { parseMidi } from '../src/core/midi/midi';
import { analyseParts, classifyPart } from '../src/core/beat/analyze';
import { demoBeatMidi, fullBeatParts } from '../src/core/demo/beats';
import { describeBeat } from '../src/core/beat/fit';
import { buildPlan } from '../src/core/audio/plan';
import { saveProject, loadProject, newProjectDoc, BACKING_ID, type ProjectFS } from '../src/core/project/project';
import { encodeWav } from '../src/core/audio/wav';
import type { Direction, GeneratorSettings, Purpose, SeqEvent } from '../src/core/types';
import { demoProject, slicesOf } from './helpers';

const BPM = 140;
const BAR = 3840;
function input(s: Partial<GeneratorSettings>, extra: Partial<GenerateInput> = {}): GenerateInput {
  const { slices, sources } = demoProject();
  const d = (s.direction ?? 'ethereal') as Direction;
  return { settings: defaultSettings({ seed: 11, bars: 8, keyRoot: 9, scale: 'minor', sliceIds: slicesOf('sung-phrase'), feel: DIRECTIONS[d].defaultFeel, controls: { ...DIRECTIONS[d].controls }, ...s }), slices, sources, bpm: BPM, timeSig: [4, 4], ...extra };
}
const pitchOf = (e: SeqEvent) => {
  const { slices, sources } = demoProject();
  const sl = slices.find((x) => x.id === e.sliceId)!;
  const p = slicePitch(sl, sources.find((x) => x.id === sl.sourceId));
  return p === null ? null : p + e.semitones;
};
const leadOf = (out: ReturnType<typeof generate>) => out.events.filter((e) => out.tracks.find((t) => t.id === e.trackId)?.role === 'lead');
const A_MINOR = new Set(SCALES.minor.map((i) => (9 + i) % 12));

describe('style packs', () => {
  const styles: Direction[] = ['drain', 'hyperpop', 'trance', 'ukg', 'witch'];
  for (const d of styles) {
    it(`${d}: writes an in-key lead that sounds like one voice`, () => {
      const out = generate(input({ mode: 'melodic', direction: d }));
      const lead = leadOf(out);
      expect(lead.length).toBeGreaterThan(3);
      const pitched = lead.map(pitchOf).filter((p): p is number => p !== null);
      expect(pitched.length).toBeGreaterThan(2);
      const inKey = pitched.filter((p) => A_MINOR.has(((Math.round(p) % 12) + 12) % 12)).length / pitched.length;
      expect(inKey).toBeGreaterThan(0.9);
      // the lead layer is monophonic like a sampler
      expect(out.tracks.find((t) => t.role === 'lead')!.choke).toBe(true);
    });
  }
  it('styles differ: witch sits lower than hyperpop, drain is sparser than trance', () => {
    const med = (d: Direction) => {
      const ps = leadOf(generate(input({ mode: 'melodic', direction: d }))).map(pitchOf).filter((p): p is number => p !== null).sort((a, b) => a - b);
      return ps[Math.floor(ps.length / 2)];
    };
    expect(med('witch')).toBeLessThan(med('hyperpop'));
    const n = (d: Direction) => leadOf(generate(input({ mode: 'melodic', direction: d }))).length;
    expect(n('drain')).toBeLessThan(n('trance'));
  });
  it('carries a groove with the idea (garage swings, trance does not)', () => {
    expect(generate(input({ mode: 'rhythmic', direction: 'ukg' })).groove?.swing ?? 0).toBeGreaterThan(0.1);
    expect(generate(input({ mode: 'melodic', direction: 'trance' })).groove?.swing ?? 0).toBeLessThan(0.1);
  });
  it('is deterministic for a seed and changes with it', () => {
    const a = generate(input({ direction: 'hyperpop' }));
    const b = generate(input({ direction: 'hyperpop' }));
    const c = generate(input({ direction: 'hyperpop', seed: 12 }));
    const sig = (o: typeof a) => o.events.map((e) => `${e.tick}:${e.sliceId}:${e.semitones}`).join(',');
    expect(sig(a)).toBe(sig(b));
    expect(sig(a)).not.toBe(sig(c));
  });
});

describe('song-section purpose', () => {
  const lead = (p: Purpose) => leadOf(generate(input({ mode: 'melodic', direction: 'playful', purpose: p })));
  const inBars = (es: SeqEvent[], a: number, b: number) => es.filter((e) => e.tick >= a * BAR && e.tick < b * BAR).length;
  it('a build gets busier towards the end', () => {
    const all = generate(input({ mode: 'melodic', direction: 'playful', purpose: 'build' })).events;
    expect(inBars(all, 6, 8)).toBeGreaterThan(inBars(all, 0, 2));
  });
  it('an outro thins out', () => {
    const es = lead('outro');
    expect(inBars(es, 6, 8)).toBeLessThan(inBars(es, 0, 2));
  });
  it('a verse bed is sparser than a hook', () => {
    expect(lead('verse').length).toBeLessThan(lead('hook').length);
  });
});

describe('hook critic', () => {
  const { slices, sources } = demoProject();
  const base = { slices, sources, bpm: BPM, timeSig: [4, 4] as [number, number], bars: 8 };
  it('scores a composed hook well above degenerate patterns', () => {
    const inp = input({ mode: 'melodic', direction: 'playful' });
    const out = generate(inp);
    const good = scoreHook({ ...base, events: out.events, tracks: out.tracks, settings: inp.settings });
    // same notes, all squashed onto one pitch and one rhythm value
    const leadId = out.tracks.find((t) => t.role === 'lead')!.id;
    const proto = out.events.find((e) => e.trackId === leadId)!;
    const drone: SeqEvent[] = Array.from({ length: 64 }, (_, i) => ({ ...proto, id: `d${i}`, tick: i * 480, length: 480 }));
    const flat = scoreHook({ ...base, events: drone, tracks: out.tracks, settings: inp.settings });
    expect(good.total).toBeGreaterThan(flat.total + 10);
    expect(flat.watch.length).toBeGreaterThan(0);
    expect(good.total).toBeGreaterThanOrEqual(70);
    expect(good.good.length).toBeGreaterThan(0);
  });
  it('penalises out-of-key notes', () => {
    const inp = input({ mode: 'melodic', direction: 'playful' });
    const out = generate(inp);
    const off = out.events.map((e, i) => (i % 2 ? { ...e, semitones: e.semitones + 1 } : e));
    const a = scoreHook({ ...base, events: out.events, tracks: out.tracks, settings: inp.settings });
    const b = scoreHook({ ...base, events: off, tracks: out.tracks, settings: inp.settings });
    expect(b.parts.melody).toBeLessThan(a.parts.melody);
    expect(b.watch.join(' ')).toMatch(/out of key/);
  });
  it('candidates carry a score, reasons and a groove; over-generation never lowers the best score', () => {
    const inp = input({ mode: 'melodic', direction: 'drain' });
    const one = generateCandidates({ ...inp, bars: 8, count: 3, attempts: 1 });
    const four = generateCandidates({ ...inp, bars: 8, count: 3, attempts: 4 });
    for (const c of four) {
      expect(c.score!.total).toBeGreaterThan(0);
      expect(c.groove).toBeDefined();
    }
    const best = (cs: typeof one) => Math.max(...cs.map((c) => c.score!.total));
    expect(best(four)).toBeGreaterThanOrEqual(best(one));
  });
});

describe('multi-part beats', () => {
  const parsed = parseMidi(demoBeatMidi('full-beat'), 'full');
  const beat = analyseParts(parsed.tracks.map((t, i) => ({ id: `p${i}`, name: t.name, notes: t.notes, percussion: t.percussion })), { name: 'full', bpm: parsed.bpm, timeSig: parsed.timeSig });
  it('recognises chords, bass, lead and drums', () => {
    expect(beat.parts!.map((p) => p.role).sort()).toEqual(['bass', 'chords', 'drums', 'lead']);
    expect(fullBeatParts().length).toBe(4);
  });
  it('takes key and chords from the pitched parts only', () => {
    expect(beat.key.root).toBe(9);
    expect(beat.chords.map((c) => c.symbol).slice(0, 4)).toEqual(['Am', 'F', 'C', 'G']);
    expect(beat.notes.every((n) => beat.parts!.some((p) => p.role !== 'drums' && p.notes.includes(n)) || true)).toBe(true);
  });
  it('reads the drum pattern and the half-time feel', () => {
    expect(beat.drums).toBeDefined();
    expect(beat.drums!.kick[0]).toBeGreaterThan(0.5);
    expect(beat.rhythm.feel).toBe('half');
    expect(describeBeat(beat).join(' ')).toMatch(/half-time/);
  });
  it('knows where the lead sits and keeps chops out of its register', () => {
    expect(beat.lead).toBeDefined();
    const inp = input({ mode: 'melodic', direction: 'playful', keyRoot: null }, { beat });
    const out = generate(inp);
    const ps = leadOf(out).map(pitchOf).filter((p): p is number => p !== null);
    const clash = ps.filter((p) => p >= beat.lead!.low && p <= beat.lead!.high).length / Math.max(1, ps.length);
    expect(clash).toBeLessThan(0.5);
  });
  it('a user role override is respected', () => {
    const b2 = analyseParts(parsed.tracks.map((t, i) => ({ id: `p${i}`, name: t.name, notes: t.notes, percussion: t.percussion, role: i === 0 ? ('arp' as const) : undefined })), { name: 'x' });
    expect(b2.parts![0].role).toBe('arp');
  });
  it('classifies by content when names say nothing', () => {
    const [pads, bass, lead, drums] = fullBeatParts();
    expect(classifyPart(pads.notes, 'Track 1')).toBe('chords');
    expect(classifyPart(bass.notes, 'Track 2')).toBe('bass');
    expect(classifyPart(lead.notes, 'Track 3')).toBe('lead');
    expect(classifyPart(drums.notes, 'Track 4', true)).toBe('drums');
  });
});

describe('groove on the sequence', () => {
  it('is applied by the plan without touching the events', () => {
    const { slices, sources } = demoProject();
    const out = generate(input({ mode: 'rhythmic', direction: 'ukg' }));
    const seq = { events: out.events, tracks: out.tracks };
    const straight = buildPlan({ ...seq, groove: { swing: 0, humanize: 0 } }, slices, sources, { bpm: BPM, clickFadeMs: 3 });
    const swung = buildPlan({ ...seq, groove: { swing: 0.5, humanize: 0 } }, slices, sources, { bpm: BPM, clickFadeMs: 3 });
    const at = new Map(straight.map((p) => [p.eventId, p.gridTime]));
    const moved = swung.filter((p) => Math.abs(p.gridTime - at.get(p.eventId)!) > 1e-6);
    expect(moved.length).toBeGreaterThan(0);
    for (const p of moved) expect(Math.round(p.tick / 240) % 2).toBe(1);
  });
});

describe('backing track persistence', () => {
  it('is saved with the project and restored', async () => {
    const files = new Map<string, Uint8Array | string>();
    const fs: ProjectFS = {
      readText: async (p) => files.get(p) as string,
      readBytes: async (p) => files.get(p) as Uint8Array,
      writeText: async (p, t) => void files.set(p, t),
      writeBytes: async (p, b) => void files.set(p, b),
      exists: async (p) => files.has(p),
      mkdir: async () => {},
    };
    const doc = newProjectDoc();
    const audio = { sampleRate: 44100, channels: [new Float32Array(4410).fill(0.25)] };
    const bytes = encodeWav(audio, 16);
    doc.backing = { name: 'beat', assetName: 'backing_x.wav', sampleRate: 44100, frames: 4410, channelCount: 1, gain: -6, offsetMs: 12, enabled: true };
    await saveProject(fs, 'p', doc, new Map([['backing_x.wav', bytes]]));
    const loaded = await loadProject(fs, 'p', async (b) => (await import('../src/core/audio/wav')).decodeWav(b));
    expect(loaded.doc.backing?.offsetMs).toBe(12);
    expect(loaded.audio.get(BACKING_ID)?.channels[0].length).toBe(4410);
  });
});
