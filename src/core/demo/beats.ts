import type { MidiNote } from '../types';
import { buildMidiFile, buildMultiMidi } from '../midi/midi';

/**
 * Small demo "beat" MIDI files (chord progressions / arps) for trying the
 * Fit-to-my-beat workflow without your own project files.
 */
const Q: Record<string, number[]> = { maj: [0, 4, 7], min: [0, 3, 7], m7: [0, 3, 7, 10], '7': [0, 4, 7, 10], maj7: [0, 4, 7, 11] };
const BAR = 3840;

function voicing(root: number, q: string) {
  return Q[q].map((i) => root + i);
}

/** Sustained pad chords, one chord per `barsPer` bars, with a bass note. */
export function padProgression(chords: [number, string][], barsPer = 1, repeats = 1): MidiNote[] {
  const out: MidiNote[] = [];
  let t = 0;
  for (let r = 0; r < repeats; r++)
    for (const [root, q] of chords) {
      const len = BAR * barsPer;
      out.push({ tick: t, length: len - 40, pitch: root - 12, velocity: 0.8 });
      for (const p of voicing(root, q)) out.push({ tick: t, length: len - 40, pitch: p, velocity: 0.7 });
      t += len;
    }
  return out;
}

/** Sixteenth-note up/down arpeggio over each chord. */
export function arpProgression(chords: [number, string][], barsPer = 1, pattern = [0, 1, 2, 3, 2, 1]): MidiNote[] {
  const out: MidiNote[] = [];
  let t = 0;
  for (const [root, q] of chords) {
    const tones = voicing(root, q);
    const ext = [...tones, tones[0] + 12];
    const steps = 16 * barsPer;
    for (let s = 0; s < steps; s++) {
      const p = ext[pattern[s % pattern.length] % ext.length];
      out.push({ tick: t + s * 240, length: 200, pitch: p, velocity: s % 4 === 0 ? 0.9 : 0.65 });
    }
    t += BAR * barsPer;
  }
  return out;
}

/** Off-beat chord stabs (syncopated), e.g. a dorian vamp. */
export function stabProgression(chords: [number, string][], barsPer = 2): MidiNote[] {
  const out: MidiNote[] = [];
  const pattern = [0, 3, 6, 10, 12];
  let t = 0;
  for (const [root, q] of chords) {
    for (let b = 0; b < barsPer; b++)
      for (const st of pattern) for (const p of voicing(root, q)) out.push({ tick: t + b * BAR + st * 240, length: 300, pitch: p, velocity: st === 0 ? 0.9 : 0.7 });
    t += BAR * barsPer;
  }
  return out;
}

export const DEMO_BEATS: Record<string, { title: string; bpm: number; notes: () => MidiNote[] }> = {
  'am-f-c-g-pads': { title: 'Am – F – C – G pads (140 BPM)', bpm: 140, notes: () => padProgression([[57, 'min'], [53, 'maj'], [60, 'maj'], [55, 'maj']]) },
  'cm-arp': { title: 'Cm – Ab – Eb – Bb 16th arp (150 BPM)', bpm: 150, notes: () => arpProgression([[60, 'min'], [56, 'maj'], [63, 'maj'], [58, 'maj']]) },
  'dorian-stabs': { title: 'Dm7 – G7 off-beat stabs (128 BPM)', bpm: 128, notes: () => stabProgression([[62, 'm7'], [55, '7']]) },
};

export function demoBeatFile(key: string): Uint8Array {
  const b = DEMO_BEATS[key];
  return buildMidiFile(b.notes(), b.bpm, b.title);
}


/** A whole (small) beat: pads, bass, a lead line and half-time drums – for trying multi-part Beat Fit. */
export function fullBeatParts(): { name: string; notes: MidiNote[]; drums?: boolean }[] {
  const prog: [number, string][] = [[57, 'min'], [53, 'maj'], [60, 'maj'], [55, 'maj']];
  const pads = padProgression(prog).filter((n) => n.pitch >= 50); // upper voices only
  const bass: MidiNote[] = [];
  prog.forEach(([root], b) => [0, 6, 10].forEach((st) => bass.push({ tick: b * BAR + st * 240, length: st === 0 ? 1200 : 400, pitch: root - 24, velocity: 0.85 })));
  const leadLine = [76, 79, 76, 74, 72, 74, 76, 72];
  const lead: MidiNote[] = [];
  for (let b = 0; b < 4; b++) [4, 7, 12].forEach((st, i) => lead.push({ tick: b * BAR + st * 240, length: 420, pitch: leadLine[(b * 2 + i) % leadLine.length], velocity: 0.7 }));
  const drums: MidiNote[] = [];
  for (let b = 0; b < 4; b++) {
    [0, 10].forEach((st) => drums.push({ tick: b * BAR + st * 240, length: 120, pitch: 36, velocity: 0.95 }));
    drums.push({ tick: b * BAR + 8 * 240, length: 120, pitch: 38, velocity: 0.95 }); // backbeat on beat 3 = half-time
    for (let st = 0; st < 16; st += 2) drums.push({ tick: b * BAR + st * 240, length: 60, pitch: 42, velocity: 0.5 });
  }
  return [
    { name: 'Pads', notes: pads },
    { name: 'Bass 808', notes: bass },
    { name: 'Lead synth', notes: lead },
    { name: 'Drums', notes: drums, drums: true },
  ];
}

DEMO_BEATS['full-beat'] = { title: 'Full beat: pads + bass + lead + half-time drums (140 BPM)', bpm: 140, notes: () => fullBeatParts().filter((p) => !p.drums).flatMap((p) => p.notes) };

const _demoBeatFile = demoBeatFile;
export function demoBeatMidi(key: string): Uint8Array {
  return key === 'full-beat' ? buildMultiMidi(fullBeatParts(), 140, DEMO_BEATS[key].title) : _demoBeatFile(key);
}
