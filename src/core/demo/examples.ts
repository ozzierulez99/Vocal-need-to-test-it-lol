import type { AudioData, MidiNote, ProjectDoc, SourceAudio, Slice, GeneratorSettings } from '../types';
import { DEMO_VOICES, demoVoice } from './synthVoice';
import { autoChop } from '../slicing/slices';
import { encodeWav } from '../audio/wav';
import { newProjectDoc } from '../project/project';
import { generate, defaultSettings } from '../compose/engine';
import { generateCandidates } from '../compose/candidates';
import { guideFromMidi, parseMidi, buildMidiFile } from '../midi/midi';
import { DIRECTIONS } from '../compose/directions';

/**
 * Demonstration projects for each first-class workflow, built from the bundled
 * synthetic vocal-like recordings. Used by the app's "Examples" menu, by the
 * examples/ folder generator script and by tests.
 */
export interface BuiltProject {
  doc: ProjectDoc;
  audio: Map<string, AudioData>;
  assets: Map<string, Uint8Array>;
}

export function demoSource(key: string, id = `src-${key}`): { src: SourceAudio; audio: AudioData; bytes: Uint8Array } {
  const audio = demoVoice(key);
  const bytes = encodeWav(audio, 16);
  const src: SourceAudio = {
    id,
    name: DEMO_VOICES[key].title,
    assetName: `${key}.wav`,
    kind: 'import',
    sampleRate: audio.sampleRate,
    channelCount: audio.channels.length,
    frames: audio.channels[0].length,
    createdAt: 0,
    rootNote: undefined,
  };
  return { src, audio, bytes };
}

/** 2-step garage style guide: syncopated rhythm with a small minor melody. */
export function demoMidiNotes(): MidiNote[] {
  const pattern = [0, 3, 6, 10, 12, 14];
  const melody = [57, 60, 64, 62, 60, 55];
  const out: MidiNote[] = [];
  for (let bar = 0; bar < 8; bar++) {
    pattern.forEach((st, i) => {
      if (bar % 4 === 3 && i === 5) return;
      out.push({ tick: bar * 3840 + st * 240, length: i === 2 ? 720 : 240, pitch: melody[(i + (bar % 2 ? 1 : 0)) % melody.length] + (bar >= 4 ? 2 : 0), velocity: i === 0 || i === 3 ? 0.95 : 0.6 });
    });
  }
  return out;
}

export function demoMidiFile(): Uint8Array {
  return buildMidiFile(demoMidiNotes(), 132, 'Garage riff');
}

function base(name: string, keys: string[], bpm: number): BuiltProject & { slicesBySource: Map<string, Slice[]> } {
  const doc = newProjectDoc(name);
  const audio = new Map<string, AudioData>();
  const assets = new Map<string, Uint8Array>();
  const slicesBySource = new Map<string, Slice[]>();
  keys.forEach((k, i) => {
    const { src, audio: a, bytes } = demoSource(k);
    doc.sources.push(src);
    audio.set(src.id, a);
    assets.set(src.assetName, bytes);
    const { slices } = autoChop(src, a, { prefix: keys.length > 1 ? String.fromCharCode(65 + i) : '' });
    // deterministic ids for example files
    const remap = new Map<string, string>();
    slices.forEach((s, j) => remap.set(s.id, `${k}-${j}`));
    const fixed = slices.map((s) => ({ ...s, id: remap.get(s.id)!, parentId: s.parentId ? remap.get(s.parentId) : undefined }));
    doc.slices.push(...fixed);
    slicesBySource.set(src.id, fixed);
  });
  doc.sequence.bpm = bpm;
  return { doc, audio, assets, slicesBySource };
}

function compose(p: BuiltProject, settings: GeneratorSettings) {
  const seq = p.doc.sequence;
  seq.bars = settings.bars;
  seq.loop = { enabled: true, startTick: 0, endTick: settings.bars * 3840 };
  seq.settings = settings;
  const out = generate({ settings, slices: p.doc.slices, sources: p.doc.sources, bpm: seq.bpm, timeSig: seq.timeSig, existing: { ...seq } });
  seq.tracks = out.tracks;
  seq.events = out.events;
  seq.motifs = out.motifs;
  return out;
}

const ids = (sl: Slice[], levels: Slice['level'][] = ['word', 'syllable']) => sl.filter((s) => levels.includes(s.level)).map((s) => s.id);

export const EXAMPLES: Record<string, { title: string; workflow: string; build: () => BuiltProject }> = {
  'ethereal-hook': {
    title: 'A · Ethereal Vocal Hook',
    workflow: 'Sung phrase → vowels & syllables → floating melodic hook with gaps → six candidates → favourite applied.',
    build: () => {
      const p = base('Ethereal Hook', ['sung-phrase'], 132);
      const sl = p.slicesBySource.get('src-sung-phrase')!;
      for (const s of sl) if (s.category === 'sustained-vowel') s.favourite = true;
      const settings = defaultSettings({ mode: 'melodic', direction: 'ethereal', seed: 2024, bars: 8, phraseBars: 2, keyRoot: 9, scale: 'minor', sliceIds: ids(sl) });
      const cands = generateCandidates({ settings, slices: p.doc.slices, sources: p.doc.sources, bpm: 132, timeSig: [4, 4], bars: 8 });
      p.doc.candidates = cands;
      const fav = cands.find((c) => c.label === 'Most melodic') ?? cands[0];
      fav.favourite = true;
      p.doc.sequence.settings = fav.settings;
      p.doc.sequence.tracks = fav.tracks;
      p.doc.sequence.events = fav.events;
      p.doc.sequence.motifs = fav.motifs.map((m) => ({ ...m, important: true }));
      p.doc.collections.push({ id: 'col-vowels', name: 'Floating vowels', sliceIds: sl.filter((s) => s.favourite).map((s) => s.id) });
      return p;
    },
  },
  'playful-chops': {
    title: 'B · Playful Electronic Chops',
    workflow: 'Sharp syllables → syncopated riff → stutters → final bar regenerated with the opening motif preserved.',
    build: () => {
      const p = base('Playful Chops', ['chop-attacks', 'voice-b'], 150);
      const all = [...p.slicesBySource.get('src-chop-attacks')!, ...p.slicesBySource.get('src-voice-b')!];
      const settings = defaultSettings({ mode: 'rhythmic', direction: 'playful', feel: 'bouncy', seed: 77, bars: 8, keyRoot: 9, scale: 'minor-pentatonic', sliceIds: ids(all) });
      compose(p, settings);
      const seq = p.doc.sequence;
      seq.motifs = seq.motifs.map((m) => ({ ...m, important: true, protection: 'preserve' }));
      const out = generate({ settings: { ...settings, seed: 78 }, slices: p.doc.slices, sources: p.doc.sources, bpm: seq.bpm, timeSig: seq.timeSig, existing: seq, scope: { startBar: 7, endBar: 8 } });
      seq.events = out.events;
      seq.tracks = out.tracks;
      return p;
    },
  },
  'ambient-ghost': {
    title: 'C · Ambient Ghost Vocals',
    workflow: 'Hums, breaths & whispers → sparse overlapping layers, long rests, slow change → export layers as stems.',
    build: () => {
      const p = base('Ambient Ghost', ['hum-whisper'], 90);
      const sl = p.slicesBySource.get('src-hum-whisper')!;
      const settings = defaultSettings({ mode: 'ghost', direction: 'ambient', seed: 9, bars: 16, phraseBars: 4, keyRoot: 2, scale: 'dorian', sliceIds: ids(sl, ['word', 'syllable', 'phrase']), controls: { ...DIRECTIONS.ambient.controls } });
      compose(p, settings);
      const b = p.doc.sequence.tracks.find((t) => t.name === 'Ghost layer B');
      if (b) b.filter = { type: 'lowpass', frequency: 2200 };
      return p;
    },
  },
  'phrase-reconstruction': {
    title: 'D · Vocal Phrase Reconstruction',
    workflow: 'Spoken phrase → words → reordered / repeated / removed / fragmented, one anchor word kept recognisable.',
    build: () => {
      const p = base('Phrase Reconstruction', ['spoken-phrase'], 120);
      const sl = p.slicesBySource.get('src-spoken-phrase')!;
      const words = sl.filter((s) => s.level === 'word');
      const anchor = words[4] ?? words[0];
      anchor.favourite = true;
      anchor.tags = ['anchor'];
      const settings = defaultSettings({ mode: 'phrase', direction: 'emotional', seed: 5, bars: 8, phraseBars: 2, sliceIds: ids(sl, ['word']) });
      p.doc.sequence.motifs = [{ id: 'motif-anchor', name: `Anchor “${anchor.name}”`, span: 960, notes: [{ tick: 0, length: 960, sliceId: anchor.id, semitones: 0, offset: 0, reverse: false, accent: 1 }], protection: 'preserve', important: true }];
      compose(p, settings);
      return p;
    },
  },
  'two-voice-conversation': {
    title: 'E · Two-Voice Conversation',
    workflow: 'Two recordings → call-and-response; switch relation to alternating, interrupt, imitate, overlap…',
    build: () => {
      const p = base('Two-Voice Conversation', ['sung-phrase', 'voice-b'], 138);
      const a = ids(p.slicesBySource.get('src-sung-phrase')!);
      const b = ids(p.slicesBySource.get('src-voice-b')!);
      const settings = defaultSettings({ mode: 'conversation', direction: 'dance', seed: 31, bars: 8, voiceA: a, voiceB: b, relation: 'call-response', keyRoot: 9, scale: 'minor' });
      compose(p, settings);
      return p;
    },
  },
  'midi-guided': {
    title: 'F · MIDI-Guided Vocal Pattern',
    workflow: 'Vocal sample + MIDI riff → slices triggered on MIDI timing, velocity accents, pitch by playback rate.',
    build: () => {
      const p = base('MIDI-Guided Pattern', ['chop-attacks'], 132);
      const sl = p.slicesBySource.get('src-chop-attacks')!;
      const guide = { ...guideFromMidi(parseMidi(demoMidiFile(), 'Garage riff')), usePitch: true, rootPitch: 57 };
      p.doc.midiGuides.push(guide);
      const settings = defaultSettings({ mode: 'midi', direction: 'dance', seed: 3, bars: 8, sliceIds: ids(sl, ['word']), midi: guide });
      compose(p, settings);
      return p;
    },
  },
};
