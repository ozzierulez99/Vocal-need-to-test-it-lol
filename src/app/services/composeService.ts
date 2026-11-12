import type { Candidate, Direction, GeneratorSettings } from '../../core/types';
import { DIRECTIONS } from '../../core/compose/directions';
import { generate } from '../../core/compose/engine';
import { generateCandidates, generateVariations, reassignSlices } from '../../core/compose/candidates';
import { ticksPerBar } from '../../core/time';
import { useStore, actions } from '../store/store';
import { ensurePads } from './projectService';

const st = () => useStore.getState();

export function effectiveSettings(): GeneratorSettings {
  const { doc } = st();
  const s = doc.sequence.settings;
  return { ...s, bars: doc.sequence.bars };
}

function req() {
  const { doc } = st();
  const seq = doc.sequence;
  return { slices: doc.slices, sources: doc.sources, bpm: seq.bpm, timeSig: seq.timeSig, existing: seq, bars: seq.bars, beat: doc.beat?.enabled ? doc.beat : undefined };
}

/**
 * Texture styles want long, held notes. If the project has none, the two best
 * vowels are loop-sustained into pads first (new derived sources; undoable).
 */
function preparePads(s: GeneratorSettings) {
  if (s.mode !== 'ghost' && s.direction !== 'ambient') return;
  const before = new Set(st().doc.slices.map((x) => x.id));
  const n = ensurePads(2, 4);
  if (!n) return;
  const made = st().doc.slices.filter((x) => !before.has(x.id)).map((x) => x.id);
  const cur = st().doc.sequence.settings;
  if (cur.sliceIds.length) actions.setSettings({ sliceIds: [...cur.sliceIds, ...made] });
  st().toast(`Made ${n} sustained pad${n > 1 ? 's' : ''} from your vowels for this texture`, 'info');
}

function guard(fn: () => void) {
  try {
    fn();
  } catch (e) {
    st().toast((e as Error).message, 'error');
  }
}

export function composeDirect() {
  guard(() => {
    preparePads(effectiveSettings());
    const out = generate({ ...req(), settings: effectiveSettings() });
    actions.applyArrangement(out, 'Compose', out.groove);
    st().setPrefs((d) => {
      d.sequence.settings.seed = effectiveSettings().seed;
    });
    lastDescription = out.description;
    st().toast('Composed a new arrangement (undo to go back)', 'success');
  });
}

export let lastDescription: string[] = [];

export function generateIdeas(count = 6) {
  guard(() => {
    preparePads(effectiveSettings());
    const cands = generateCandidates({ ...req(), settings: effectiveSettings(), count });
    actions.addCandidates(cands);
    st().setUI({ candidateA: cands[0]?.id ?? null, candidateB: cands[1]?.id ?? null });
    st().toast(`${cands.length} ideas generated – audition and compare them in the Idea Lab`, 'success');
    // next press explores new seeds
    actions.setSettings({ seed: (effectiveSettings().seed + 1009) >>> 0 });
  });
}

export function regenerateBars(startBar: number, endBar: number) {
  guard(() => {
    const s = { ...effectiveSettings(), seed: (Date.now() & 0xffffff) >>> 0 };
    const { ui } = st();
    const out = generate({ ...req(), settings: s, scope: { startBar, endBar, trackIds: ui.trackId ? [ui.trackId] : undefined } });
    actions.applyArrangement(out, `Regenerate bars ${startBar + 1}–${endBar}`);
    st().toast(`Regenerated bars ${startBar + 1}–${endBar}${ui.trackId ? ' on the selected layer' : ''}; everything else kept`, 'success');
  });
}

export function regenerateLayer(trackId: string) {
  guard(() => {
    const s = { ...effectiveSettings(), seed: (Date.now() & 0xffffff) >>> 0 };
    const out = generate({ ...req(), settings: s, scope: { trackIds: [trackId] } });
    actions.applyArrangement(out, 'Regenerate layer');
    st().toast('Layer regenerated; other layers kept', 'success');
  });
}

export function variationsOf(c: Candidate | 'current') {
  guard(() => {
    const seq = st().doc.sequence;
    const base = c === 'current' ? { tracks: seq.tracks, events: seq.events, motifs: seq.motifs, settings: effectiveSettings(), groove: seq.groove } : c;
    const vars = generateVariations({ ...req(), settings: base.settings }, base, 5, Date.now() % 100000);
    vars.forEach((v) => (v.parentId = c === 'current' ? undefined : c.id));
    actions.addCandidates(vars);
    st().setUI({ candidateA: vars[0]?.id ?? null, candidateB: vars[1]?.id ?? null });
    st().toast(`${vars.length} variations generated`, 'success');
  });
}

/** Apply a candidate: whole, only the selected bars, or only some of its layers. */
export function applyCandidate(c: Candidate, mode: 'all' | 'bars' | 'add-layers' = 'all') {
  const { doc, ui } = st();
  const seq = doc.sequence;
  const bar = ticksPerBar(seq.timeSig);
  if (mode === 'all') {
    actions.applyArrangement({ tracks: c.tracks, events: c.events, motifs: c.motifs }, `Apply “${c.label}”`, c.groove);
    st().setPrefs((d) => {
      d.sequence.settings = { ...c.settings };
    });
  } else if (mode === 'bars' && ui.bars) {
    const [a, b] = ui.bars;
    const inRange = (t: number) => t >= a * bar && t < b * bar;
    const keep = seq.events.filter((e) => !inRange(e.tick) || e.locked);
    const take = c.events.filter((e) => inRange(e.tick)).map((e) => ({ ...e, id: `${e.id}-${a}` }));
    const tracks = [...seq.tracks];
    for (const t of c.tracks) if (take.some((e) => e.trackId === t.id) && !tracks.some((x) => x.id === t.id)) tracks.push(t);
    actions.applyArrangement({ tracks, events: [...keep, ...take].sort((x, y) => x.tick - y.tick), motifs: seq.motifs }, `Take bars ${a + 1}–${b} from “${c.label}”`);
  } else if (mode === 'add-layers') {
    const suffix = `-${c.id.slice(-4)}`;
    const tracks = [...seq.tracks, ...c.tracks.map((t) => ({ ...t, id: t.id + suffix, name: `${t.name} (${c.label})` }))];
    const events = [...seq.events, ...c.events.map((e) => ({ ...e, id: e.id + suffix, trackId: e.trackId + suffix }))];
    actions.applyArrangement({ tracks, events, motifs: seq.motifs }, `Layer “${c.label}”`);
  }
  st().toast(mode === 'all' ? `Applied “${c.label}” – undo to go back` : mode === 'bars' ? 'Bars taken from candidate' : 'Candidate added as new layers', 'success');
}

export function resliceSelection() {
  const { doc, ui } = st();
  if (!ui.eventIds.length) return;
  const evs = reassignSlices({ slices: doc.slices, sources: doc.sources, settings: effectiveSettings() }, doc.sequence.events, ui.eventIds, Date.now() & 0xffff);
  actions.applyArrangement({ tracks: doc.sequence.tracks, events: evs, motifs: doc.sequence.motifs }, 'Re-slice selection');
}


/**
 * Instant ideas: one click from "I have a vocal (and maybe a beat)" to ranked
 * ideas. Runs the best-fitting approaches for the material and keeps the six
 * highest-scoring, mutually different results.
 */
export function instantIdeas(recipes: { label: string; settings: Partial<GeneratorSettings> }[]) {
  guard(() => {
    const { doc } = st();
    if (!doc.slices.length) throw new Error('Add a vocal first: import audio, record, or add a demo vocal.');
    if (recipes.some((r) => r.settings.mode === 'ghost' || r.settings.direction === 'ambient')) preparePads({ ...effectiveSettings(), mode: 'ghost' });
    const all: Candidate[] = [];
    recipes.forEach((r, i) => {
      const settings = { ...effectiveSettings(), ...r.settings, seed: ((Date.now() & 0xfffff) + i * 977) >>> 0 };
      const cands = generateCandidates({ ...req(), settings, count: 3, attempts: 3 });
      cands.forEach((c) => (c.label = `${r.label} · ${c.label.replace('Most ', '')}`));
      all.push(...cands);
    });
    all.sort((a, b) => (b.score?.total ?? 0) - (a.score?.total ?? 0));
    const picked: Candidate[] = [];
    for (const c of all) {
      if (picked.length >= 6) break;
      // spread across approaches: at most two per recipe
      const prefix = c.label.split(' · ')[0];
      if (picked.filter((p) => p.label.startsWith(prefix)).length >= 2) continue;
      picked.push(c);
    }
    actions.addCandidates(picked);
    st().setUI({ view: 'compose', candidateA: picked[0]?.id ?? null, candidateB: picked[1]?.id ?? null });
    st().toast(`${picked.length} ideas ready – best first. Press ▶ on a card, or drag it straight into your DAW.`, 'success');
  });
}

const INSTANT_STYLES: { label: string; mode: GeneratorSettings['mode']; direction: Direction }[] = [
  { label: 'Float', mode: 'melodic', direction: 'drain' },
  { label: 'Pop hook', mode: 'melodic', direction: 'playful' },
  { label: 'Glitch-pop', mode: 'melodic', direction: 'hyperpop' },
  { label: 'Garage', mode: 'rhythmic', direction: 'ukg' },
  { label: 'Lead', mode: 'melodic', direction: 'trance' },
  { label: 'Texture', mode: 'ghost', direction: 'ambient' },
];

/** One click: several styles (or, with a beat loaded, several ways of fitting it) → the best six ideas. */
export function runInstant() {
  const cur = effectiveSettings();
  const mine = { label: 'Your settings', settings: {} as Partial<GeneratorSettings> };
  const styles = INSTANT_STYLES.filter((x) => !(x.mode === cur.mode && x.direction === cur.direction)).map((x) => ({
    label: x.label,
    settings: { mode: x.mode, direction: x.direction, feel: DIRECTIONS[x.direction].defaultFeel, controls: { ...DIRECTIONS[x.direction].controls }, transpose: true, layers: [] } as Partial<GeneratorSettings>,
  }));
  instantIdeas(cur.mode === 'midi' || cur.mode === 'conversation' ? styles : [mine, ...styles]);
}
