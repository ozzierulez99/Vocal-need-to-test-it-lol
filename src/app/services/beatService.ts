import type { BeatContext, BeatFit, BeatRole, GeneratorSettings, ScaleName, AudioData } from '../../core/types';
import { parseMidi } from '../../core/midi/midi';
import { analyseParts, keyName, barTicks, type PartInput } from '../../core/beat/analyze';
import { arrangementBarsFor, effectiveKey, beatRecipes, vocalKeyFit, type BeatRecipe } from '../../core/beat/fit';
import { DEMO_BEATS, demoBeatMidi } from '../../core/demo/beats';
import { BACKING_ID } from '../../core/project/project';
import { frameCount } from '../../core/audio/wav';
import { uid } from '../../core/ids';
import { useStore, actions } from '../store/store';
import { generateIdeas } from './composeService';
import { platform, decodeAudio } from '../platform/platform';
import { engine } from '../audio/engine';

const st = () => useStore.getState();

function partsOf(b: BeatContext): PartInput[] {
  return (b.parts ?? [{ id: 'part1', name: b.name, role: b.rhythm.kind === 'arp' ? 'arp' : 'chords', notes: b.notes }]).map((p) => ({ id: p.id, name: p.name, role: p.role, notes: p.notes, muted: p.muted }));
}

/** Re-run the analysis over a set of parts, keeping the user's fit settings and key override. */
function reanalyse(inputs: PartInput[], prev: BeatContext | undefined, meta: { name: string; bpm?: number; timeSig?: [number, number] }): BeatContext {
  const beat = analyseParts(inputs, meta);
  if (prev) {
    beat.fit = { ...prev.fit };
    beat.enabled = prev.enabled;
    beat.keyOverride = prev.keyOverride;
  }
  return beat;
}

/**
 * “Fit to my beat”: load MIDI from the user's beat (one or several tracks:
 * chords, bass, lead, drums), analyse it and align the session with it.
 * mode 'add' merges the file's tracks into the current beat as extra parts.
 */
export function loadBeatBytes(bytes: Uint8Array, name: string, mode: 'replace' | 'add' = 'replace'): BeatContext | null {
  try {
    const clean = name.replace(/\.midi?$/i, '');
    const parsed = parseMidi(bytes, clean);
    const prev = st().doc.beat;
    const fresh: PartInput[] = parsed.tracks.map((t) => ({ id: uid('part'), name: parsed.tracks.length > 1 ? t.name : clean, notes: t.notes, percussion: t.percussion }));
    const adding = mode === 'add' && !!prev;
    const inputs = adding ? [...partsOf(prev!), ...fresh] : fresh;
    const beat = reanalyse(inputs, prev && adding ? prev : prev ? { ...prev, keyOverride: undefined } : undefined, {
      name: adding ? prev!.name : clean,
      bpm: adding ? prev!.bpm ?? parsed.bpm : parsed.bpm,
      timeSig: adding ? prev!.timeSig : parsed.timeSig,
    });
    applyBeat(beat, adding ? 'Add beat part' : 'Load beat MIDI');
    const k = effectiveKey(beat);
    const roles = beat.parts!.map((p) => p.role);
    st().toast(
      `${adding ? 'Added to beat' : 'Beat'} “${beat.name}”: ${keyName(k.root, k.scale)} · ${beat.chords.map((c) => c.symbol).join(' – ')}${beat.bpm ? ` · ${Math.round(beat.bpm)} BPM` : ''}${beat.parts!.length > 1 ? ` · parts: ${roles.join(', ')}` : ''}${beat.rhythm.feel === 'half' ? ' · half-time' : ''}`,
      'success',
    );
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
  loadBeatBytes(demoBeatMidi(key), `${DEMO_BEATS[key].title}.mid`, 'replace');
}

export async function pickBeatFile(mode: 'replace' | 'add' = 'replace') {
  const f = await platform.pickMidi();
  if (f) loadBeatBytes(f.bytes, f.name, mode);
}

function updateParts(label: string, fn: (parts: PartInput[]) => PartInput[]) {
  const prev = st().doc.beat;
  if (!prev) return;
  try {
    const beat = reanalyse(fn(partsOf(prev)), prev, { name: prev.name, bpm: prev.bpm, timeSig: prev.timeSig });
    st().commit(label, (d) => {
      d.beat = beat as any;
    });
    const k = effectiveKey(beat);
    actions.setSettings({ keyRoot: k.root, scale: k.scale });
  } catch (e) {
    st().toast((e as Error).message, 'error');
  }
}

export const setPartRole = (id: string, role: BeatRole) => updateParts('Beat part role', (ps) => ps.map((p) => (p.id === id ? { ...p, role } : p)));
export const removePart = (id: string) => updateParts('Remove beat part', (ps) => ps.filter((p) => p.id !== id));
export const togglePartMute = (id: string) => updateParts('Mute beat part', (ps) => ps.map((p) => (p.id === id ? { ...p, muted: !p.muted } : p)));

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
    // the beat's own MIDI becomes the trigger guide (the arp or lead part if there is one)
    const part = beat.parts?.find((p) => p.role === 'arp') ?? beat.parts?.find((p) => p.role === 'lead');
    const notes = part?.notes ?? beat.notes;
    const pitches = notes.map((n) => n.pitch).sort((a, b) => a - b);
    patch.midi = { name: `${part?.name ?? beat.name} (beat)`, notes, bpm: beat.bpm, mapping: 'rhythm-cycle', pitchMap: {}, usePitch: true, rootPitch: pitches[Math.floor(pitches.length / 2)] ?? 60, useVelocity: true, useDuration: true, loopTicks: beat.lengthTicks };
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

/* ───────────── backing track (audio bounce of the beat, for reference) ───────────── */

export async function loadBackingBytes(bytes: Uint8Array, name: string): Promise<boolean> {
  try {
    const audio: AudioData = await decodeAudio(bytes, name);
    const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? 'wav').toLowerCase();
    const assetName = `backing_${Date.now().toString(36)}.${ext}`;
    const rt = st().rt;
    rt.audio.set(BACKING_ID, audio);
    rt.assets.set(assetName, bytes);
    engine.setAudio(BACKING_ID, audio);
    useStore.setState({ rtVersion: st().rtVersion + 1 });
    st().commit('Load backing track', (d) => {
      d.backing = { name: name.replace(/\.[^.]+$/, ''), assetName, sampleRate: audio.sampleRate, frames: frameCount(audio), channelCount: audio.channels.length, gain: -6, offsetMs: 0, enabled: true };
    });
    st().toast(`Backing track “${name}” loaded – it plays with the arrangement from bar 1 at the session tempo and is never exported`, 'success');
    return true;
  } catch (e) {
    st().toast(`Could not load backing audio: ${(e as Error).message}`, 'error');
    return false;
  }
}

export async function pickBacking() {
  const f = (await platform.pickAudio())[0];
  if (f) await loadBackingBytes(f.bytes, f.name);
}

export function setBacking(patch: Partial<NonNullable<ReturnType<typeof st>['doc']['backing']>>) {
  st().commit('Backing track', (d) => {
    if (d.backing) Object.assign(d.backing, patch);
  });
}

export function removeBacking() {
  st().commit('Remove backing track', (d) => {
    d.backing = undefined;
  });
}
