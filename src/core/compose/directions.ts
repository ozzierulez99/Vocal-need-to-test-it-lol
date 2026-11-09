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
}

export const DIRECTIONS: Record<Direction, DirectionProfile> = {
  ethereal: {
    label: 'Ethereal / floating',
    blurb: 'Recurring dreamy fragments, subtle melodic movement, deliberate pauses.',
    density: 0.32, stride: 2, swing: 0, defaultFeel: 'hypnotic', gaps: 0.65, sustain: 0.8, stutter: 0.1,
    reverse: 0.18, overlap: 0.45, callResponse: 0.45, register: 0, fadeIn: 25, fadeOut: 120,
    accentContrast: 0.25, build: 0.2, contours: ['arch', 'descend', 'pendulum', 'valley'],
    controls: { recognisability: 0.55, repetition: 0.7, fragmentation: 0.3, space: 0.6, melodicMovement: 0.45, surprise: 0.25 },
  },
  playful: {
    label: 'Playful electronic',
    blurb: 'Bright syncopated hooks, rapid repeats, call-and-response, sudden interruptions.',
    density: 0.62, stride: 1, swing: 0.04, defaultFeel: 'bouncy', gaps: 0.3, sustain: 0.2, stutter: 0.55,
    reverse: 0.08, overlap: 0.1, callResponse: 0.7, register: 5, fadeIn: 3, fadeOut: 15,
    accentContrast: 0.8, build: 0.7, contours: ['pendulum', 'leap', 'ascend', 'arch'],
    controls: { recognisability: 0.5, repetition: 0.65, fragmentation: 0.55, space: 0.3, melodicMovement: 0.6, surprise: 0.45 },
  },
  emotional: {
    label: 'Emotional repetition',
    blurb: 'A held phrase that returns again and again, gaps before the important word.',
    density: 0.42, stride: 2, swing: 0, defaultFeel: 'bouncy', gaps: 0.55, sustain: 0.6, stutter: 0.15,
    reverse: 0.05, overlap: 0.25, callResponse: 0.35, register: 0, fadeIn: 10, fadeOut: 60,
    accentContrast: 0.4, build: 0.4, contours: ['descend', 'arch', 'static'],
    controls: { recognisability: 0.8, repetition: 0.85, fragmentation: 0.2, space: 0.5, melodicMovement: 0.35, surprise: 0.15 },
  },
  ambient: {
    label: 'Ambient texture',
    blurb: 'Isolated vowels and breaths, long rests, slow overlapping layers.',
    density: 0.12, stride: 4, swing: 0, defaultFeel: 'sparse', gaps: 0.9, sustain: 0.95, stutter: 0.02,
    reverse: 0.25, overlap: 0.75, callResponse: 0.2, register: -5, fadeIn: 180, fadeOut: 450,
    accentContrast: 0.1, build: 0.05, contours: ['static', 'valley', 'descend'],
    controls: { recognisability: 0.2, repetition: 0.6, fragmentation: 0.15, space: 0.85, melodicMovement: 0.2, surprise: 0.2 },
  },
  glitch: {
    label: 'Hyperactive glitch',
    blurb: 'Tiny retriggers, subdivision changes, reverse blips, sound/silence switching.',
    density: 0.78, stride: 1, swing: 0, defaultFeel: 'energetic', gaps: 0.35, sustain: 0.05, stutter: 0.9,
    reverse: 0.32, overlap: 0.05, callResponse: 0.3, register: 3, fadeIn: 1, fadeOut: 4,
    accentContrast: 0.7, build: 0.85, contours: ['leap', 'pendulum', 'ascend'],
    controls: { recognisability: 0.2, repetition: 0.55, fragmentation: 0.9, space: 0.25, melodicMovement: 0.55, surprise: 0.65 },
  },
  experimental: {
    label: 'Sparse experimental',
    blurb: 'Irregular groupings, unexpected silences and displaced fragments.',
    density: 0.3, stride: 1, swing: 0, defaultFeel: 'experimental', gaps: 0.7, sustain: 0.4, stutter: 0.35,
    reverse: 0.3, overlap: 0.3, callResponse: 0.4, register: -2, fadeIn: 8, fadeOut: 40,
    accentContrast: 0.6, build: 0.3, contours: ['leap', 'valley', 'static'],
    controls: { recognisability: 0.35, repetition: 0.4, fragmentation: 0.55, space: 0.7, melodicMovement: 0.5, surprise: 0.8 },
  },
  dance: {
    label: 'Dance riff (UKG / trance)',
    blurb: 'A tight, swung vocal riff locked to the groove with contrasting phrase endings.',
    density: 0.55, stride: 1, swing: 0.14, defaultFeel: 'syncopated', gaps: 0.35, sustain: 0.3, stutter: 0.4,
    reverse: 0.06, overlap: 0.1, callResponse: 0.55, register: 2, fadeIn: 3, fadeOut: 20,
    accentContrast: 0.7, build: 0.6, contours: ['pendulum', 'arch', 'static'],
    controls: { recognisability: 0.55, repetition: 0.75, fragmentation: 0.45, space: 0.3, melodicMovement: 0.45, surprise: 0.3 },
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
