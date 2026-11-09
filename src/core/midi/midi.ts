import * as ToneMidi from '@tonejs/midi';
import type { Midi as MidiType } from '@tonejs/midi';

// @tonejs/midi ships CJS + ESM builds; resolve the class under either interop.
const Midi: typeof MidiType = (ToneMidi as any).Midi ?? (ToneMidi as any).default?.Midi;
type Midi = MidiType;
import type { MidiGuide, MidiNote, SeqEvent, Slice, SourceAudio, Track } from '../types';
import { PPQ } from '../types';
import { midiToName, semitonesToRate, ticksToSeconds } from '../time';

export class MidiFormatError extends Error {}

export interface ParsedMidi {
  name: string;
  bpm?: number;
  timeSig?: [number, number];
  tracks: { index: number; name: string; notes: MidiNote[] }[];
}

/** Parse a standard MIDI file (type 0 or 1). Ticks are rescaled to the app's PPQ. */
export function parseMidi(bytes: Uint8Array, name = 'MIDI'): ParsedMidi {
  let midi: Midi;
  try {
    midi = new Midi(bytes);
  } catch (e) {
    throw new MidiFormatError(`Could not read MIDI file: ${(e as Error).message}`);
  }
  const ppq = midi.header.ppq || 480;
  const scale = PPQ / ppq;
  const ts = midi.header.timeSignatures[0]?.timeSignature as [number, number] | undefined;
  const tracks = midi.tracks
    .map((t, index) => ({
      index,
      name: t.name || `Track ${index + 1}`,
      notes: t.notes
        .map((n) => ({ tick: Math.round(n.ticks * scale), length: Math.max(1, Math.round(n.durationTicks * scale)), pitch: n.midi, velocity: n.velocity }))
        .sort((a, b) => a.tick - b.tick || a.pitch - b.pitch),
    }))
    .filter((t) => t.notes.length > 0);
  if (!tracks.length) throw new MidiFormatError('The MIDI file contains no notes.');
  return { name: midi.name || name, bpm: midi.header.tempos[0]?.bpm, timeSig: ts, tracks };
}

export function guideFromMidi(parsed: ParsedMidi, trackIndexes?: number[]): MidiGuide {
  const chosen = trackIndexes?.length ? parsed.tracks.filter((t) => trackIndexes.includes(t.index)) : parsed.tracks;
  const notes = chosen.flatMap((t) => t.notes).sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
  const pitches = notes.map((n) => n.pitch).sort((a, b) => a - b);
  const median = pitches[Math.floor(pitches.length / 2)] ?? 60;
  return {
    name: parsed.name,
    notes,
    bpm: parsed.bpm,
    mapping: 'rhythm-cycle',
    pitchMap: {},
    usePitch: false,
    rootPitch: median,
    useVelocity: true,
    useDuration: true,
  };
}

/** Distinct pitches in a guide (for building a pitch → slice map). */
export function guidePitches(g: MidiGuide): number[] {
  return Array.from(new Set(g.notes.map((n) => n.pitch))).sort((a, b) => a - b);
}

export interface SliceMapping {
  note: number;
  noteName: string;
  sliceId: string;
  sliceName: string;
  fileName: string;
}

export function safeName(s: string) {
  return s.replace(/[^a-z0-9_\-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'slice';
}

/**
 * Trigger export: one MIDI note per slice (C1 upward), one MIDI track per layer.
 * The MIDI alone cannot reproduce the audio – the mapping and slice WAVs are needed.
 */
export function exportTriggerMidi(
  events: SeqEvent[],
  tracks: Track[],
  slices: Slice[],
  sources: SourceAudio[],
  bpm: number,
  timeSig: [number, number],
  firstNote = 36,
): { bytes: Uint8Array; mapping: SliceMapping[] } {
  const sliceMap = new Map(slices.map((s) => [s.id, s]));
  const srcMap = new Map(sources.map((s) => [s.id, s]));
  const order: string[] = [];
  for (const e of events.slice().sort((a, b) => a.tick - b.tick)) if (!order.includes(e.sliceId) && sliceMap.has(e.sliceId)) order.push(e.sliceId);
  const mapping: SliceMapping[] = order.map((id, i) => {
    const s = sliceMap.get(id)!;
    const note = Math.min(127, firstNote + i);
    return { note, noteName: midiToName(note), sliceId: id, sliceName: s.name, fileName: `${String(note).padStart(3, '0')}_${midiToName(note)}_${safeName(s.name)}.wav` };
  });
  const noteOf = new Map(mapping.map((m) => [m.sliceId, m.note]));
  const midi = new Midi();
  midi.header.setTempo(bpm);
  midi.header.timeSignatures.push({ ticks: 0, timeSignature: timeSig });
  midi.header.update();
  const scale = midi.header.ppq / PPQ;
  for (const t of tracks) {
    const evs = events.filter((e) => e.trackId === t.id);
    if (!evs.length) continue;
    const mt = midi.addTrack();
    mt.name = t.name;
    for (const e of evs) {
      const s = sliceMap.get(e.sliceId);
      const src = s ? srcMap.get(s.sourceId) : undefined;
      if (!s || !src) continue;
      const naturalSec = (s.end - s.start - e.offset) / src.sampleRate / semitonesToRate(e.semitones);
      const gateSec = ticksToSeconds(e.length, bpm);
      const durTicks = Math.max(1, Math.round((Math.min(naturalSec, gateSec) / gateSec) * e.length));
      mt.addNote({ midi: noteOf.get(e.sliceId)!, ticks: Math.round(e.tick * scale), durationTicks: Math.max(1, Math.round(durTicks * scale)), velocity: Math.max(0.05, Math.min(1, e.velocity)) });
    }
  }
  return { bytes: midi.toArray(), mapping };
}

/**
 * Melodic export: one MIDI track per slice, note = root (C3/60) + transposition.
 * Load each slice into a sampler with root note 60 to recreate playback-rate pitching.
 */
export function exportPitchMidi(events: SeqEvent[], slices: Slice[], bpm: number, timeSig: [number, number], root = 60): { bytes: Uint8Array; mapping: SliceMapping[] } {
  const sliceMap = new Map(slices.map((s) => [s.id, s]));
  const midi = new Midi();
  midi.header.setTempo(bpm);
  midi.header.timeSignatures.push({ ticks: 0, timeSignature: timeSig });
  midi.header.update();
  const scale = midi.header.ppq / PPQ;
  const ids = Array.from(new Set(events.map((e) => e.sliceId))).filter((id) => sliceMap.has(id));
  const mapping: SliceMapping[] = [];
  for (const id of ids) {
    const s = sliceMap.get(id)!;
    const mt = midi.addTrack();
    mt.name = s.name;
    mapping.push({ note: root, noteName: midiToName(root), sliceId: id, sliceName: s.name, fileName: `root${midiToName(root)}_${safeName(s.name)}.wav` });
    for (const e of events.filter((x) => x.sliceId === id))
      mt.addNote({ midi: Math.max(0, Math.min(127, root + Math.round(e.semitones))), ticks: Math.round(e.tick * scale), durationTicks: Math.max(1, Math.round(e.length * scale)), velocity: Math.max(0.05, Math.min(1, e.velocity)) });
  }
  return { bytes: midi.toArray(), mapping };
}

export function mappingText(mapping: SliceMapping[], kind: 'trigger' | 'pitch', bpm: number): string {
  const lines = [
    `Vocal Chop Studio – MIDI ${kind === 'trigger' ? 'trigger' : 'melodic'} mapping`,
    `Tempo: ${bpm} BPM`,
    '',
    kind === 'trigger'
      ? 'Load each WAV into a drum sampler / one-shot sampler pad on the listed note. The MIDI file only contains triggers –'
      : 'Each MIDI track belongs to one slice. Load the WAV into a sampler with root note C3 (60) and pitch tracking on –',
    kind === 'trigger'
      ? 'it cannot reproduce the composition without these slice files. Reverse/offset/fade settings are not encoded in MIDI.'
      : 'note offsets reproduce the playback-rate transposition. Reverse/offset/fade settings are not encoded in MIDI.',
    '',
    'note  name  file                                      slice',
    ...mapping.map((m) => `${String(m.note).padEnd(5)} ${m.noteName.padEnd(5)} ${m.fileName.padEnd(41)} ${m.sliceName}`),
  ];
  return lines.join('\n') + '\n';
}

/** Build a simple standard MIDI file (used for demos/tests). */
export function buildMidiFile(notes: MidiNote[], bpm: number, name = 'Guide'): Uint8Array {
  const midi = new Midi();
  midi.name = name;
  midi.header.setTempo(bpm);
  midi.header.update();
  const scale = midi.header.ppq / PPQ;
  const t = midi.addTrack();
  t.name = name;
  for (const n of notes) t.addNote({ midi: n.pitch, ticks: Math.round(n.tick * scale), durationTicks: Math.round(n.length * scale), velocity: n.velocity });
  return midi.toArray();
}
