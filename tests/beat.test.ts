import { describe, it, expect } from 'vitest';
import { analyseBeat, keyName, detectChord, pcWeights } from '../src/core/beat/analyze';
import { chordAt, effectiveKey, fitHits, vocalKeyFit, beatRecipes, describeBeat, arrangementBarsFor, harmonize } from '../src/core/beat/fit';
import { padProgression, arpProgression, stabProgression, DEMO_BEATS, demoBeatFile } from '../src/core/demo/beats';
import { parseMidi } from '../src/core/midi/midi';
import { generate, defaultSettings } from '../src/core/compose/engine';
import { generateCandidates } from '../src/core/compose/candidates';
import { slicePitch } from '../src/core/slicing/slices';
import { MemoryFS, saveProject, loadProject, newProjectDoc } from '../src/core/project/project';
import { encodeWav, decodeWav } from '../src/core/audio/wav';
import { Rng } from '../src/core/rng';
import type { BeatContext, SeqEvent } from '../src/core/types';
import { demoProject, slicesOf } from './helpers';

const BAR = 3840;
const beatOf = (notes: any, bpm = 140) => analyseBeat(notes, { name: 't', bpm });

describe('beat analysis', () => {
  const cases: [string, any, string, string][] = [
    ['Am–F–C–G pads', padProgression([[57, 'min'], [53, 'maj'], [60, 'maj'], [55, 'maj']]), 'A minor', 'Am F C G'],
    ['C–G–Am–F pads', padProgression([[60, 'maj'], [55, 'maj'], [57, 'min'], [53, 'maj']]), 'C major', 'C G Am F'],
    ['Cm–Ab–Eb–Bb arp', arpProgression([[60, 'min'], [56, 'maj'], [63, 'maj'], [58, 'maj']]), 'C minor', 'Cm Ab Eb Bb'],
    ['Em–C–G–D pads', padProgression([[64, 'min'], [60, 'maj'], [55, 'maj'], [62, 'maj']]), 'E minor', 'Em C G D'],
    ['F#m–D–A–E arp', arpProgression([[66, 'min'], [62, 'maj'], [57, 'maj'], [64, 'maj']]), 'F# minor', 'F#m D A E'],
    ['Dm7–G7–Cmaj7', padProgression([[62, 'm7'], [55, '7'], [60, 'maj7']]), 'C major', 'Dm7 G7 Cmaj7'],
    ['Dm7–G7 stabs', stabProgression([[62, 'm7'], [55, '7']]), 'D dorian', 'Dm7 G7'],
  ];
  for (const [name, notes, key, chords] of cases) {
    it(`${name} → ${key}, chords ${chords}`, () => {
      const b = beatOf(notes);
      expect(keyName(b.key.root, b.key.scale)).toBe(key);
      expect(b.chords.map((c) => c.symbol).join(' ')).toBe(chords);
    });
  }
  it('places chords on the timeline and tiles the loop', () => {
    const b = beatOf(padProgression([[57, 'min'], [53, 'maj'], [60, 'maj'], [55, 'maj']]));
    expect(b.lengthTicks).toBe(4 * BAR);
    expect(b.chords.map((c) => [c.tick, c.length])).toEqual([[0, BAR], [BAR, BAR], [2 * BAR, BAR], [3 * BAR, BAR]]);
    expect(chordAt(b, 5 * BAR + 10)!.symbol).toBe('F'); // second loop pass
    expect(b.rhythm.harmonicRhythm).toBe(1);
  });
  it('recognises chord qualities from pitch classes', () => {
    const q = (pitches: number[]) => { const pw = pcWeights(pitches.map((p) => ({ tick: 0, length: 960, pitch: p, velocity: 0.8 }))); const c = detectChord(pw.w, pw.bass)!; return `${c.root}:${c.quality}`; };
    expect(q([60, 64, 67])).toBe('0:maj');
    expect(q([57, 60, 64])).toBe('9:min');
    expect(q([55, 59, 62, 65])).toBe('7:7');
    expect(q([62, 65, 69, 72])).toBe('2:m7');
    expect(q([60, 65, 67])).toBe('0:sus4');
  });
  it('profiles rhythm and space', () => {
    const pads = beatOf(padProgression([[57, 'min'], [53, 'maj']])).rhythm;
    const arp = beatOf(arpProgression([[57, 'min'], [53, 'maj']])).rhythm;
    const stabs = beatOf(stabProgression([[62, 'm7'], [55, '7']])).rhythm;
    expect(pads.kind).toBe('chords');
    expect(arp.kind).toBe('arp');
    expect(pads.sustain).toBeGreaterThan(0.9);
    expect(arp.sustain).toBeLessThan(0.3);
    expect(arp.onsetsPerBeat).toBeCloseTo(4, 5);
    expect(pads.steps[0]).toBe(1);
    expect(pads.steps.slice(1).every((v) => v === 0)).toBe(true);
    expect(stabs.syncopation).toBeGreaterThan(0.3);
    expect(arp.syncopation).toBe(0);
    expect(describeBeat(beatOf(arpProgression([[60, 'min'], [56, 'maj']]))).join(' ')).toMatch(/arpeggio/);
  });
  it('reads standard MIDI files and ignores leading empty bars', () => {
    const parsed = parseMidi(demoBeatFile('cm-arp'));
    const b = analyseBeat(parsed.tracks.flatMap((t) => t.notes).map((n) => ({ ...n, tick: n.tick + 2 * BAR })), { name: 'x', bpm: parsed.bpm });
    expect(b.notes[0].tick).toBe(0);
    expect(Math.round(b.bpm!)).toBe(150);
    expect(keyName(b.key.root, b.key.scale)).toBe('C minor');
  });
  it('errors clearly without pitched notes', () => {
    expect(() => analyseBeat([], { name: 'x' })).toThrow(/no pitched notes/);
  });
});

describe('rhythm fit', () => {
  const arp = beatOf(stabProgression([[62, 'm7'], [55, '7']]));
  const hits = Array.from({ length: 8 }, (_, i) => ({ step: i * 2, len: 2, accent: i % 4 === 0 }));
  it('complement moves or drops hits that collide with the beat', () => {
    const r = fitHits(hits, arp, 'complement', new Rng(1));
    const busy = (s: number) => arp.rhythm.steps[s % 16] >= 0.5;
    const before = hits.filter((h, i) => i > 0 && busy(h.step)).length;
    const after = r.hits.filter((h, i) => i > 0 && busy(h.step)).length;
    expect(before).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
    expect(r.hits[0].step).toBe(0); // the downbeat anchor is kept
  });
  it('follow pulls hits onto the beat’s onsets', () => {
    const r = fitHits(hits, arp, 'follow', new Rng(1));
    const on = (s: number) => arp.rhythm.steps[s % 16] >= 0.5;
    expect(r.hits.filter((h) => on(h.step)).length).toBeGreaterThan(hits.filter((h) => on(h.step)).length);
  });
  it('off leaves hits untouched', () => {
    expect(fitHits(hits, arp, 'off', new Rng(1)).hits).toEqual(hits);
  });
});

describe('beat-aware composition', () => {
  const { slices, sources } = demoProject();
  const beat = beatOf(padProgression([[57, 'min'], [53, 'maj'], [60, 'maj'], [55, 'maj']]));
  const pitchOf = (id: string) => { const s = slices.find((x) => x.id === id)!; return slicePitch(s, sources.find((x) => x.id === s.sourceId)); };
  const input = (extra: any = {}, b: BeatContext | null = beat) => ({ settings: defaultSettings({ mode: 'melodic', direction: 'ethereal', seed: 5, keyRoot: 0, scale: 'major', sliceIds: slicesOf('sung-phrase'), ...extra }), slices, sources, bpm: 140, timeSig: [4, 4] as [number, number], beat: b ?? undefined });
  const chordToneShare = (events: SeqEvent[], b: BeatContext, trackRole = 'lead') => {
    let tot = 0, hit = 0;
    for (const e of events) {
      if (e.role !== trackRole || e.tick % 960 !== 0) continue;
      const p = pitchOf(e.sliceId);
      if (p === null) continue;
      tot++;
      if (chordAt(b, e.tick)!.pcs.includes(((Math.round(p + e.semitones) % 12) + 12) % 12)) hit++;
    }
    return tot ? hit / tot : 0;
  };
  it('uses the beat’s key instead of the panel key', () => {
    const out = generate(input());
    expect(out.description.some((d) => d.includes('Fitted to beat') && d.includes('A minor'))).toBe(true);
    const scale = new Set([9, 11, 0, 2, 4, 5, 7]);
    for (const e of out.events) {
      const p = pitchOf(e.sliceId);
      if (p !== null && e.semitones !== 0) expect(scale.has(((Math.round(p + e.semitones) % 12) + 12) % 12)).toBe(true);
    }
  });
  it('harmonises strong notes to the chord underneath', () => {
    // a D minor progression under an A-minor-ish vocal: the key alone does not put notes on chord tones
    const dm = beatOf(padProgression([[62, 'min'], [58, 'maj'], [65, 'maj'], [60, 'maj']]));
    let withBeat = 0, without = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      withBeat += chordToneShare(generate(input({ seed }, dm)).events, dm);
      without += chordToneShare(generate(input({ seed, keyRoot: 2, scale: 'minor' }, null)).events, dm);
    }
    expect(withBeat / 6).toBeGreaterThan(0.85);
    expect(withBeat).toBeGreaterThan(without);
  });
  it('harmonise moves notes by small steps only', () => {
    const notes = [{ tick: 0, length: 960, semitones: 1, velocity: 1, sliceId: 'x' }];
    harmonize(notes, beat, () => 60, { beatTicks: 960, role: 'lead' }); // C# over Am → C or E
    expect([0, 4]).toContain(notes[0].semitones);
  });
  it('rhythmic chops leave room for a busy beat', () => {
    const stabs = beatOf(stabProgression([[62, 'm7'], [55, '7']]), 128);
    const occ = (es: SeqEvent[]) => { const v = es.filter((e) => e.tick % 240 === 0); return v.filter((e) => stabs.rhythm.steps[(e.tick / 240) % 16] >= 0.5).length / Math.max(1, v.length); };
    let a = 0, b = 0;
    for (const seed of [1, 2, 3, 4]) {
      const base = { mode: 'rhythmic', direction: 'playful', seed, sliceIds: slicesOf('chop-attacks') };
      a += occ(generate(input(base, { ...stabs, fit: { ...stabs.fit, rhythm: 'complement' } })).events);
      b += occ(generate(input(base, { ...stabs, fit: { ...stabs.fit, rhythm: 'off' } })).events);
    }
    expect(a).toBeLessThan(b);
  });
  it('follow mode puts more chops on the beat’s onsets', () => {
    const stabs = beatOf(stabProgression([[62, 'm7'], [55, '7']]), 128);
    const on = (es: SeqEvent[]) => es.filter((e) => e.role === 'lead' && stabs.rhythm.steps[Math.round(e.tick / 240) % 16] >= 0.5).length / Math.max(1, es.filter((e) => e.role === 'lead').length);
    let a = 0, b = 0;
    for (const seed of [1, 2, 3, 4]) {
      const base = { mode: 'rhythmic', direction: 'dance', seed, sliceIds: slicesOf('chop-attacks') };
      a += on(generate(input(base, { ...stabs, fit: { ...stabs.fit, rhythm: 'follow' } })).events);
      b += on(generate(input(base, { ...stabs, fit: { ...stabs.fit, rhythm: 'off' } })).events);
    }
    expect(a).toBeGreaterThan(b);
  });
  it('ghost entries arrive on chord changes', () => {
    const out = generate(input({ mode: 'ghost', direction: 'ambient', sliceIds: slicesOf('hum-whisper') }));
    const atm = out.events.filter((e) => e.role === 'atmosphere' && !e.reverse);
    expect(atm.length).toBeGreaterThan(0);
    for (const e of atm) expect(e.tick % BAR).toBe(0);
  });
  it('MIDI mode sings the arp’s pitch classes from each slice’s own pitch', () => {
    const arpB = beatOf(arpProgression([[57, 'min'], [53, 'maj']]));
    const guide = { name: 'arp', notes: arpB.notes, mapping: 'rhythm-cycle' as const, pitchMap: {}, usePitch: true, rootPitch: 60, useVelocity: true, useDuration: true };
    const out = generate(input({ mode: 'midi', midi: guide, sliceIds: slicesOf('sung-phrase').filter((id) => pitchOf(id) !== null) }, { ...arpB, fit: { ...arpB.fit, harmonize: false } }));
    expect(out.events.length).toBe(arpB.notes.filter((n) => n.tick < 8 * BAR).length);
    out.events.forEach((e) => {
      const n = arpB.notes.find((x) => x.tick === e.tick)!;
      expect(((Math.round(pitchOf(e.sliceId)! + e.semitones) % 12) + 12) % 12).toBe(n.pitch % 12);
    });
  });
  it('is deterministic and candidates stay in key', () => {
    expect(generate(input()).events).toEqual(generate(input()).events);
    const cands = generateCandidates({ ...input(), bars: 8, count: 6 });
    expect(cands.every((c) => c.description.some((d) => d.includes('Fitted to beat')))).toBe(true);
  });
  it('a disabled beat context changes nothing', () => {
    const a = generate(input({}, { ...beat, enabled: false }));
    const b = generate(input({}, null));
    expect(a.events).toEqual(b.events);
  });
});

describe('vocal fit and recipes', () => {
  const { slices, sources } = demoProject();
  it('measures how the vocal sits in the beat’s key', () => {
    const am = beatOf(padProgression([[57, 'min'], [53, 'maj'], [60, 'maj'], [55, 'maj']]));
    const sung = slices.filter((s) => s.sourceId === 'sung-phrase');
    const f = vocalKeyFit(sung, sources, am);
    expect(f.pitched).toBeGreaterThan(3);
    expect(f.fitRatio).toBeGreaterThan(0.6); // the demo sung phrase is in A minor
    expect(f.suggestedShift).toBe(0);
    const fs = beatOf(padProgression([[66, 'min'], [62, 'maj'], [57, 'maj'], [64, 'maj']]));
    const g = vocalKeyFit(sung, sources, { ...fs, keyOverride: { root: 1, scale: 'major' } });
    expect(g.fitRatio).toBeLessThan(f.fitRatio);
    expect(g.suggestedShift).not.toBe(0);
  });
  it('curates different options for different beats', () => {
    const pads = beatOf(padProgression([[57, 'min'], [53, 'maj']]), 85);
    const arp = beatOf(arpProgression([[60, 'min'], [56, 'maj']]), 160);
    const rp = beatRecipes(pads, { sources: 1 });
    const ra = beatRecipes(arp, { sources: 2 });
    expect(rp.find((r) => r.id === 'hook')!.settings.direction).toBe('ethereal');
    expect(ra.find((r) => r.id === 'hook')!.settings.direction).toBe('playful');
    expect(ra.find((r) => r.id === 'follow')!.settings.mode).toBe('midi');
    expect(rp.find((r) => r.id === 'follow')!.settings.mode).toBe('rhythmic');
    expect(ra.some((r) => r.id === 'micro')).toBe(true);
    expect(ra.some((r) => r.id === 'conversation')).toBe(true);
    expect(rp.some((r) => r.id === 'conversation')).toBe(false);
    for (const r of [...rp, ...ra]) {
      expect(r.settings.keyRoot).toBe(effectiveKey(r === undefined ? pads : rp.includes(r) ? pads : arp).root);
      expect(r.why.length).toBeGreaterThan(20);
    }
    expect(ra.find((r) => r.id === 'gaps')!.settings.controls!.space).toBeGreaterThan(rp.find((r) => r.id === 'gaps')!.settings.controls!.space);
    expect(arrangementBarsFor(pads)).toBe(8);
  });
  it('persists the beat context with the project', async () => {
    const { audio } = demoProject();
    const doc = newProjectDoc('b');
    doc.sources = sources.slice(0, 1);
    doc.beat = { ...beatOf(DEMO_BEATS['am-f-c-g-pads'].notes()), keyOverride: { root: 0, scale: 'major' } };
    const fs = new MemoryFS();
    await saveProject(fs, 'p', doc, new Map([[sources[0].assetName, encodeWav(audio.get(sources[0].id)!, 16)]]));
    const l = await loadProject(fs, 'p', async (b) => decodeWav(b));
    expect(l.doc.beat).toEqual(doc.beat);
  });
});

describe('harmonisation covers every layer', () => {
  it('rhythm chops over a beat in another key stay in the beat’s key', () => {
    const { slices, sources } = demoProject();
    const cm = analyseBeat(arpProgression([[60, 'min'], [56, 'maj'], [63, 'maj'], [58, 'maj']]), { name: 'cm', bpm: 150 });
    const out = generate({ settings: defaultSettings({ mode: 'rhythmic', direction: 'playful', seed: 9, sliceIds: slicesOf('sung-phrase'), layers: ['lead', 'rhythm', 'transition'] }), slices, sources, bpm: 150, timeSig: [4, 4], beat: cm });
    const scale = new Set([0, 2, 3, 5, 7, 8, 10]);
    let pitched = 0;
    for (const e of out.events) {
      const s = slices.find((x) => x.id === e.sliceId)!;
      const p = slicePitch(s, sources.find((x) => x.id === s.sourceId));
      if (p === null) continue;
      pitched++;
      expect(scale.has(((Math.round(p + e.semitones) % 12) + 12) % 12)).toBe(true);
    }
    expect(pitched).toBeGreaterThan(10);
    expect(out.events.some((e) => e.role === 'rhythm')).toBe(true);
  });
});

describe('beat loop as MIDI guide', () => {
  it('repeats a looping guide across the whole arrangement', () => {
    const { slices, sources } = demoProject();
    const arp = analyseBeat(arpProgression([[60, 'min'], [56, 'maj']]), { name: 'a', bpm: 150 }); // 2-bar loop
    const guide = { name: 'arp', notes: arp.notes, mapping: 'rhythm-cycle' as const, pitchMap: {}, usePitch: true, rootPitch: 60, useVelocity: true, useDuration: true, loopTicks: arp.lengthTicks };
    const out = generate({ settings: defaultSettings({ mode: 'midi', midi: guide, bars: 8, sliceIds: slicesOf('chop-attacks') }), slices, sources, bpm: 150, timeSig: [4, 4], beat: arp });
    expect(out.events.length).toBe(arp.notes.length * 4);
    expect(Math.max(...out.events.map((e) => e.tick))).toBeGreaterThan(7 * BAR);
  });
});
