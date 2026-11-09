import { describe, it, expect } from 'vitest';
import { MemoryFS, saveProject, loadProject, newProjectDoc, bundleProject, unbundleProject, parseProject, ProjectFormatError, serializeProject } from '../src/core/project/project';
import { encodeWav, decodeWav } from '../src/core/audio/wav';
import { generate, defaultSettings } from '../src/core/compose/engine';
import { exportMixFile, exportStems, exportSlices, exportMidiPackage } from '../src/core/project/exporters';
import { parseMidi } from '../src/core/midi/midi';
import { demoProject, slicesOf } from './helpers';
import type { ProjectDoc } from '../src/core/types';

function makeDoc(): { doc: ProjectDoc; assets: Map<string, Uint8Array> } {
  const { sources, slices, audio } = demoProject();
  const doc = newProjectDoc('Test idea');
  doc.sources = sources.map((s) => ({ ...s }));
  doc.slices = slices.map((s) => ({ ...s }));
  doc.slices[0].tags = ['hook'];
  doc.slices[0].favourite = true;
  const settings = defaultSettings({ mode: 'rhythmic', direction: 'playful', sliceIds: slicesOf('chop-attacks'), seed: 3 });
  const out = generate({ settings, slices, sources, bpm: 140, timeSig: [4, 4] });
  doc.sequence = { ...doc.sequence, bpm: 140, tracks: out.tracks, events: out.events, motifs: out.motifs, settings, lockedBars: [2], lockedRests: [{ id: 'r', trackId: null, startTick: 0, endTick: 960 }] };
  doc.collections = [{ id: 'c1', name: 'Favourites', sliceIds: [doc.slices[0].id] }];
  const assets = new Map(sources.map((s) => [s.assetName, encodeWav(audio.get(s.id)!, 24)]));
  return { doc, assets };
}
const decode = async (b: Uint8Array) => decodeWav(b);

describe('project persistence', () => {
  it('saves and reopens a project with all state and audio', async () => {
    const { doc, assets } = makeDoc();
    const fs = new MemoryFS();
    await saveProject(fs, 'p/Test.vcs', doc, assets);
    expect(await fs.exists('p/Test.vcs/project.json')).toBe(true);
    expect(await fs.exists('p/Test.vcs/audio/sung-phrase.wav')).toBe(true);
    // the JSON must not embed audio
    expect((await fs.readText('p/Test.vcs/project.json')).length).toBeLessThan(400_000);
    const loaded = await loadProject(fs, 'p/Test.vcs', decode);
    expect(loaded.missing).toEqual([]);
    expect(loaded.doc.slices).toEqual(doc.slices);
    expect(loaded.doc.sequence.events).toEqual(doc.sequence.events);
    expect(loaded.doc.sequence.tracks).toEqual(doc.sequence.tracks);
    expect(loaded.doc.sequence.settings).toEqual(doc.sequence.settings);
    expect(loaded.doc.sequence.lockedBars).toEqual([2]);
    expect(loaded.doc.sequence.lockedRests.length).toBe(1);
    expect(loaded.doc.collections).toEqual(doc.collections);
    expect(loaded.audio.get('voice-b')!.channels.length).toBe(2);
    expect(loaded.audio.get('voice-b')!.sampleRate).toBe(48000);
  });

  it('does not rewrite managed audio on subsequent saves', async () => {
    const { doc, assets } = makeDoc();
    const fs = new MemoryFS();
    await saveProject(fs, 'x', doc, assets);
    const second = await saveProject(fs, 'x', doc, assets);
    expect(second.written).toEqual(['x/project.json']);
  });

  it('flags missing source files instead of failing', async () => {
    const { doc, assets } = makeDoc();
    const fs = new MemoryFS();
    await saveProject(fs, 'x', doc, assets);
    fs.files.delete('x/audio/hum-whisper.wav');
    fs.files.set('x/audio/voice-b.wav', new Uint8Array([1, 2, 3]));
    const loaded = await loadProject(fs, 'x', decode);
    expect(loaded.missing.sort()).toEqual(['hum-whisper', 'voice-b']);
    expect(loaded.doc.sources.find((s) => s.id === 'hum-whisper')!.missing).toBe(true);
    expect(loaded.doc.slices.length).toBe(doc.slices.length); // slice definitions survive
    expect(loaded.errors.length).toBe(1);
    // rendering still works for the available sources
    const mix = exportMixFile(loaded.doc, loaded.audio, loaded.doc.exportSettings);
    expect(mix.result.eventCount).toBeGreaterThan(0);
  });

  it('round-trips a portable single-file bundle', () => {
    const { doc, assets } = makeDoc();
    const b = bundleProject(doc, assets);
    const u = unbundleProject(b);
    expect(u.doc.sequence.events).toEqual(doc.sequence.events);
    expect(Array.from(u.assets.keys()).sort()).toEqual(Array.from(assets.keys()).sort());
    expect(u.assets.get('sung-phrase.wav')).toEqual(assets.get('sung-phrase.wav'));
  });

  it('rejects invalid or future projects with a clear message', () => {
    expect(() => parseProject('nope')).toThrow(ProjectFormatError);
    expect(() => parseProject('{"a":1}')).toThrow(/does not look like/);
    const { doc } = makeDoc();
    expect(() => parseProject(serializeProject({ ...doc, version: 99 }))).toThrow(/newer version/);
  });

  it('fills defaults when loading older/partial files', () => {
    const p = parseProject(JSON.stringify({ name: 'old', sources: [], slices: [{ id: 's', sourceId: 'x', start: 0, end: 10, name: 's', level: 'word' }], sequence: { bpm: 100, events: [{ id: 'e', trackId: 't', sliceId: 's', tick: 0, length: 10 }] } }));
    expect(p.slices[0].tags).toEqual([]);
    expect(p.sequence.events[0].gain).toBe(0);
    expect(p.sequence.settings.controls.space).toBeDefined();
    expect(p.exportSettings.bitDepth).toBe(24);
  });
});

describe('exports', () => {
  it('renders a mix WAV with the arrangement duration', () => {
    const { doc } = makeDoc();
    const { audio } = demoProject();
    const f = exportMixFile(doc, audio, { ...doc.exportSettings, tail: 'cut', sampleRate: 48000, bitDepth: 16 });
    const w = decodeWav(f.bytes);
    expect(w.sampleRate).toBe(48000);
    expect(w.channels[0].length).toBe(Math.round((8 * 4 * 60) / 140 * 48000));
    expect(f.name).toMatch(/140bpm.*48k16\.wav$/);
    expect(f.result.peak).toBeLessThanOrEqual(0.99);
  });
  it('exports equal-length stems that sum to the mix', () => {
    const { doc } = makeDoc();
    const { audio } = demoProject();
    const s = { ...doc.exportSettings, bitDepth: 32 as const, level: 'none' as const, tail: 'keep' as const };
    const stems = exportStems(doc, audio, s).map((f) => decodeWav(f.bytes));
    expect(stems.length).toBe(doc.sequence.tracks.filter((t) => doc.sequence.events.some((e) => e.trackId === t.id)).length);
    const len = stems[0].channels[0].length;
    expect(stems.every((x) => x.channels[0].length === len)).toBe(true);
    const mix = decodeWav(exportMixFile(doc, audio, s).bytes);
    for (let i = 1000; i < Math.min(len, mix.channels[0].length); i += 997) {
      const sum = stems.reduce((a, x) => a + x.channels[0][i], 0);
      expect(Math.abs(sum - mix.channels[0][i])).toBeLessThan(1e-4);
    }
  });
  it('exports individual slices with protective fades', () => {
    const { doc } = makeDoc();
    const { audio } = demoProject();
    const ids = doc.slices.slice(0, 3).map((s) => s.id);
    const files = exportSlices(doc, audio, ids, { ...doc.exportSettings, sampleRate: 44100 });
    expect(files.length).toBe(3);
    const w = decodeWav(files[0].bytes);
    expect(w.channels[0][0]).toBe(0);
    expect(Math.abs(w.channels[0].length - (doc.slices[0].end - doc.slices[0].start))).toBeLessThanOrEqual(1);
  });
  it('exports a MIDI trigger package whose notes match the sequence', () => {
    const { doc } = makeDoc();
    const { audio } = demoProject();
    const files = exportMidiPackage(doc, audio, doc.exportSettings, 'trigger');
    const mid = files.find((f) => f.name.endsWith('.mid'))!;
    const parsed = parseMidi(mid.bytes);
    const total = parsed.tracks.reduce((a, t) => a + t.notes.length, 0);
    expect(total).toBe(doc.sequence.events.length);
    const map = JSON.parse(new TextDecoder().decode(files.find((f) => f.name.endsWith('.json'))!.bytes));
    expect(map.mapping.length).toBe(new Set(doc.sequence.events.map((e) => e.sliceId)).size);
    expect(files.filter((f) => f.name.startsWith('slices/')).length).toBe(map.mapping.length);
    const ticks = parsed.tracks.flatMap((t) => t.notes.map((n) => n.tick)).sort((a, b) => a - b);
    expect(ticks).toEqual(doc.sequence.events.map((e) => e.tick).sort((a, b) => a - b));
    expect(new TextDecoder().decode(files[1].bytes)).toMatch(/cannot reproduce the composition without these slice files/);
  });
});
