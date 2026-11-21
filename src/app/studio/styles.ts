import type { ComposeMode, Direction, GeneratorSettings, Purpose } from '../../core/types';
import { DIRECTIONS } from '../../core/compose/directions';

export interface StudioStyle {
  id: string;
  label: string;
  icon: string;
  color: string;
  blurb: string;
  mode: ComposeMode;
  direction: Direction;
  /** part of the "All styles" batch */
  inMix: boolean;
}

export const STYLES: StudioStyle[] = [
  { id: 'float', label: 'Float', icon: '☁', color: '#8fd3ff', blurb: 'Pitched-up, breathy mantra. Half-time, airy, echo throws and scoops.', mode: 'melodic', direction: 'drain', inMix: true },
  { id: 'pop', label: 'Pop hook', icon: '✦', color: '#ff8fc8', blurb: 'A bright, syncopated hook that sticks: question, answer, resolve.', mode: 'melodic', direction: 'playful', inMix: true },
  { id: 'glitch', label: 'Glitch-pop', icon: '⚡', color: '#c18fff', blurb: 'Sugary hook with hard edits: stutters, octave jumps, zips and tape-stops.', mode: 'melodic', direction: 'hyperpop', inMix: true },
  { id: 'garage', label: 'Garage', icon: '♫', color: '#7fe0a8', blurb: 'Swung, pitched-up syllables bouncing against the beat. 2-step energy.', mode: 'rhythmic', direction: 'ukg', inMix: true },
  { id: 'trance', label: 'Trance lead', icon: '▲', color: '#6fb2ff', blurb: 'One vowel played like a synth: gated sixteenths, arps, rising fills.', mode: 'melodic', direction: 'trance', inMix: true },
  { id: 'dreamy', label: 'Dreamy', icon: '◌', color: '#a9b8ff', blurb: 'Floating fragments with deliberate pauses – classic future-bass chops.', mode: 'melodic', direction: 'ethereal', inMix: true },
  { id: 'emotional', label: 'Emotional', icon: '♡', color: '#ffb36b', blurb: 'A held phrase that keeps coming back, with a gap before the big word.', mode: 'melodic', direction: 'emotional', inMix: true },
  { id: 'dark', label: 'Dark', icon: '☾', color: '#9c8cff', blurb: 'Slowed, pitched-down and reversed fragments in a lot of space.', mode: 'melodic', direction: 'witch', inMix: true },
  { id: 'stutter', label: 'Stutter', icon: '⁂', color: '#ff7b7b', blurb: 'Tiny retriggers and glitch rolls built on a rhythmic idea.', mode: 'microchop', direction: 'glitch', inMix: true },
  { id: 'ambient', label: 'Ambient', icon: '∿', color: '#5ee0c1', blurb: 'Long vowel pads and breaths. Exports dry – add your own reverb.', mode: 'ghost', direction: 'ambient', inMix: true },
  { id: 'riff', label: 'Dance riff', icon: '◆', color: '#f5d76e', blurb: 'A tight, repeating vocal riff locked to the groove.', mode: 'rhythmic', direction: 'dance', inMix: false },
  { id: 'words', label: 'Words', icon: '❝', color: '#ffd9a0', blurb: 'Your words reordered, repeated and cut up – the phrase becomes the hook.', mode: 'phrase', direction: 'emotional', inMix: false },
];

export const styleById = (id?: string) => STYLES.find((s) => s.id === id);

export interface StudioTweaks {
  purpose: Purpose;
  energy: 'chill' | 'mid' | 'hype';
  register: 'low' | 'mid' | 'high';
  half: 'auto' | 'half' | 'normal';
}

export const DEFAULT_TWEAKS: StudioTweaks = { purpose: 'hook', energy: 'mid', register: 'mid', half: 'auto' };

/** Generator settings for a style (+ tweaks) on top of the session's (key, bars, beat). */
export function styleSettings(base: GeneratorSettings, st: StudioStyle, t: StudioTweaks = DEFAULT_TWEAKS): GeneratorSettings {
  const d = DIRECTIONS[st.direction];
  const controls = { ...d.controls };
  let complexity = base.complexity;
  if (t.energy === 'chill') {
    controls.space = Math.min(1, controls.space + 0.25);
    controls.fragmentation = Math.max(0, controls.fragmentation - 0.15);
    complexity = 0.3;
  } else if (t.energy === 'hype') {
    controls.space = Math.max(0, controls.space - 0.25);
    controls.fragmentation = Math.min(1, controls.fragmentation + 0.15);
    controls.surprise = Math.min(1, controls.surprise + 0.1);
    complexity = 0.75;
  } else complexity = 0.5;
  return {
    ...base,
    mode: st.mode,
    direction: st.direction,
    feel: d.defaultFeel,
    controls,
    complexity,
    layers: [],
    transpose: true,
    purpose: t.purpose,
    register: t.register,
    timeFeel: t.half,
    midi: undefined,
  };
}
