import type { CreativeControls, Direction, RhythmFeel } from '../types';
import { clamp } from '../time';

/**
 * A creative direction is a set of compositional tendencies. These numbers are
 * read by every writer (rhythm density, gate behaviour, gap placement, stutters,
 * overlaps, register) – they are not output presets.
 */
export interface DirectionProfile {
  label: string;
  blurb: string;
  density: number;
  /** Preferred base subdivision in steps of 1/16: 1 = 16ths, 2 = 8ths, 4 = quarters */
  stride: number;
  swing: number;
  defaultFeel: RhythmFeel;
  /** Tendency to leave deliberate gaps */
  gaps: number;
  /** Tendency for long gates / sustained material */
  sustain: number;
  stutter: number;
  reverse: number;
  overlap: number;
  callResponse: number;
  /** Semitone register bias applied to transposition targets */
  register: number;
  /** Fade style in ms */
  fadeIn: number;
  fadeOut: number;
  accentContrast: number;
  /** Tendency for density to build toward section ends */
  build: number;
  /** Bias for melodic contours */
  contours: string[];
  /** Default creative controls when this direction is chosen */
  controls: CreativeControls;
  /** Style traits: the devices and feel that make the style recognisable. */
  traits: StyleTraits;
}

export interface StyleTraits {
  /** rhythm families the hook is drawn from (see hook.ts), most typical first */
  rhythms: string[];
  /** 0..1 – stay on the pentatonic subset of the key */
  pentatonic: number;
  /** 0..1 – play the hook on one slice like a sampler instrument */
  monoSlice: number;
  /** semitone lifts of the lead above the voice's natural pitch to choose from */
  lifts: number[];
  /** 0..1 – pitch scoops into accented notes */
  glide: number;
  /** 0..1 – octave jumps inside repeated notes */
  octaveJump: number;
  /** 0..1 – echo throws (arranged delay repeats) in gaps */
  echo: number;
  /** 0..1 – trance-gate long notes */
  gate: number;
  /** 0..1 – arpeggiate the chords */
  arp: number;
  /** 0..1 – octave / fifth doubles on big moments */
  stack: number;
  /** 0..1 – tape-stop falls at phrase ends */
  tapeStop: number;
  /** groove */
  swing: number;
  humanize: number;
  /** 0..1 – preference for half-time phrasing at fast tempos */
  half: number;
  /** 0 legato … 1 staccato */
  staccato: number;
  /** fill vocabulary for section changes, most typical first */
  fills: string[];
}

const T = (t: Partial<StyleTraits>): StyleTraits => ({
  rhythms: ['pop', 'tresillo'], pentatonic: 0.6, monoSlice: 0.4, lifts: [0], glide: 0.15, octaveJump: 0.1, echo: 0.2, gate: 0.05, arp: 0.1,
  stack: 0.1, tapeStop: 0.05, swing: 0, humanize: 0.15, half: 0.2, staccato: 0.3, fills: ['roll', 'cut', 'swell', 'breath'], ...t,
});

export const DIRECTIONS: Record<Direction, DirectionProfile> = {
  ethereal: {
    label: 'Ethereal / floating',
    blurb: 'Recurring dreamy fragments, subtle melodic movement, deliberate pauses.',
    density: 0.32, stride: 2, swing: 0, defaultFeel: 'hypnotic', gaps: 0.65, sustain: 0.8, stutter: 0.1,
    reverse: 0.18, overlap: 0.45, callResponse: 0.45, register: 0, fadeIn: 25, fadeOut: 120,
    accentContrast: 0.25, build: 0.2, contours: ['arch', 'descend', 'pendulum', 'valley'],
    controls: { recognisability: 0.55, repetition: 0.7, fragmentation: 0.3, space: 0.6, melodicMovement: 0.45, surprise: 0.25 },
    traits: T({ rhythms: ['float', 'tresillo'], pentatonic: 0.8, monoSlice: 0.6, lifts: [0, 0, 5], glide: 0.35, echo: 0.5, gate: 0.15, half: 0.7, staccato: 0.15, humanize: 0.25, fills: ['swell', 'echo', 'breath', 'cut'] }),
  },
  playful: {
    label: 'Playful electronic',
    blurb: 'Bright syncopated hooks, rapid repeats, call-and-response, sudden interruptions.',
    density: 0.62, stride: 1, swing: 0.04, defaultFeel: 'bouncy', gaps: 0.3, sustain: 0.2, stutter: 0.55,
    reverse: 0.08, overlap: 0.1, callResponse: 0.7, register: 5, fadeIn: 3, fadeOut: 15,
    accentContrast: 0.8, build: 0.7, contours: ['pendulum', 'leap', 'ascend', 'arch'],
    controls: { recognisability: 0.5, repetition: 0.65, fragmentation: 0.55, space: 0.3, melodicMovement: 0.6, surprise: 0.45 },
    traits: T({ rhythms: ['pop', 'tresillo', 'glitch'], pentatonic: 0.7, monoSlice: 0.45, lifts: [0, 5, 7, 12], glide: 0.3, octaveJump: 0.4, echo: 0.25, stack: 0.3, tapeStop: 0.2, staccato: 0.5, fills: ['zipper', 'roll', 'triplet', 'cut', 'pitchrise'] }),
  },
  emotional: {
    label: 'Emotional repetition',
    blurb: 'A held phrase that returns again and again, gaps before the important word.',
    density: 0.42, stride: 2, swing: 0, defaultFeel: 'bouncy', gaps: 0.55, sustain: 0.6, stutter: 0.15,
    reverse: 0.05, overlap: 0.25, callResponse: 0.35, register: 0, fadeIn: 10, fadeOut: 60,
    accentContrast: 0.4, build: 0.4, contours: ['descend', 'arch', 'static'],
    controls: { recognisability: 0.8, repetition: 0.85, fragmentation: 0.2, space: 0.5, melodicMovement: 0.35, surprise: 0.15 },
    traits: T({ rhythms: ['tresillo', 'float', 'pop'], pentatonic: 0.7, monoSlice: 0.5, lifts: [0, 0, 3], glide: 0.3, echo: 0.4, half: 0.5, staccato: 0.2, humanize: 0.25, fills: ['cut', 'echo', 'breath', 'swell'] }),
  },
  ambient: {
    label: 'Ambient texture',
    blurb: 'Isolated vowels and breaths, long rests, slow overlapping layers.',
    density: 0.12, stride: 4, swing: 0, defaultFeel: 'sparse', gaps: 0.9, sustain: 0.95, stutter: 0.02,
    reverse: 0.25, overlap: 0.75, callResponse: 0.2, register: -5, fadeIn: 180, fadeOut: 450,
    accentContrast: 0.1, build: 0.05, contours: ['static', 'valley', 'descend'],
    controls: { recognisability: 0.2, repetition: 0.6, fragmentation: 0.15, space: 0.85, melodicMovement: 0.2, surprise: 0.2 },
    traits: T({ rhythms: ['dark', 'float'], pentatonic: 0.8, monoSlice: 0.5, lifts: [-12, -7, -5, 0], glide: 0.2, echo: 0.5, half: 1, staccato: 0, humanize: 0.3, fills: ['swell', 'breath', 'echo'] }),
  },
  glitch: {
    label: 'Hyperactive glitch',
    blurb: 'Tiny retriggers, subdivision changes, reverse blips, sound/silence switching.',
    density: 0.78, stride: 1, swing: 0, defaultFeel: 'energetic', gaps: 0.35, sustain: 0.05, stutter: 0.9,
    reverse: 0.32, overlap: 0.05, callResponse: 0.3, register: 3, fadeIn: 1, fadeOut: 4,
    accentContrast: 0.7, build: 0.85, contours: ['leap', 'pendulum', 'ascend'],
    controls: { recognisability: 0.2, repetition: 0.55, fragmentation: 0.9, space: 0.25, melodicMovement: 0.55, surprise: 0.65 },
    traits: T({ rhythms: ['glitch', 'pop'], pentatonic: 0.5, monoSlice: 0.3, lifts: [0, 7, 12], glide: 0.25, octaveJump: 0.5, tapeStop: 0.4, stack: 0.2, staccato: 0.8, humanize: 0, fills: ['zipper', 'triplet', 'tapestop', 'cut', 'pitchrise'] }),
  },
  experimental: {
    label: 'Sparse experimental',
    blurb: 'Irregular groupings, unexpected silences and displaced fragments.',
    density: 0.3, stride: 1, swing: 0, defaultFeel: 'experimental', gaps: 0.7, sustain: 0.4, stutter: 0.35,
    reverse: 0.3, overlap: 0.3, callResponse: 0.4, register: -2, fadeIn: 8, fadeOut: 40,
    accentContrast: 0.6, build: 0.3, contours: ['leap', 'valley', 'static'],
    controls: { recognisability: 0.35, repetition: 0.4, fragmentation: 0.55, space: 0.7, melodicMovement: 0.5, surprise: 0.8 },
    traits: T({ rhythms: ['dark', 'glitch', 'garage'], pentatonic: 0.3, monoSlice: 0.3, lifts: [-7, 0, 7], glide: 0.3, echo: 0.3, tapeStop: 0.3, fills: ['cut', 'tapestop', 'swell', 'triplet'] }),
  },
  dance: {
    label: 'Dance riff (UKG / trance)',
    blurb: 'A tight, swung vocal riff locked to the groove with contrasting phrase endings.',
    density: 0.55, stride: 1, swing: 0.14, defaultFeel: 'syncopated', gaps: 0.35, sustain: 0.3, stutter: 0.4,
    reverse: 0.06, overlap: 0.1, callResponse: 0.55, register: 2, fadeIn: 3, fadeOut: 20,
    accentContrast: 0.7, build: 0.6, contours: ['pendulum', 'arch', 'static'],
    controls: { recognisability: 0.55, repetition: 0.75, fragmentation: 0.45, space: 0.3, melodicMovement: 0.45, surprise: 0.3 },
    traits: T({ rhythms: ['garage', 'pump', 'tresillo', 'pop'], pentatonic: 0.6, monoSlice: 0.5, lifts: [0, 3, 5], glide: 0.2, echo: 0.3, gate: 0.2, arp: 0.25, stack: 0.2, swing: 0.14, staccato: 0.5, fills: ['roll', 'pitchrise', 'echo', 'cut'] }),
  },
  drain: {
    label: 'Drain / cloud (floating, pitched)',
    blurb: 'A short breathy fragment pitched up and repeated like a mantra: half-time, lots of air, echo throws, scoops.',
    density: 0.3, stride: 2, swing: 0, defaultFeel: 'hypnotic', gaps: 0.65, sustain: 0.55, stutter: 0.25,
    reverse: 0.2, overlap: 0.3, callResponse: 0.5, register: 0, fadeIn: 6, fadeOut: 70,
    accentContrast: 0.35, build: 0.25, contours: ['pendulum', 'descend', 'static', 'arch'],
    controls: { recognisability: 0.4, repetition: 0.8, fragmentation: 0.4, space: 0.6, melodicMovement: 0.4, surprise: 0.25 },
    traits: T({ rhythms: ['float', 'tresillo', 'pump'], pentatonic: 0.9, monoSlice: 0.75, lifts: [5, 7, 7, 12, 3], glide: 0.5, octaveJump: 0.2, echo: 0.65, gate: 0.35, arp: 0.2, stack: 0.15, tapeStop: 0.15, humanize: 0.3, half: 0.95, staccato: 0.25, fills: ['echo', 'swell', 'cut', 'gate', 'breath'] }),
  },
  hyperpop: {
    label: 'Hyperpop / glitch-pop',
    blurb: 'A sugary pitched-up hook with hard edits: stutters, octave jumps, zipper fills, tape-stops and sudden silences.',
    density: 0.66, stride: 1, swing: 0, defaultFeel: 'bouncy', gaps: 0.35, sustain: 0.2, stutter: 0.7,
    reverse: 0.1, overlap: 0.05, callResponse: 0.65, register: 0, fadeIn: 1, fadeOut: 8,
    accentContrast: 0.9, build: 0.8, contours: ['leap', 'pendulum', 'ascend', 'arch'],
    controls: { recognisability: 0.45, repetition: 0.7, fragmentation: 0.6, space: 0.3, melodicMovement: 0.6, surprise: 0.5 },
    traits: T({ rhythms: ['pop', 'glitch', 'tresillo'], pentatonic: 0.75, monoSlice: 0.55, lifts: [7, 12, 12, 5, 0], glide: 0.35, octaveJump: 0.55, echo: 0.2, gate: 0.1, arp: 0.15, stack: 0.45, tapeStop: 0.45, humanize: 0, half: 0.1, staccato: 0.6, fills: ['zipper', 'tapestop', 'triplet', 'cut', 'pitchrise', 'roll'] }),
  },
  trance: {
    label: 'Trance / euphoric lead',
    blurb: 'One vowel played like a synth: gated sixteenths, chord arps, off-beat pumps and rising fills.',
    density: 0.62, stride: 1, swing: 0, defaultFeel: 'tight', gaps: 0.25, sustain: 0.35, stutter: 0.4,
    reverse: 0.12, overlap: 0.1, callResponse: 0.35, register: 0, fadeIn: 2, fadeOut: 18,
    accentContrast: 0.6, build: 0.85, contours: ['arch', 'ascend', 'pendulum'],
    controls: { recognisability: 0.25, repetition: 0.8, fragmentation: 0.5, space: 0.25, melodicMovement: 0.55, surprise: 0.2 },
    traits: T({ rhythms: ['arp', 'pump', 'tresillo'], pentatonic: 0.6, monoSlice: 0.9, lifts: [0, 5, 7, 12], glide: 0.2, octaveJump: 0.2, echo: 0.3, gate: 0.7, arp: 0.7, stack: 0.35, tapeStop: 0.05, humanize: 0, half: 0, staccato: 0.6, fills: ['pitchrise', 'roll', 'swell', 'gate', 'cut'] }),
  },
  ukg: {
    label: 'UK garage / 2-step',
    blurb: 'Pitched-up words and syllables shuffling against the beat: swung sixteenths, call and response, tight cuts.',
    density: 0.5, stride: 1, swing: 0.2, defaultFeel: 'syncopated', gaps: 0.4, sustain: 0.3, stutter: 0.35,
    reverse: 0.05, overlap: 0.1, callResponse: 0.8, register: 0, fadeIn: 2, fadeOut: 15,
    accentContrast: 0.7, build: 0.5, contours: ['pendulum', 'static', 'arch'],
    controls: { recognisability: 0.65, repetition: 0.75, fragmentation: 0.4, space: 0.4, melodicMovement: 0.35, surprise: 0.3 },
    traits: T({ rhythms: ['garage', 'tresillo'], pentatonic: 0.7, monoSlice: 0.3, lifts: [3, 4, 5, 0], glide: 0.15, octaveJump: 0.15, echo: 0.35, gate: 0.05, arp: 0.1, stack: 0.1, tapeStop: 0.1, swing: 0.22, humanize: 0.15, half: 0, staccato: 0.5, fills: ['roll', 'echo', 'cut', 'triplet'] }),
  },
  witch: {
    label: 'Witch house / dark',
    blurb: 'Slowed, pitched-down fragments, reversed swells and triplet stutters in a lot of darkness.',
    density: 0.28, stride: 2, swing: 0, defaultFeel: 'sparse', gaps: 0.7, sustain: 0.7, stutter: 0.35,
    reverse: 0.4, overlap: 0.4, callResponse: 0.3, register: 0, fadeIn: 30, fadeOut: 150,
    accentContrast: 0.4, build: 0.3, contours: ['descend', 'static', 'valley'],
    controls: { recognisability: 0.35, repetition: 0.7, fragmentation: 0.35, space: 0.7, melodicMovement: 0.3, surprise: 0.4 },
    traits: T({ rhythms: ['dark', 'float'], pentatonic: 0.6, monoSlice: 0.6, lifts: [-12, -7, -5], glide: 0.3, octaveJump: 0.05, echo: 0.4, gate: 0.15, arp: 0.05, stack: 0.2, tapeStop: 0.35, humanize: 0.2, half: 1, staccato: 0.1, fills: ['swell', 'triplet', 'tapestop', 'cut'] }),
  },
};

export const FEEL_LABELS: Record<RhythmFeel, string> = {
  bouncy: 'Bouncy',
  tight: 'Tight',
  syncopated: 'Syncopated',
  sparse: 'Sparse',
  energetic: 'Energetic',
  broken: 'Broken',
  experimental: 'Experimental',
  hypnotic: 'Hypnotic',
};

/** Effective profile: direction tendencies nudged by the user's high-level controls. */
export function effectiveProfile(direction: Direction, c: CreativeControls): DirectionProfile {
  const d = DIRECTIONS[direction];
  return {
    ...d,
    density: clamp(d.density * (1.35 - c.space * 0.9) + c.fragmentation * 0.12, 0.04, 0.95),
    gaps: clamp(d.gaps * 0.5 + c.space * 0.6, 0, 1),
    stutter: clamp(d.stutter * 0.6 + c.fragmentation * 0.45, 0, 1),
    reverse: clamp(d.reverse + c.surprise * 0.12, 0, 0.6),
    sustain: clamp(d.sustain * (1 - c.fragmentation * 0.5), 0, 1),
  };
}

export const DEFAULT_CONTROLS: CreativeControls = DIRECTIONS.ethereal.controls;
