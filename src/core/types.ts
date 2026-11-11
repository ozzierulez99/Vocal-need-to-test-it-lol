/**
 * Core data model for Vocal Chop Studio.
 *
 * Everything here is plain serialisable data. Audio sample data never lives in
 * these structures – sources reference managed audio assets by file name and the
 * decoded PCM is held separately in an AudioData cache.
 */

/** Ticks per quarter note. All timeline positions are integer ticks. */
export const PPQ = 960;

export type SliceLevel = 'phrase' | 'word' | 'syllable' | 'sound';
export const SLICE_LEVELS: SliceLevel[] = ['phrase', 'word', 'syllable', 'sound'];

export type SliceCategory =
  | 'word'
  | 'syllable'
  | 'sustained-vowel'
  | 'short-vowel'
  | 'consonant'
  | 'breath'
  | 'whisper'
  | 'ad-lib'
  | 'hum'
  | 'sung-note'
  | 'spoken'
  | 'percussive'
  | 'other';

export const SLICE_CATEGORIES: SliceCategory[] = [
  'word',
  'syllable',
  'sustained-vowel',
  'short-vowel',
  'consonant',
  'breath',
  'whisper',
  'ad-lib',
  'hum',
  'sung-note',
  'spoken',
  'percussive',
  'other',
];

/** Musical roles. These change how the generator writes material for a layer. */
export type Role = 'lead' | 'rhythm' | 'response' | 'atmosphere' | 'accent' | 'transition';
export const ROLES: Role[] = ['lead', 'rhythm', 'response', 'atmosphere', 'accent', 'transition'];

/** Decoded PCM audio, independent of Web Audio so the core can run in Node. */
export interface AudioData {
  sampleRate: number;
  channels: Float32Array[];
}

export interface SourceAudio {
  id: string;
  name: string;
  /** File name of the managed copy inside the project's audio folder. */
  assetName: string;
  /** Where the audio originally came from (informational only). */
  originalPath?: string;
  kind: 'import' | 'recording' | 'derived';
  /** For derived sources (e.g. a loop-sustained vowel): what it was made from. */
  derivedFrom?: { sliceId: string; op: 'sustain'; seconds: number };
  sampleRate: number;
  channelCount: number;
  /** Length in frames. */
  frames: number;
  bpm?: number;
  /** Musical key, e.g. "A minor". Informational. */
  key?: string;
  /** Manually entered root MIDI note of the recording. */
  rootNote?: number;
  /** Set when the managed audio could not be found while loading. */
  missing?: boolean;
  createdAt: number;
}

/** Simple, honest, approximate analysis features of a slice. */
export interface SliceAnalysis {
  rms: number;
  peak: number;
  /** 0..1 – how abruptly the slice starts (higher = sharper consonant attack). */
  attack: number;
  /** 0..1 – fraction of the slice that stays near its loudness plateau. */
  sustain: number;
  /** 0..1 – normalised zero-crossing rate (noisy/breathy material is high). */
  noisiness: number;
  /** Estimated MIDI pitch (fractional) or null when unpitched/unclear. */
  pitch: number | null;
  /** 0..1 confidence of the pitch estimate. */
  pitchConfidence: number;
  /** 0..1 normalised loudness. */
  intensity: number;
  /**
   * Frames from the slice start to its perceptual onset (where the vowel/energy
   * arrives). Events are pre-rolled by this much so the onset lands on the grid.
   */
  onset?: number;
}

export interface Slice {
  id: string;
  sourceId: string;
  /** Start frame in the source (inclusive). */
  start: number;
  /** End frame in the source (exclusive). */
  end: number;
  name: string;
  level: SliceLevel;
  parentId?: string;
  category?: SliceCategory;
  tags: string[];
  favourite: boolean;
  /** Manual root note override (MIDI). */
  rootNote?: number;
  /** Preferred musical role, used as a soft tendency by the generator. */
  role?: Role;
  notes?: string;
  analysis?: SliceAnalysis;
  /** Stable ordinal of the slice inside its source (left-to-right), for phrase work. */
  order?: number;
}

export interface Track {
  id: string;
  name: string;
  role: Role;
  mute: boolean;
  solo: boolean;
  /** dB */
  gain: number;
  /** -1..1 */
  pan: number;
  /** Whole-layer lock: regeneration never touches this track. */
  locked: boolean;
  /** Rhythm lock: regeneration keeps onsets/gates/dynamics and only re-chooses slices & pitches. */
  rhythmLocked?: boolean;
  /** Choke (sampler-style mono): a new event cuts the previous one on this layer. */
  choke?: boolean;
  color: string;
  filter?: TrackFilter;
}

export interface TrackFilter {
  type: 'off' | 'lowpass' | 'highpass';
  /** Hz */
  frequency: number;
}

export interface SeqEvent {
  id: string;
  trackId: string;
  sliceId: string;
  /** Timeline position in ticks. */
  tick: number;
  /** Gate length in ticks – playback is cut (with fade) at this length. */
  length: number;
  /** Offset into the slice in frames (source frames). Used for microchops. */
  offset: number;
  /** dB */
  gain: number;
  /** Transposition in semitones, realised as playback-rate change (pitch + duration). */
  semitones: number;
  reverse: boolean;
  /** milliseconds */
  fadeIn: number;
  /** milliseconds */
  fadeOut: number;
  /** -1..1, added to the track pan. */
  pan: number;
  /** 0..1, used for MIDI export / accents. */
  velocity: number;
  locked: boolean;
  role?: Role;
  motifId?: string;
  /** Free-form tag describing the generator's intention (e.g. "call", "answer", "stutter"). */
  gesture?: string;
  /** Pitch scoop at the start: [semitone offset at the start, milliseconds to reach the note]. */
  glideIn?: [number, number];
  /** Pitch fall/rise at the end: [semitone offset reached at the end, milliseconds]. Tape-stop = negative. */
  glideOut?: [number, number];
  /** Set false to start the slice exactly on the grid instead of pre-rolling to its onset. */
  align?: boolean;
}

/** Sequence-wide feel applied at playback/export time (non-destructive). */
export interface Groove {
  /** 0..0.5 – delay of off-beat sixteenths as a fraction of a sixteenth (0.33 ≈ triplet swing). */
  swing: number;
  /** 0..1 – small deterministic timing and level variations. */
  humanize: number;
}

export type MotifProtection = 'preserve' | 'develop' | 'transform' | 'replace';

export interface MotifNote {
  /** Offset from motif start in ticks. */
  tick: number;
  length: number;
  sliceId: string;
  semitones: number;
  offset: number;
  reverse: boolean;
  accent: number;
  /** Hook-scale step this note was written on (lets development move it musically). */
  step?: number;
  /** Chord-arpeggio index: the note follows the chord underneath (0 = root, 1 = next chord tone, …). */
  arp?: number;
}

export interface Motif {
  id: string;
  name: string;
  /** Total span in ticks. */
  span: number;
  notes: MotifNote[];
  protection: MotifProtection;
  /** When true regeneration treats the motif as important. */
  important: boolean;
}

export interface LockedRest {
  id: string;
  /** null = all tracks */
  trackId: string | null;
  startTick: number;
  endTick: number;
}

export type ComposeMode =
  | 'melodic'
  | 'rhythmic'
  | 'phrase'
  | 'ghost'
  | 'microchop'
  | 'midi'
  | 'conversation';

export type Direction =
  | 'ethereal'
  | 'playful'
  | 'emotional'
  | 'ambient'
  | 'glitch'
  | 'experimental'
  | 'dance'
  | 'drain'
  | 'hyperpop'
  | 'trance'
  | 'ukg'
  | 'witch';

/** What the part is for in a song – changes form, density and placement. */
export type Purpose = 'hook' | 'verse' | 'build' | 'drop' | 'intro' | 'outro';

export type TimeFeel = 'auto' | 'normal' | 'half';

export type RhythmFeel =
  | 'bouncy'
  | 'tight'
  | 'syncopated'
  | 'sparse'
  | 'energetic'
  | 'broken'
  | 'experimental'
  | 'hypnotic';

export type ConversationRelation =
  | 'call-response'
  | 'alternating'
  | 'interrupt'
  | 'imitate'
  | 'overlap-growth'
  | 'complementary'
  | 'ostinato'
  | 'fragmenting';

export type MidiMapping = 'single' | 'pitch-map' | 'rhythm-cycle';

export interface CreativeControls {
  /** 0 = abstract fragments, 1 = full words/phrases */
  recognisability: number;
  repetition: number;
  fragmentation: number;
  space: number;
  melodicMovement: number;
  surprise: number;
}

export interface GeneratorSettings {
  mode: ComposeMode;
  direction: Direction;
  feel: RhythmFeel;
  seed: number;
  bars: number;
  phraseBars: number;
  /** Scale root pitch class 0-11, or null to use natural source pitch only. */
  keyRoot: number | null;
  scale: ScaleName;
  /** Whether to transpose slices to the scale (playback-rate transposition). */
  transpose: boolean;
  register: 'low' | 'mid' | 'high';
  complexity: number;
  controls: CreativeControls;
  /** Which roles/layers to write. Empty = mode defaults. */
  layers: Role[];
  /** Restrict material to these slices (empty = all usable slices). */
  sliceIds: string[];
  /** UI label of how the material was chosen (e.g. "favourites", "source:<id>"). */
  materialKey?: string;
  /** Song-section purpose (default: hook). */
  purpose?: Purpose;
  /** Half-time phrasing (auto = decided from style, tempo and the beat). */
  timeFeel?: TimeFeel;
  /** Conversation settings */
  voiceA?: string[];
  voiceB?: string[];
  relation?: ConversationRelation;
  /** MIDI guided settings */
  midi?: MidiGuide;
}

export type ScaleName =
  | 'minor'
  | 'major'
  | 'dorian'
  | 'phrygian'
  | 'minor-pentatonic'
  | 'major-pentatonic'
  | 'harmonic-minor'
  | 'chromatic';

export interface MidiNote {
  tick: number;
  length: number;
  pitch: number;
  velocity: number;
}

export interface MidiGuide {
  name: string;
  notes: MidiNote[];
  /** Source MIDI tempo if known. */
  bpm?: number;
  mapping: MidiMapping;
  /** Pitch-map: MIDI pitch → slice id. */
  pitchMap: Record<number, string>;
  /** Whether note pitch is applied as playback-rate transposition. */
  usePitch: boolean;
  /** Reference pitch: notes at this pitch play untransposed. */
  rootPitch: number;
  useVelocity: boolean;
  useDuration: boolean;
  /** When set, the guide repeats every `loopTicks` (e.g. a beat loop used as the guide). */
  loopTicks?: number;
}

/* ───────────── Beat context (“Fit to my beat”) ───────────── */

export interface BeatChord {
  tick: number;
  length: number;
  root: number;
  quality: 'maj' | 'min' | 'dim' | 'aug' | 'sus2' | 'sus4' | '7' | 'maj7' | 'm7' | 'note';
  symbol: string;
  /** pitch classes of the chord */
  pcs: number[];
}

export interface BeatKey {
  root: number;
  scale: ScaleName;
  /** 0..1 */
  confidence: number;
  alternatives: { root: number; scale: ScaleName; score: number }[];
}

export interface BeatRhythm {
  /** onset occupancy per sixteenth step of one bar, 0..1 (fraction of bars with an onset there) */
  steps: number[];
  /** fraction of time per step where something is sounding, 0..1 */
  sounding: number[];
  onsetsPerBeat: number;
  syncopation: number;
  /** average note length relative to the gap to the next onset (1 = legato/pads) */
  sustain: number;
  /** chords: mostly simultaneous notes; arp: fast single-note runs; melody: slower single notes */
  kind: 'chords' | 'arp' | 'melody' | 'mixed';
  /** median MIDI pitch */
  register: number;
  /** onset density per bar of the loop, 0..1 relative to the busiest bar */
  densityPerBar: number[];
  /** typical bars between chord changes */
  harmonicRhythm: number;
  /** half-time when the drums put the backbeat on beat 3 (only known when drums were supplied) */
  feel?: 'half' | 'normal';
}

/** Fit options the user controls. */
export interface BeatFit {
  /** Snap pitched vocal notes toward the chord sounding underneath. */
  harmonize: boolean;
  /** complement: keep chops out of the beat's busiest steps; follow: lock chops onto the beat's rhythm. */
  rhythm: 'complement' | 'follow' | 'off';
  /** Play a quiet synth preview of the MIDI under the vocals (never exported). */
  preview: boolean;
  previewGain: number;
}

export interface BeatContext {
  name: string;
  notes: MidiNote[];
  bpm?: number;
  timeSig: [number, number];
  /** loop length in ticks (whole bars) */
  lengthTicks: number;
  key: BeatKey;
  /** user override of the detected key */
  keyOverride?: { root: number; scale: ScaleName };
  chords: BeatChord[];
  rhythm: BeatRhythm;
  fit: BeatFit;
  enabled: boolean;
  /** The MIDI parts the beat was built from (chords, bass, lead, drums…). */
  parts?: BeatPart[];
  /** Drum pattern per sixteenth of the bar (0..1 occupancy), when drums were supplied. */
  drums?: { kick: number[]; snare: number[]; hat: number[] };
  /** The beat's own lead melody: where it plays (per sixteenth) and its register. */
  lead?: { steps: number[]; low: number; high: number; median: number };
}

export type BeatRole = 'chords' | 'arp' | 'bass' | 'lead' | 'drums';

export interface BeatPart {
  id: string;
  name: string;
  role: BeatRole;
  notes: MidiNote[];
  /** silent in the preview synth */
  muted?: boolean;
}

/** A bounce of the user's beat, played in sync for reference (never exported). */
export interface BackingTrack {
  name: string;
  assetName: string;
  sampleRate: number;
  frames: number;
  channelCount: number;
  /** dB */
  gain: number;
  /** milliseconds the audio is shifted later (negative = earlier) */
  offsetMs: number;
  enabled: boolean;
}

export interface CandidateMetrics {
  density: number;
  repetition: number;
  pitchSpread: number;
  fragmentation: number;
  syncopation: number;
  silence: number;
  variety: number;
}

export interface Candidate {
  id: string;
  label: string;
  profile: string;
  settings: GeneratorSettings;
  tracks: Track[];
  events: SeqEvent[];
  motifs: Motif[];
  metrics: CandidateMetrics;
  description: string[];
  favourite: boolean;
  createdAt: number;
  /** Candidate generated as a variation of another. */
  parentId?: string;
  /** Feel (swing / humanise) that belongs to this idea. */
  groove?: Groove;
  /** Hook critic result: 0–100 plus the reasons behind it. */
  score?: HookScore;
}

export interface HookScore {
  total: number;
  parts: { rhythm: number; melody: number; sound: number; fit: number };
  /** short human-readable reasons, best first */
  good: string[];
  watch: string[];
}

export interface Sequence {
  id: string;
  name: string;
  bpm: number;
  timeSig: [number, number];
  bars: number;
  tracks: Track[];
  events: SeqEvent[];
  motifs: Motif[];
  lockedBars: number[];
  lockedRests: LockedRest[];
  loop: { enabled: boolean; startTick: number; endTick: number };
  /** Grid resolution in ticks. */
  grid: number;
  snap: boolean;
  settings: GeneratorSettings;
  groove?: Groove;
}

export interface SliceCollection {
  id: string;
  name: string;
  sliceIds: string[];
  /** Saved event phrase (relative ticks) for reusable phrases. */
  phrase?: { events: Omit<SeqEvent, 'id' | 'trackId'>[]; span: number };
}

export interface ExportSettings {
  sampleRate: number;
  bitDepth: 16 | 24 | 32;
  /** prevent-clip scales down only when the mix would clip; normalize targets -1 dBFS. */
  level: 'none' | 'prevent-clip' | 'normalize';
  /** Short protective fade at every event boundary (ms). */
  clickFadeMs: number;
  tail: 'cut' | 'keep' | 'wrap';
}

export interface ProjectDoc {
  version: number;
  name: string;
  sources: SourceAudio[];
  slices: Slice[];
  sequence: Sequence;
  collections: SliceCollection[];
  candidates: Candidate[];
  exportSettings: ExportSettings;
  /** Default protective fade for playback (ms). */
  clickFadeMs: number;
  /** MIDI guides imported into the project. */
  midiGuides: MidiGuide[];
  /** Optional beat context (chord progression / arp MIDI from the user's beat). */
  beat?: BeatContext;
  /** Optional audio bounce of the beat for auditioning in context. */
  backing?: BackingTrack;
  /** Audition effects (monitoring only unless printed on export). */
  fx?: AuditionFx;
}

export interface AuditionFx {
  reverb: number; // 0..1 send
  delay: number; // 0..1 send
  /** print the audition effects into exported audio */
  print: boolean;
}
