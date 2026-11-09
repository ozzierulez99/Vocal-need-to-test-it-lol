import type {
  GeneratorSettings,
  Motif,
  Role,
  SeqEvent,
  Sequence,
  Slice,
  SourceAudio,
  Track,
  LockedRest,
  BeatContext,
} from '../types';
import { buildMaterial, castMaterial, describeMaterial, type Material } from './material';
import { makeCtx, type Ctx, type Note } from './context';
import { planForm, describeForm } from './form';
import { createMotif, transformMotif, motifFromEvents } from './motif';
import { writeMotifLead, writeResponse, writeRhythm, writeAtmosphere, writeAccents, writeTransitions, applyCuts } from './writers';
import { writePhraseLead, writeMicroLead, writeMidiLead, writeConversation } from './modes';
import { DIRECTIONS, FEEL_LABELS } from './directions';
import { ticksPerBar } from '../time';
import { Rng } from '../rng';
import { effectiveKey, harmonize } from '../beat/fit';
import { keyName } from '../beat/analyze';

export const MODE_LABELS: Record<GeneratorSettings['mode'], string> = {
  melodic: 'Melodic Chop Composer',
  rhythmic: 'Rhythmic Vocal Composer',
  phrase: 'Phrase Reconstruction',
  ghost: 'Ghost Vocal Composer',
  microchop: 'Microchop & Stutter',
  midi: 'MIDI-Guided Composer',
  conversation: 'Vocal Conversation',
};

export const ROLE_COLORS: Record<Role, string> = {
  lead: '#ff6fa8',
  rhythm: '#5ee0c1',
  response: '#8f9bff',
  atmosphere: '#b48cff',
  accent: '#ffc861',
  transition: '#6fc3ff',
};

interface Layer {
  key: string;
  role: Role;
  name: string;
  notes: Note[];
}

export interface GenerateInput {
  settings: GeneratorSettings;
  slices: Slice[];
  sources: SourceAudio[];
  bpm: number;
  timeSig: [number, number];
  existing?: Pick<Sequence, 'tracks' | 'events' | 'motifs' | 'lockedBars' | 'lockedRests'>;
  /** Regenerate only inside this scope; everything else in `existing` is kept. */
  scope?: { startBar?: number; endBar?: number; trackIds?: string[] };
  /** Beat context: key/scale, chords and rhythm of the user's beat. */
  beat?: BeatContext;
}

export interface GenerateOutput {
  tracks: Track[];
  events: SeqEvent[];
  motifs: Motif[];
  description: string[];
}

export function defaultLayers(mode: GeneratorSettings['mode'], s: GeneratorSettings): Role[] {
  const p = DIRECTIONS[s.direction];
  const c = s.controls;
  switch (mode) {
    case 'melodic': {
      const l: Role[] = ['lead'];
      if (p.callResponse >= 0.45 && s.bars >= 2) l.push('response');
      if (p.sustain >= 0.6 && c.space >= 0.4) l.push('atmosphere');
      if (s.bars >= 4) l.push('transition');
      return l;
    }
    case 'rhythmic':
      return s.bars >= 4 ? ['lead', 'rhythm', 'accent', 'transition'] : ['lead', 'rhythm', 'accent'];
    case 'phrase':
      return p.sustain >= 0.8 ? ['lead', 'atmosphere'] : s.bars >= 4 ? ['lead', 'transition'] : ['lead'];
    case 'ghost':
      return ['lead', 'atmosphere', 'transition'];
    case 'microchop':
      return s.bars >= 4 ? ['lead', 'rhythm', 'transition'] : ['lead', 'rhythm'];
    case 'midi':
      return ['lead'];
    case 'conversation':
      return ['lead', 'response'];
  }
}

const TRACK_NAMES: Record<Role, string> = {
  lead: 'Lead hook',
  rhythm: 'Rhythm chops',
  response: 'Response',
  atmosphere: 'Atmosphere',
  accent: 'Accents',
  transition: 'Transitions',
};

function pickMats(mats: Material[], ids?: string[]) {
  if (!ids?.length) return [];
  const set = new Set(ids);
  return mats.filter((m) => set.has(m.slice.id));
}

/** Resolve the central motif, honouring importance and protection levels. */
function resolveMotif(ctx: Ctx, input: GenerateInput, kind: 'melodic' | 'rhythmic' | 'ghost' | 'micro'): Motif {
  const ex = input.existing;
  const valid = (m: Motif) => m.notes.length > 0 && m.notes.every((n) => ctx.matById.has(n.sliceId));
  const important = ex?.motifs.find((m) => m.important && m.protection !== 'replace' && valid(m));
  if (important) {
    if (important.protection === 'transform') {
      ctx.log.push(`Motif “${important.name}” transformed substantially (protection: transform)`);
      return { ...transformMotif(ctx, ctx.rng('transform'), important), id: important.id, protection: 'develop', important: true };
    }
    ctx.log.push(`Motif “${important.name}” ${important.protection === 'preserve' ? 'preserved exactly' : 'kept and developed'} (protection: ${important.protection})`);
    return important;
  }
  if (input.scope && ex) {
    // Local regeneration continues the existing identity.
    const prev = ex.motifs.find((m) => m.id === 'motif-main' && valid(m));
    if (prev) return { ...prev, protection: 'develop' };
    const leadTrack = ex.tracks.find((t) => t.role === 'lead');
    const leadEvents = ex.events.filter((e) => e.trackId === leadTrack?.id && e.tick < ctx.bar && ctx.matById.has(e.sliceId));
    const derived = motifFromEvents(leadEvents, 'motif-main', 'Derived motif', ctx.bar);
    if (derived) return { ...derived, protection: 'develop', important: false };
  }
  return createMotif(ctx, kind);
}

export function generate(input: GenerateInput): GenerateOutput {
  const beat = input.beat?.enabled ? input.beat : undefined;
  // the beat's key/scale drive all pitch decisions
  const s = beat ? { ...input.settings, keyRoot: effectiveKey(beat).root, scale: effectiveKey(beat).scale } : input.settings;
  const sliceFilter = s.sliceIds.length ? new Set(s.sliceIds) : null;
  const usable = input.slices.filter((sl) => !sliceFilter || sliceFilter.has(sl.id) || s.mode === 'conversation');
  const allMats = buildMaterial(usable, input.sources, s.controls);
  let mats = allMats;
  if (s.mode === 'conversation') {
    const ab = new Set([...(s.voiceA ?? []), ...(s.voiceB ?? [])]);
    mats = allMats.filter((m) => ab.has(m.slice.id));
    if (!mats.length) mats = allMats;
  }
  if (!mats.length) throw new Error('No usable slices: import audio and create slices first (or check that sources are not missing).');
  const cast = castMaterial(new Rng(`${s.seed}|cast`), mats, s.controls);
  const ctx = makeCtx(s, input.bpm, input.timeSig, mats, cast, beat);
  const form = planForm(ctx, s.mode);
  const layersWanted = (s.layers.length ? s.layers : defaultLayers(s.mode, s)).slice();
  if (s.mode !== 'conversation' && !layersWanted.includes('lead')) layersWanted.unshift('lead');
  const head = [
    `${MODE_LABELS[s.mode]} · ${DIRECTIONS[s.direction].label} · ${FEEL_LABELS[ctx.feel]} feel · seed ${s.seed}`,
    `Form: ${describeForm(form)}`,
  ];
  if (beat) head.push(`Fitted to beat “${beat.name}”: ${keyName(effectiveKey(beat).root, effectiveKey(beat).scale)}, ${beat.chords.map((c) => c.symbol).join('–')}`);
  const layers: Layer[] = [];
  const motifs: Motif[] = [];
  let leadNotes: Note[] = [];
  let central: Motif | null = null;

  if (s.mode === 'conversation') {
    const A = pickMats(allMats, s.voiceA);
    const B = pickMats(allMats, s.voiceB);
    const bySrc = Array.from(new Set(mats.map((m) => m.source.id)));
    const fallA = A.length ? A : mats.filter((m) => m.source.id === bySrc[0]);
    const fallB = B.length ? B : mats.filter((m) => m.source.id === (bySrc[1] ?? bySrc[0]));
    const r = writeConversation(ctx, form, fallA, fallB, s.relation ?? 'call-response');
    layers.push({ key: 'voice-a', role: 'lead', name: 'Voice A', notes: r.a });
    layers.push({ key: 'voice-b', role: 'response', name: 'Voice B', notes: r.b });
    if (r.under.length) layers.push({ key: 'ostinato', role: 'rhythm', name: 'Ostinato (B)', notes: r.under });
    leadNotes = r.a;
  } else {
    if (s.mode === 'phrase') {
      const anchorId = input.existing?.motifs.find((m) => m.important && m.notes.length)?.notes[0].sliceId;
      const r = writePhraseLead(ctx, form, anchorId);
      leadNotes = r.notes;
      central = { id: 'motif-anchor', name: `Anchor ${describeMaterial(r.anchor)}`, span: ctx.bar, notes: [{ tick: 0, length: ctx.beat, sliceId: r.anchor.slice.id, semitones: 0, offset: 0, reverse: false, accent: 1 }], protection: 'develop', important: false };
    } else if (s.mode === 'midi') {
      if (!s.midi) throw new Error('Import a MIDI file and select it as the guide first.');
      leadNotes = writeMidiLead(ctx, s.midi);
    } else {
      const kind = s.mode === 'melodic' ? 'melodic' : s.mode === 'rhythmic' ? 'rhythmic' : s.mode === 'ghost' ? 'ghost' : 'micro';
      ctx.leaveAnswerSpace = layersWanted.includes('response') && (s.mode === 'melodic' || s.mode === 'rhythmic') && ctx.prof.callResponse >= 0.45;
      central = resolveMotif(ctx, input, kind);
      head.push(`Central motif: ${central.name} – ${central.notes.length} notes over ${(central.span / ctx.beat).toFixed(0)} beats`);
      leadNotes = s.mode === 'microchop' ? writeMicroLead(ctx, form, central) : writeMotifLead(ctx, form, central, kind);
      if (s.mode === 'ghost') {
        // ghost hooks are sparse: only every other phrase states the hook
        leadNotes = leadNotes.filter((n) => Math.floor(n.tick / (ctx.phraseBars * ctx.bar)) % 2 === 0 || n.gesture === 'motif');
      }
    }
    if (central) motifs.push(central);
    let transitionCuts: { start: number; end: number }[] = [];
    const extra: Layer[] = [];
    for (const role of layersWanted) {
      if (role === 'lead') continue;
      if (role === 'response') extra.push({ key: 'response', role, name: TRACK_NAMES.response, notes: writeResponse(ctx, form, central ?? createMotif(ctx, 'melodic'), leadNotes) });
      if (role === 'rhythm') extra.push({ key: 'rhythm', role, name: s.mode === 'microchop' ? 'Chop grid' : TRACK_NAMES.rhythm, notes: writeRhythm(ctx, form, leadNotes) });
      if (role === 'atmosphere') {
        extra.push({ key: 'atmosphere', role, name: s.mode === 'ghost' ? 'Ghost layer A' : TRACK_NAMES.atmosphere, notes: writeAtmosphere(ctx, form, { delayBars: s.mode === 'ghost' && ctx.prof.gaps > 0.5 ? 1 : 0 }) });
        if (s.mode === 'ghost' && ctx.bars >= 4)
          extra.push({ key: 'atmosphere-2', role, name: 'Ghost layer B', notes: writeAtmosphere(ctx, form, { delayBars: Math.min(ctx.bars - 1, ctx.phraseBars * 2), variant: 1, pool: [...ctx.cast.breath, ...ctx.cast.pad].reverse() }) });
      }
      if (role === 'accent') extra.push({ key: 'accent', role, name: TRACK_NAMES.accent, notes: writeAccents(ctx, form) });
      if (role === 'transition') {
        const t = writeTransitions(ctx, form);
        transitionCuts = t.cuts;
        extra.push({ key: 'transition', role, name: TRACK_NAMES.transition, notes: t.notes });
      }
    }
    leadNotes = applyCuts(leadNotes, transitionCuts);
    for (const l of extra) if (l.role === 'response' || l.role === 'rhythm') l.notes = applyCuts(l.notes, transitionCuts);
    layers.push({ key: 'lead', role: 'lead', name: s.mode === 'phrase' ? 'Reconstructed phrase' : s.mode === 'ghost' ? 'Ghost hook' : TRACK_NAMES.lead, notes: leadNotes }, ...extra);
  }

  if (beat && beat.fit.harmonize && s.transpose) {
    // harmonise pitched material to the chord underneath (a preserved motif stays exactly as it is)
    const preserved = motifs.find((m) => m.important && m.protection === 'preserve');
    let n = 0;
    for (const l of layers) {
      n += harmonize(l.notes, beat, (id) => ctx.matById.get(id)?.pitch ?? null, {
        beatTicks: ctx.beat,
        role: l.role,
        skip: (x) => !!preserved && x.motifId === preserved.id && x.gesture === 'motif',
      });
    }
    if (n) ctx.log.push(`Harmonised ${n} note(s) to the chord underneath (playback-rate pitch)`);
  }

  const result = assemble(ctx, input, layers, motifs);
  result.description = [...head, ...ctx.log];
  return result;
}

function eventOverlaps(a: { tick: number; length: number }, b: { tick: number; length: number }) {
  return a.tick < b.tick + b.length && b.tick < a.tick + a.length;
}

/** Turn layers into tracks/events and merge with existing material honouring every lock. */
function assemble(ctx: Ctx, input: GenerateInput, layers: Layer[], motifs: Motif[]): GenerateOutput {
  const ex = input.existing;
  const bar = ticksPerBar(input.timeSig);
  const total = ctx.bars * bar;
  const scope = input.scope;
  const inScopeBars = (tick: number) => {
    if (!scope) return true;
    const b = Math.floor(tick / bar);
    return (scope.startBar === undefined || b >= scope.startBar) && (scope.endBar === undefined || b < scope.endBar);
  };
  const lockedBars = new Set(ex?.lockedBars ?? []);
  const rests: LockedRest[] = ex?.lockedRests ?? [];
  const exTracks = ex?.tracks ?? [];

  // map generated layers onto existing tracks so mixer settings & ids survive regeneration
  const usedExisting = new Set<string>();
  const trackFor = new Map<string, Track>();
  for (const l of layers) {
    const id = `trk-${l.key}`;
    let t = exTracks.find((x) => x.id === id && !usedExisting.has(x.id));
    if (!t && !scope) t = exTracks.find((x) => !usedExisting.has(x.id) && x.role === l.role && x.name === l.name);
    if (t) usedExisting.add(t.id);
    // an empty placeholder track adopts the generated layer's identity
    if (t && !(ex?.events ?? []).some((e) => e.trackId === t!.id)) t = { ...t, name: l.name, role: l.role, color: ROLE_COLORS[l.role] };
    trackFor.set(l.key, t ? { ...t } : { id, name: l.name, role: l.role, mute: false, solo: false, gain: 0, pan: 0, locked: false, color: ROLE_COLORS[l.role] });
  }
  const trackById = new Map(exTracks.map((t) => [t.id, t]));
  const inScopeTrack = (trackId: string) => !scope?.trackIds || scope.trackIds.includes(trackId);

  // existing events to keep
  const kept: SeqEvent[] = [];
  for (const e of ex?.events ?? []) {
    const t = trackById.get(e.trackId);
    if (!t) continue;
    const keep = e.locked || t.locked || lockedBars.has(Math.floor(e.tick / bar)) || (scope && (!inScopeBars(e.tick) || !inScopeTrack(e.trackId)));
    if (keep) kept.push(e);
  }
  const lockedKept = kept.filter((e) => e.locked || lockedBars.has(Math.floor(e.tick / bar)));

  const prefix = `g${(ctx.s.seed >>> 0).toString(36)}`;
  let n = 0;
  const keptIds = new Set(kept.map((e) => e.id));
  const newEvents: SeqEvent[] = [];
  for (const l of layers) {
    const track = trackFor.get(l.key)!;
    if (track.locked) continue;
    if (!inScopeTrack(track.id)) continue;
    const layerEvents: SeqEvent[] = [];
    for (const nt of l.notes) {
      if (nt.tick < 0 || nt.tick >= total) continue;
      if (lockedBars.has(Math.floor(nt.tick / bar))) continue;
      if (!inScopeBars(nt.tick)) continue;
      let length = Math.max(1, Math.round(nt.length));
      if (scope?.endBar !== undefined) length = Math.min(length, scope.endBar * bar - nt.tick);
      // deliberate silences are never filled
      let blocked = false;
      for (const r of rests) {
        if (r.trackId !== null && r.trackId !== track.id) continue;
        if (nt.tick >= r.startTick && nt.tick < r.endTick) blocked = true;
        else if (nt.tick < r.startTick && nt.tick + length > r.startTick) length = r.startTick - nt.tick;
      }
      if (blocked) continue;
      const ev: SeqEvent = {
        id: `${prefix}-e${(n++).toString(36)}`,
        trackId: track.id,
        sliceId: nt.sliceId,
        tick: Math.round(nt.tick),
        length,
        offset: Math.max(0, Math.round(nt.offset)),
        gain: Math.round(nt.gain * 10) / 10,
        semitones: nt.semitones,
        reverse: nt.reverse,
        fadeIn: nt.fadeIn,
        fadeOut: nt.fadeOut,
        pan: Math.max(-1, Math.min(1, nt.pan)),
        velocity: Math.max(0, Math.min(1, nt.velocity)),
        locked: false,
        role: l.role,
        motifId: nt.motifId,
        gesture: nt.gesture,
      };
      if (lockedKept.some((k) => k.trackId === ev.trackId && eventOverlaps(k, ev))) continue;
      while (keptIds.has(ev.id)) ev.id = `${ev.id}x`;
      layerEvents.push(ev);
    }
    if (track.rhythmLocked) {
      // Rhythm lock: keep this layer's onsets, gates and dynamics; take new slices/pitches from the generated material.
      const rhythm = (ex?.events ?? []).filter((e) => e.trackId === track.id && !keptIds.has(e.id)).sort((a, b) => a.tick - b.tick);
      if (rhythm.length && layerEvents.length) {
        const gen = layerEvents.slice().sort((a, b) => a.tick - b.tick);
        let j = 0;
        for (const r of rhythm) {
          while (j + 1 < gen.length && Math.abs(gen[j + 1].tick - r.tick) <= Math.abs(gen[j].tick - r.tick)) j++;
          const g = gen[j];
          let id = `${prefix}-r${(n++).toString(36)}`;
          while (keptIds.has(id)) id += 'x';
          newEvents.push({ ...r, id, sliceId: g.sliceId, semitones: g.semitones, reverse: g.reverse, offset: g.offset, motifId: undefined, gesture: 'rhythm-locked', locked: false });
        }
        continue;
      }
      if (rhythm.length) {
        newEvents.push(...rhythm);
        continue;
      }
    }
    newEvents.push(...layerEvents);
  }
  // tracks: keep existing ones (all, when scoped; otherwise only those still in use or locked/user-made)
  const genTracks = layers.map((l) => trackFor.get(l.key)!);
  const genIds = new Set(genTracks.map((t) => t.id));
  const keptTrackIds = new Set(kept.map((e) => e.trackId));
  const tracks: Track[] = [];
  for (const t of exTracks) {
    if (genIds.has(t.id)) tracks.push(genTracks.find((g) => g.id === t.id)!);
    else if (scope || t.locked || keptTrackIds.has(t.id) || !t.id.startsWith('trk-')) tracks.push(t);
  }
  for (const t of genTracks) if (!tracks.some((x) => x.id === t.id)) tracks.push(t);
  const events = [...kept, ...newEvents].sort((a, b) => a.tick - b.tick || a.trackId.localeCompare(b.trackId));
  // motifs: keep user motifs, replace generated ones
  const userMotifs = (ex?.motifs ?? []).filter((m) => m.important && !motifs.some((x) => x.id === m.id));
  return { tracks, events, motifs: [...motifs, ...userMotifs], description: [] };
}

export function defaultSettings(partial: Partial<GeneratorSettings> = {}): GeneratorSettings {
  const direction = partial.direction ?? 'ethereal';
  return {
    mode: 'melodic',
    direction,
    feel: DIRECTIONS[direction].defaultFeel,
    seed: 1,
    bars: 8,
    phraseBars: 2,
    keyRoot: 9,
    scale: 'minor',
    transpose: true,
    register: 'mid',
    complexity: 0.5,
    controls: { ...DIRECTIONS[direction].controls },
    layers: [],
    sliceIds: [],
    relation: 'call-response',
    ...partial,
  };
}
