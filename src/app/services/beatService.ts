import type { BeatContext, BeatFit, GeneratorSettings, ScaleName } from '../../core/types';
import { parseMidi } from '../../core/midi/midi';
import { analyseBeat, keyName, barTicks } from '../../core/beat/analyze';
import { arrangementBarsFor, effectiveKey, beatRecipes, vocalKeyFit, type BeatRecipe } from '../../core/beat/fit';
import { DEMO_BEATS, demoBeatFile } from '../../core/demo/beats';
import { useStore, actions } from '../store/store';
import { generateIdeas } from './composeService';
import { platform } from '../platform/platform';

const st = () => useStore.getState();

/**
 * “Fit to my beat”: load a chord/arp MIDI from the user's beat, analyse it and
 * apply tempo, metre, key and arrangement length to the session.
 */
export function loadBeatBytes(bytes: Uint8Array, name: string): BeatContext | null {
  try {
    const parsed = parseMidi(bytes, name.replace(/\.midi?$/i, ''));
    const pitched = parsed.tracks.filter((t) => !t.percussion);
    const notes = (pitched.length ? pitched : parsed.tracks).flatMap((t) => t.notes);
    const beat = analyseBeat(notes, { name: name.replace(/\.midi?$/i, ''), bpm: parsed.bpm, timeSig: parsed.timeSig });
    const prev = st().doc.beat;
    if (prev) beat.fit = { ...prev.fit };
    applyBeat(beat, 'Load beat MIDI');
    const k = effectiveKey(beat);
    const dropped = parsed.tracks.length - pitched.length;
    st().toast(`Beat “${beat.name}”: ${keyName(k.root, k.scale)} · ${beat.chords.map((c) => c.symbol).join(' – ')}${beat.bpm ? ` · ${Math.round(beat.bpm)} BPM` : ''}${dropped ? ` · ${dropped} drum track(s) ignored` : ''}`, 'success');
    return beat;
  } catch (e) {
    st().toast(`Could not use “${name}” as a beat: ${(e as Error).message}`, 'error');
    return null;
  }
}

/** One undoable step: store the beat and align tempo, metre and length with it. */
function applyBeat(beat: BeatContext, label: string) {
  const bars = arrangementBarsFor(beat);
  st().commit(label, (d) => {
    d.beat = beat as any;
    if (beat.bpm) d.sequence.bpm = Math.round(beat.bpm * 100) / 100;
    d.sequence.timeSig = beat.timeSig;
    const empty = !d.sequence.events.length;
    if (empty || d.sequence.bars < bars) d.sequence.bars = bars;
    d.sequence.loop = { enabled: true, startTick: 0, endTick: d.sequence.bars * barTicks(beat.timeSig) };
  });
  const k = effectiveKey(beat);
  actions.setSettings({ keyRoot: k.root, scale: k.scale, transpose: true });
}

export function loadDemoBeat(key: string) {
  loadBeatBytes(demoBeatFile(key), `${DEMO_BEATS[key].title}.mid`);
}

export async function pickBeatFile() {
  const f = await platform.pickMidi();
  if (f) loadBeatBytes(f.bytes, f.name);
}

export function setBeatFit(patch: Partial<BeatFit>) {
  st().commit('Beat fit', (d) => {
    if (d.beat) Object.assign(d.beat.fit, patch);
  });
}

export function setBeatEnabled(enabled: boolean) {
  st().commit(enabled ? 'Use beat' : 'Ignore beat', (d) => {
    if (d.beat) d.beat.enabled = enabled;
  });
}

export function overrideKey(root: number | null, scale?: ScaleName) {
  st().commit('Beat key', (d) => {
    if (!d.beat) return;
    d.beat.keyOverride = root === null ? undefined : { root, scale: scale ?? d.beat.key.scale };
  });
  const b = st().doc.beat;
  if (b) actions.setSettings({ keyRoot: effectiveKey(b).root, scale: effectiveKey(b).scale });
}

export function removeBeat() {
  st().commit('Remove beat', (d) => {
    d.beat = undefined;
  });
}

export function recipesForCurrent(): BeatRecipe[] {
  const { doc } = st();
  return doc.beat ? beatRecipes(doc.beat, { sources: doc.sources.filter((s) => !s.missing).length }) : [];
}

/** Material made of slices that sit in the beat's key (plus unpitched sounds, which fit any key). */
export function inKeySliceIds(): string[] {
  const { doc } = st();
  if (!doc.beat) return [];
  const f = vocalKeyFit(doc.slices, doc.sources, doc.beat);
  return [...f.inKey, ...f.near, ...f.unpitched];
}

export function applyRecipe(r: BeatRecipe, run = true) {
  const { doc } = st();
  const beat = doc.beat;
  if (!beat) return;
  const patch: Partial<GeneratorSettings> = { ...r.settings };
  if (r.settings.mode === 'midi') {
    // the beat's own MIDI becomes the trigger guide
    const pitches = beat.notes.map((n) => n.pitch).sort((a, b) => a - b);
    patch.midi = { name: `${beat.name} (beat)`, notes: beat.notes, bpm: beat.bpm, mapping: 'rhythm-cycle', pitchMap: {}, usePitch: true, rootPitch: pitches[Math.floor(pitches.length / 2)] ?? 60, useVelocity: true, useDuration: true };
  }
  if (r.settings.mode === 'conversation') {
    const srcs = doc.sources.filter((s) => !s.missing);
    const ids = (sid: string) => doc.slices.filter((s) => s.sourceId === sid && s.level !== 'phrase').map((s) => s.id);
    patch.voiceA = ids(srcs[0].id);
    patch.voiceB = ids(srcs[1].id);
  }
  actions.setSettings(patch);
  setBeatFit(r.fit);
  if (run) {
    st().setUI({ view: 'compose' });
    generateIdeas(6);
  }
}
