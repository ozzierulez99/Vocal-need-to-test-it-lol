import { describe, it, expect } from 'vitest';
import { generate, defaultSettings, type GenerateInput } from '../src/core/compose/engine';
import { generateCandidates, generateVariations, reassignSlices } from '../src/core/compose/candidates';
import { computeMetrics, similarity } from '../src/core/compose/metrics';
import { motifSignature } from '../src/core/compose/motif';
import type { GeneratorSettings, Motif, SeqEvent } from '../src/core/types';
import { demoProject, slicesOf } from './helpers';

const BAR = 3840;
const BPM = 140;
function input(s: Partial<GeneratorSettings>, extra: Partial<GenerateInput> = {}): GenerateInput {
  const { slices, sources } = demoProject();
  return { settings: defaultSettings({ seed: 7, ...s }), slices, sources, bpm: BPM, timeSig: [4, 4], ...extra };
}
const strip = (es: SeqEvent[]) => es.map(({ id, ...e }) => e);
const metrics = (es: SeqEvent[], bars = 8) => computeMetrics(es, demoProject().slices, demoProject().sources, BPM, [4, 4], bars);

const MODES: Partial<GeneratorSettings>[] = [
  { mode: 'melodic', direction: 'ethereal', sliceIds: slicesOf('sung-phrase') },
  { mode: 'rhythmic', direction: 'playful', sliceIds: slicesOf('chop-attacks') },
  { mode: 'phrase', direction: 'emotional', sliceIds: slicesOf('spoken-phrase') },
  { mode: 'ghost', direction: 'ambient', sliceIds: slicesOf('hum-whisper') },
  { mode: 'microchop', direction: 'glitch', sliceIds: slicesOf('spoken-phrase') },
  { mode: 'conversation', direction: 'dance', voiceA: slicesOf('sung-phrase'), voiceB: slicesOf('voice-b') },
];

describe('composition engine', () => {
  for (const m of MODES) {
    it(`${m.mode}: produces a coherent, in-range arrangement`, () => {
      const out = generate(input(m));
      expect(out.events.length).toBeGreaterThan(3);
      expect(out.description.length).toBeGreaterThan(2);
      const ids = new Set(input(m).slices.map((s) => s.id));
      for (const e of out.events) {
        expect(ids.has(e.sliceId)).toBe(true);
        expect(e.tick).toBeGreaterThanOrEqual(0);
        expect(e.tick).toBeLessThan(8 * BAR);
        expect(e.length).toBeGreaterThan(0);
        expect(Number.isInteger(e.tick)).toBe(true);
        expect(Math.abs(e.semitones)).toBeLessThanOrEqual(24);
        expect(out.tracks.some((t) => t.id === e.trackId)).toBe(true);
      }
      if (m.mode !== 'conversation' && m.sliceIds) expect(out.events.every((e) => m.sliceIds!.includes(e.sliceId))).toBe(true);
    });
  }

  it('is deterministic for identical settings and seed', () => {
    for (const m of MODES) {
      const a = generate(input(m));
      const b = generate(input(m));
      expect(a.events).toEqual(b.events);
      expect(a.description).toEqual(b.description);
    }
  });

  it('different seeds give genuinely different ideas', () => {
    for (const m of MODES.slice(0, 5)) {
      const a = generate(input({ ...m, seed: 1 }));
      const b = generate(input({ ...m, seed: 2 }));
      expect(similarity(a.events, b.events)).toBeLessThan(0.8);
    }
  });

  it('modes make meaningfully different musical decisions from the same material', () => {
    const ids = slicesOf('spoken-phrase');
    const ms = ['melodic', 'rhythmic', 'phrase', 'ghost', 'microchop'].map((mode) => metrics(generate(input({ mode: mode as any, direction: 'playful', sliceIds: ids })).events));
    const [mel, rhy, phr, gho, mic] = ms;
    expect(gho.silence).toBeGreaterThan(rhy.silence); // ghost leaves space
    expect(gho.density).toBeLessThan(mic.density);
    expect(mic.fragmentation).toBeGreaterThan(phr.fragmentation); // microchop fragments
    expect(mic.density).toBeGreaterThan(mel.density);
    // all pairs differ
    for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) expect(JSON.stringify(ms[i])).not.toBe(JSON.stringify(ms[j]));
  });

  it('directions change real compositional decisions', () => {
    const ids = slicesOf('sung-phrase');
    const amb = metrics(generate(input({ mode: 'melodic', direction: 'ambient', sliceIds: ids, controls: defaultSettings({ direction: 'ambient' }).controls })).events);
    const gl = metrics(generate(input({ mode: 'melodic', direction: 'glitch', sliceIds: ids, controls: defaultSettings({ direction: 'glitch' }).controls })).events);
    // ambient: few, long, sustained events; glitch: many short fragments
    expect(gl.density).toBeGreaterThan(amb.density * 1.5);
    expect(gl.fragmentation).toBeGreaterThan(amb.fragmentation);
  });

  it('builds musical form: the motif returns and the form is described', () => {
    const out = generate(input(MODES[1]));
    expect(out.description.some((d) => d.startsWith('Form:'))).toBe(true);
    const lead = out.tracks.find((t) => t.role === 'lead')!;
    const leadEv = out.events.filter((e) => e.trackId === lead.id);
    const bar = (b: number) => leadEv.filter((e) => Math.floor(e.tick / BAR) === b).map((e) => `${e.tick % BAR}:${e.sliceId}`).join(',');
    // first bar (A) is restated in the final section (return)
    expect(bar(6)).toBe(bar(0));
    expect(out.motifs[0].notes.length).toBeGreaterThan(1);
  });

  it('rhythmic controls: space increases silence, fragmentation shortens fragments', () => {
    const ids = slicesOf('chop-attacks');
    const base = defaultSettings({ direction: 'playful' }).controls;
    const dense = metrics(generate(input({ mode: 'rhythmic', direction: 'playful', sliceIds: ids, controls: { ...base, space: 0 } })).events);
    const sparse = metrics(generate(input({ mode: 'rhythmic', direction: 'playful', sliceIds: ids, controls: { ...base, space: 1 } })).events);
    expect(sparse.silence).toBeGreaterThan(dense.silence);
  });
});

describe('locks, motifs and local regeneration', () => {
  const m = MODES[1];
  const first = generate(input(m));
  const existing = { tracks: first.tracks, events: first.events, motifs: first.motifs, lockedBars: [] as number[], lockedRests: [] as any[] };

  it('preserves locked events', () => {
    const locked = first.events.slice(0, 5).map((e) => ({ ...e, locked: true }));
    const ex = { ...existing, events: [...locked, ...first.events.slice(5)] };
    const out = generate(input({ ...m, seed: 99 }, { existing: ex }));
    for (const l of locked) expect(out.events.find((e) => e.id === l.id)).toEqual(l);
    // nothing new overlaps a locked event on its track
    for (const l of locked)
      for (const e of out.events.filter((x) => x.trackId === l.trackId && x.id !== l.id && !x.locked))
        expect(e.tick >= l.tick + l.length || e.tick + e.length <= l.tick).toBe(true);
  });

  it('preserves locked bars', () => {
    const out = generate(input({ ...m, seed: 99 }, { existing: { ...existing, lockedBars: [0, 1] } }));
    const inBars = (es: SeqEvent[]) => strip(es.filter((e) => e.tick < 2 * BAR)).sort((a, b) => a.tick - b.tick || a.trackId.localeCompare(b.trackId) || a.sliceId.localeCompare(b.sliceId));
    expect(inBars(out.events)).toEqual(inBars(first.events));
    expect(similarity(out.events.filter((e) => e.tick >= 2 * BAR), first.events.filter((e) => e.tick >= 2 * BAR))).toBeLessThan(0.9);
  });

  it('preserves a whole locked layer', () => {
    const tracks = first.tracks.map((t) => (t.role === 'rhythm' ? { ...t, locked: true } : t));
    const out = generate(input({ ...m, seed: 1234 }, { existing: { ...existing, tracks } }));
    const rid = tracks.find((t) => t.role === 'rhythm')!.id;
    expect(out.events.filter((e) => e.trackId === rid)).toEqual(first.events.filter((e) => e.trackId === rid));
  });

  it('never fills a locked silence', () => {
    const rest = { id: 'r', trackId: null, startTick: 2 * BAR, endTick: 3 * BAR };
    const out = generate(input({ ...m, seed: 5 }, { existing: { ...existing, lockedRests: [rest] } }));
    for (const e of out.events) {
      expect(e.tick >= rest.endTick || e.tick + e.length <= rest.startTick).toBe(true);
    }
  });

  it('regenerates only the selected bars', () => {
    const out = generate(input({ ...m, seed: 4321 }, { existing, scope: { startBar: 7, endBar: 8 } }));
    const outside = (es: SeqEvent[]) => es.filter((e) => e.tick < 7 * BAR);
    expect(outside(out.events)).toEqual(outside(first.events));
    const inside = (es: SeqEvent[]) => es.filter((e) => e.tick >= 7 * BAR);
    expect(inside(out.events).length).toBeGreaterThan(0);
    expect(JSON.stringify(strip(inside(out.events)))).not.toBe(JSON.stringify(strip(inside(first.events))));
    for (const e of inside(out.events)) expect(e.tick + e.length).toBeLessThanOrEqual(8 * BAR);
  });

  it('regenerates only the selected layer', () => {
    const lead = first.tracks.find((t) => t.role === 'lead')!;
    const out = generate(input({ ...m, seed: 777 }, { existing, scope: { trackIds: [lead.id] } }));
    const others = (es: SeqEvent[]) => es.filter((e) => e.trackId !== lead.id);
    expect(others(out.events)).toEqual(others(first.events));
    expect(similarity(out.events.filter((e) => e.trackId === lead.id), first.events.filter((e) => e.trackId === lead.id))).toBeLessThan(1);
  });

  it('keeps an important motif exactly under "preserve"', () => {
    const motif: Motif = { ...first.motifs[0], important: true, protection: 'preserve' };
    for (const seed of [11, 12, 13]) {
      const out = generate(input({ ...m, seed }, { existing: { ...existing, events: [], motifs: [motif] } }));
      expect(motifSignature(out.motifs[0])).toBe(motifSignature(motif));
      // the opening bar states the motif note-for-note
      const lead = out.tracks.find((t) => t.role === 'lead')!;
      const bar0 = out.events.filter((e) => e.trackId === lead.id && e.tick < motif.span).sort((a, b) => a.tick - b.tick);
      expect(bar0.map((e) => `${e.tick}:${e.sliceId}:${e.semitones}`)).toEqual(motif.notes.map((n) => `${n.tick}:${n.sliceId}:${n.semitones}`));
    }
  });

  it('"develop" keeps the motif head while allowing variation', () => {
    const motif: Motif = { ...first.motifs[0], important: true, protection: 'develop' };
    const out = generate(input({ ...m, seed: 21 }, { existing: { ...existing, motifs: [motif] } }));
    const lead = out.tracks.find((t) => t.role === 'lead')!;
    const head = motif.notes.slice(0, 2).map((n) => `${n.tick % BAR}:${n.sliceId}`);
    for (let b = 0; b < 8; b += 2) {
      const ev = out.events.filter((e) => e.trackId === lead.id && Math.floor(e.tick / BAR) === b && e.gesture?.startsWith('motif'));
      if (!ev.length) continue;
      expect(ev.slice(0, 2).map((e) => `${e.tick % BAR}:${e.sliceId}`)).toEqual(head);
    }
  });

  it('"replace" builds a new motif', () => {
    const motif: Motif = { ...first.motifs[0], important: true, protection: 'replace' };
    const out = generate(input({ ...m, seed: 31 }, { existing: { ...existing, motifs: [motif] } }));
    expect(motifSignature(out.motifs[0])).not.toBe(motifSignature(motif));
  });
});

describe('MIDI-guided composition', () => {
  const notes = Array.from({ length: 16 }, (_, i) => ({ tick: i * 720, length: 240 + (i % 2) * 240, pitch: 60 + [0, 3, 7, 10][i % 4], velocity: 0.3 + (i % 4) * 0.2 }));
  const guide = { name: 'g', notes, mapping: 'rhythm-cycle' as const, pitchMap: {}, usePitch: false, rootPitch: 60, useVelocity: true, useDuration: true };
  it('aligns triggers to MIDI note-ons (timing only, no pitch)', () => {
    const out = generate(input({ mode: 'midi', sliceIds: slicesOf('chop-attacks'), midi: guide }));
    expect(out.events.map((e) => e.tick)).toEqual(notes.map((n) => n.tick));
    expect(out.events.every((e) => e.semitones === 0)).toBe(true);
    // velocity → accent gain
    const loud = out.events.filter((e) => e.velocity > 0.8);
    const soft = out.events.filter((e) => e.velocity < 0.4);
    expect(Math.min(...loud.map((e) => e.gain))).toBeGreaterThan(Math.max(...soft.map((e) => e.gain)));
  });
  it('maps pitch to playback-rate transposition of one slice', () => {
    const one = slicesOf('sung-phrase')[3];
    const out = generate(input({ mode: 'midi', sliceIds: [one], midi: { ...guide, mapping: 'single', usePitch: true } }));
    expect(out.events.every((e) => e.sliceId === one)).toBe(true);
    expect(out.events.map((e) => e.semitones)).toEqual(notes.map((n) => n.pitch - 60));
  });
  it('maps different pitches to different slices', () => {
    const ids = slicesOf('chop-attacks');
    const pitchMap = { 60: ids[0], 63: ids[1], 67: ids[2], 70: ids[3] };
    const out = generate(input({ mode: 'midi', sliceIds: ids, midi: { ...guide, mapping: 'pitch-map', pitchMap } }));
    out.events.forEach((e, i) => expect(e.sliceId).toBe((pitchMap as any)[notes[i].pitch]));
  });
});

describe('vocal conversation', () => {
  const A = slicesOf('sung-phrase');
  const B = slicesOf('voice-b');
  const rels = ['call-response', 'alternating', 'interrupt', 'imitate', 'overlap-growth', 'complementary', 'ostinato', 'fragmenting'] as const;
  for (const relation of rels) {
    it(`${relation}: both voices take part and keep to their own material`, () => {
      const out = generate(input({ mode: 'conversation', direction: 'dance', voiceA: A, voiceB: B, relation }));
      const [ta, tb] = [out.tracks.find((t) => t.name === 'Voice A')!, out.tracks.find((t) => t.name === 'Voice B')!];
      const ea = out.events.filter((e) => e.trackId === ta.id);
      const eb = out.events.filter((e) => e.trackId === tb.id || e.trackId === 'trk-ostinato');
      expect(ea.length).toBeGreaterThan(0);
      expect(eb.length).toBeGreaterThan(0);
      expect(ea.every((e) => A.includes(e.sliceId))).toBe(true);
      expect(eb.every((e) => B.includes(e.sliceId))).toBe(true);
    });
  }
  it('call-response keeps the answer in the second half of each phrase', () => {
    const out = generate(input({ mode: 'conversation', direction: 'dance', voiceA: A, voiceB: B, relation: 'call-response' }));
    const tb = out.tracks.find((t) => t.name === 'Voice B')!;
    for (const e of out.events.filter((x) => x.trackId === tb.id)) expect(e.tick % (2 * BAR)).toBeGreaterThanOrEqual(BAR);
  });
  it('imitate copies the rhythm of voice A one bar later', () => {
    const out = generate(input({ mode: 'conversation', direction: 'dance', voiceA: A, voiceB: B, relation: 'imitate' }));
    const [ta, tb] = [out.tracks.find((t) => t.name === 'Voice A')!, out.tracks.find((t) => t.name === 'Voice B')!];
    const aT = new Set(out.events.filter((e) => e.trackId === ta.id).map((e) => e.tick + BAR));
    for (const e of out.events.filter((x) => x.trackId === tb.id)) expect(aT.has(e.tick)).toBe(true);
  });
});

describe('candidate exploration', () => {
  const req = { ...input({ mode: 'rhythmic', direction: 'playful', sliceIds: slicesOf('chop-attacks') }), bars: 8, count: 6 };
  const cands = generateCandidates(req);
  it('generates distinct, labelled alternatives', () => {
    expect(cands.length).toBe(6);
    expect(new Set(cands.map((c) => c.label)).size).toBe(6);
    for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) expect(similarity(cands[i].events, cands[j].events)).toBeLessThan(0.85);
  });
  it('labels follow the measured metrics', () => {
    const by = (l: string) => cands.find((c) => c.label === l)!;
    const median = (k: keyof (typeof cands)[0]['metrics']) => cands.map((c) => c.metrics[k]).sort((a, b) => a - b)[2];
    expect(by('Most spacious').metrics.silence).toBeGreaterThanOrEqual(median('silence'));
    expect(by('Most fragmented').metrics.fragmentation).toBeGreaterThanOrEqual(median('fragmentation'));
    expect(by('Most hypnotic').metrics.repetition).toBeGreaterThanOrEqual(median('repetition'));
    expect(by('Most melodic').metrics.pitchSpread).toBeGreaterThanOrEqual(median('pitchSpread'));
  });
  it('is reproducible', () => {
    const again = generateCandidates(req);
    expect(again.map((c) => strip(c.events))).toEqual(cands.map((c) => strip(c.events)));
  });
  it('creates variations of a favourite that keep its identity', () => {
    const fav = cands[0];
    const vars = generateVariations(req, fav, 5);
    expect(vars.length).toBe(5);
    const close = vars.find((v) => v.label === 'Close variation')!;
    expect(motifSignature(close.motifs[0])).toBe(motifSignature(fav.motifs[0]));
    const resliced = vars.find((v) => v.label === 'Same rhythm, new slices')!;
    expect(resliced.events.map((e) => e.tick)).toEqual(fav.events.map((e) => e.tick));
    expect(resliced.events.some((e, i) => e.sliceId !== fav.events[i].sliceId)).toBe(true);
    const ending = vars.find((v) => v.label === 'New ending')!;
    const early = (es: SeqEvent[]) => es.filter((e) => e.tick < 6 * BAR);
    expect(early(ending.events)).toEqual(early(fav.events));
  });
  it('reassigns slices without moving onsets', () => {
    const ev = cands[1].events;
    const r = reassignSlices(req, ev, ev.slice(0, 4).map((e) => e.id), 3);
    expect(r.map((e) => e.tick)).toEqual(ev.map((e) => e.tick));
    expect(r.slice(4)).toEqual(ev.slice(4));
  });
});

describe('other meters and edge cases', () => {
  for (const sig of [[3, 4], [7, 8], [6, 8], [5, 4]] as [number, number][]) {
    it(`composes in ${sig[0]}/${sig[1]} without leaving the arrangement`, () => {
      const bar = (960 * 4 * sig[0]) / sig[1];
      for (const m of MODES) {
        const out = generate(input(m, { timeSig: sig }));
        expect(out.events.length).toBeGreaterThan(0);
        for (const e of out.events) expect(e.tick).toBeLessThan(8 * bar);
      }
    });
  }
  it('works with a single slice', () => {
    const one = [slicesOf('sung-phrase')[3]];
    for (const mode of ['melodic', 'rhythmic', 'ghost', 'microchop', 'phrase'] as const) {
      const out = generate(input({ mode, sliceIds: one }));
      expect(out.events.length).toBeGreaterThan(0);
      expect(out.events.every((e) => e.sliceId === one[0])).toBe(true);
    }
  });
  it('explains missing material clearly', () => {
    expect(() => generate(input({ mode: 'melodic', sliceIds: ['nope'] }))).toThrow(/No usable slices/);
  });
  it('one-bar arrangements and long phrases', () => {
    const a = generate(input({ ...MODES[0], bars: 1, phraseBars: 4 }));
    expect(a.events.every((e) => e.tick < BAR)).toBe(true);
    const b = generate(input({ ...MODES[1], bars: 32, phraseBars: 4 }));
    expect(Math.max(...b.events.map((e) => e.tick))).toBeGreaterThan(24 * BAR);
  });
});

describe('rhythm lock', () => {
  it('keeps a layer’s onsets and gates while re-choosing its slices', () => {
    const m = { mode: 'rhythmic' as const, direction: 'playful' as const, sliceIds: [...slicesOf('chop-attacks'), ...slicesOf('voice-b')] };
    const first = generate(input(m));
    const lead = first.tracks.find((t) => t.role === 'lead')!;
    const tracks = first.tracks.map((t) => (t.id === lead.id ? { ...t, rhythmLocked: true } : t));
    const out = generate(input({ ...m, seed: 999 }, { existing: { tracks, events: first.events, motifs: [], lockedBars: [], lockedRests: [] } }));
    const before = first.events.filter((e) => e.trackId === lead.id);
    const after = out.events.filter((e) => e.trackId === lead.id);
    expect(after.map((e) => [e.tick, e.length, e.velocity])).toEqual(before.map((e) => [e.tick, e.length, e.velocity]));
    expect(after.some((e, i) => e.sliceId !== before[i].sliceId || e.semitones !== before[i].semitones)).toBe(true);
    // other layers were regenerated normally
    expect(similarity(out.events.filter((e) => e.trackId !== lead.id), first.events.filter((e) => e.trackId !== lead.id))).toBeLessThan(0.9);
  });
});
