import { describe, it, expect } from 'vitest';
import { buildMidiFile, parseMidi, guideFromMidi, MidiFormatError, exportPitchMidi } from '../src/core/midi/midi';

describe('MIDI import', () => {
  const notes = [
    { tick: 0, length: 480, pitch: 60, velocity: 0.8 },
    { tick: 720, length: 240, pitch: 63, velocity: 0.5 },
    { tick: 960, length: 960, pitch: 67, velocity: 1 },
  ];
  it('parses note timing, length, pitch and velocity at the app resolution', () => {
    const p = parseMidi(buildMidiFile(notes, 128, 'Riff'));
    expect(p.bpm).toBeCloseTo(128, 3);
    expect(p.tracks.length).toBe(1);
    const n = p.tracks[0].notes;
    expect(n.map((x) => x.tick)).toEqual([0, 720, 960]);
    expect(n.map((x) => x.length)).toEqual([480, 240, 960]);
    expect(n.map((x) => x.pitch)).toEqual([60, 63, 67]);
    expect(n[1].velocity).toBeCloseTo(0.5, 1);
    const g = guideFromMidi(p);
    expect(g.notes.length).toBe(3);
    expect(g.rootPitch).toBe(63);
  });
  it('rejects garbage and empty files', () => {
    expect(() => parseMidi(new Uint8Array([1, 2, 3, 4]))).toThrow(MidiFormatError);
    expect(() => parseMidi(buildMidiFile([], 120))).toThrow(/no notes/);
  });
  it('exports melodic note mappings', () => {
    const ev = [{ id: 'a', trackId: 't', sliceId: 's1', tick: 0, length: 480, offset: 0, gain: 0, semitones: 5, reverse: false, fadeIn: 0, fadeOut: 0, pan: 0, velocity: 0.7, locked: false }];
    const r = exportPitchMidi(ev, [{ id: 's1', sourceId: 'x', start: 0, end: 100, name: 'ah', level: 'word', tags: [], favourite: false }], 120, [4, 4]);
    const p = parseMidi(r.bytes);
    expect(p.tracks[0].notes[0].pitch).toBe(65);
    expect(r.mapping[0].note).toBe(60);
  });
});
