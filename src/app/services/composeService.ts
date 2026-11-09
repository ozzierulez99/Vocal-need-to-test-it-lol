import type { Candidate, GeneratorSettings } from '../../core/types';
import { generate } from '../../core/compose/engine';
import { generateCandidates, generateVariations, reassignSlices } from '../../core/compose/candidates';
import { ticksPerBar } from '../../core/time';
import { useStore, actions } from '../store/store';

const st = () => useStore.getState();

export function effectiveSettings(): GeneratorSettings {
  const { doc } = st();
  const s = doc.sequence.settings;
  return { ...s, bars: doc.sequence.bars };
}

function req() {
  const { doc } = st();
  const seq = doc.sequence;
  return { slices: doc.slices, sources: doc.sources, bpm: seq.bpm, timeSig: seq.timeSig, existing: seq, bars: seq.bars };
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
    const out = generate({ ...req(), settings: effectiveSettings() });
    actions.applyArrangement(out, 'Compose');
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
    const base = c === 'current' ? { tracks: seq.tracks, events: seq.events, motifs: seq.motifs, settings: effectiveSettings() } : c;
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
    actions.applyArrangement({ tracks: c.tracks, events: c.events, motifs: c.motifs }, `Apply “${c.label}”`);
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
