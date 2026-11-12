import type { BeatContext, GeneratorSettings, HookScore, SeqEvent, Slice, SourceAudio, Track } from '../types';
import { PPQ } from '../types';
import { slicePitch } from '../slicing/slices';
import { ticksPerBar, semitonesToRate } from '../time';
import { SCALES } from './theory';
import { chordAt, effectiveKey } from '../beat/fit';
import { DIRECTIONS } from './directions';

/**
 * Hook critic: scores a generated idea on the things producers listen for –
 * a rhythm that is clear, syncopated and repeats; a melody that stays in key,
 * moves by small steps with the odd leap and resolves; clean, in-range sound;
 * and (with a beat) agreement with the chords and rhythm underneath.
 *
 * It is a set of explainable heuristics, used to pick the best of several
 * attempts and to tell the user why an idea was kept.
 */
export interface CriticInput {
  events: SeqEvent[];
  tracks: Track[];
  slices: Slice[];
  sources: SourceAudio[];
  bpm: number;
  timeSig: [number, number];
  bars: number;
  settings: GeneratorSettings;
  beat?: BeatContext;
}

const band = (x: number, lo: number, hi: number, soft: number) => (x < lo ? Math.max(0, 1 - (lo - x) / soft) : x > hi ? Math.max(0, 1 - (x - hi) / soft) : 1);
const pc = (m: number) => ((Math.round(m) % 12) + 12) % 12;

export function scoreHook(input: CriticInput): HookScore {
  const { events, tracks, settings: s } = input;
  const sliceMap = new Map(input.slices.map((x) => [x.id, x]));
  const srcMap = new Map(input.sources.map((x) => [x.id, x]));
  const bar = ticksPerBar(input.timeSig);
  const step = PPQ / 4;
  const beatT = (PPQ * 4) / input.timeSig[1];
  const leadIds = new Set(tracks.filter((t) => t.role === 'lead' || (s.mode === 'conversation' && t.role === 'response')).map((t) => t.id));
  const lead = events.filter((e) => leadIds.has(e.trackId)).sort((a, b) => a.tick - b.tick);
  const good: string[] = [];
  const watch: string[] = [];
  if (lead.length < 2) return { total: 20, parts: { rhythm: 20, melody: 20, sound: 50, fit: 50 }, good, watch: ['almost nothing plays'] };
  const beat = input.beat?.enabled ? input.beat : undefined;
  const key = beat ? effectiveKey(beat) : s.keyRoot !== null ? { root: s.keyRoot, scale: s.scale } : null;
  const scale = key ? new Set(SCALES[key.scale].map((i) => (key.root + i) % 12)) : null;
  const busyStyle = s.mode === 'microchop' || s.direction === 'glitch';
  const sparseStyle = s.mode === 'ghost' || s.direction === 'ambient' || s.direction === 'witch';

  // ── rhythm ────────────────────────────────────────────────────────────────
  const onsetsByBar: Set<number>[] = Array.from({ length: input.bars }, () => new Set<number>());
  for (const e of lead) {
    const b = Math.floor(e.tick / bar);
    if (b < input.bars) onsetsByBar[b].add(Math.round((e.tick - b * bar) / step));
  }
  const perBar = onsetsByBar.reduce((a, x) => a + x.size, 0) / input.bars;
  const densityScore = busyStyle ? band(perBar, 5, 16, 6) : sparseStyle ? band(perBar, 0.4, 4, 3) : band(perBar, 1.5, 8, 4);
  let sync = 0;
  let onsets = 0;
  for (const set of onsetsByBar)
    for (const st of set) {
      onsets++;
      if (st % 2 === 1 && !set.has(st - 1)) sync += 1;
      else if (st % 4 === 2 && !set.has(st - 2)) sync += 0.6;
    }
  const syncRatio = onsets ? sync / onsets : 0;
  const syncScore = sparseStyle ? band(syncRatio, 0, 0.5, 0.4) : band(syncRatio, 0.12, 0.6, 0.3);
  // repetition: each bar against the same bar one hook-length earlier
  let rep = 0;
  let repN = 0;
  for (const lag of [1, 2, 4]) {
    let r = 0;
    let n = 0;
    for (let b = lag; b < input.bars; b++) {
      const A = onsetsByBar[b];
      const B = onsetsByBar[b - lag];
      if (!A.size && !B.size) continue;
      let inter = 0;
      for (const x of A) if (B.has(x)) inter++;
      r += inter / (A.size + B.size - inter);
      n++;
    }
    if (n && r / n > rep) {
      rep = r / n;
      repN = n;
    }
  }
  const repScore = repN ? band(rep, 0.45, 0.95, 0.35) : 0.5;
  const downbeats = onsetsByBar.filter((x, b) => b % 2 === 0 && [...x].some((st) => st <= 2)).length / Math.max(1, Math.ceil(input.bars / 2));
  const anchorScore = sparseStyle || (s.purpose ?? 'hook') === 'verse' ? 1 : band(downbeats, 0.5, 1, 0.5);
  const sounding = new Uint8Array(Math.round((input.bars * bar) / step));
  for (const e of lead) {
    const sl = sliceMap.get(e.sliceId);
    const src = sl ? srcMap.get(sl.sourceId) : undefined;
    const nat = sl && src ? ((sl.end - sl.start - e.offset) / src.sampleRate / semitonesToRate(e.semitones)) * ((input.bpm * PPQ) / 60) : e.length;
    for (let x = Math.floor(e.tick / step); x < Math.min(sounding.length, Math.ceil((e.tick + Math.min(e.length, nat)) / step)); x++) sounding[x] = 1;
  }
  const air = 1 - sounding.reduce((a, b) => a + b, 0) / sounding.length;
  const airScore = busyStyle ? band(air, 0.1, 0.7, 0.3) : band(air, 0.2, 0.85, 0.25);
  const hygieneR = densityScore * 0.25 + syncScore * 0.2 + repScore * 0.25 + anchorScore * 0.15 + airScore * 0.15;

  // craft: the things that separate a usable pattern from a hook
  const traits = DIRECTIONS[s.direction].traits;
  const machineStyle = busyStyle || traits.gate >= 0.5 || traits.arp >= 0.5 || s.mode === 'midi';
  // 1. long and short notes contrast (a hook has a shape, not a row of equal hits)
  const onsetTicks = Array.from(new Set(lead.map((e) => e.tick))).sort((a, b) => a - b);
  const iois = onsetTicks.slice(1).map((t, i) => Math.round((t - onsetTicks[i]) / step)).filter((x) => x > 0).sort((a, b) => a - b);
  const contrast = iois.length >= 3 ? iois[Math.floor(iois.length * 0.9)] / Math.max(1, iois[Math.floor(iois.length / 2)]) : 1;
  const contrastScore = machineStyle || sparseStyle ? 1 : band(contrast, 2, 8, 1.2);
  // 2. repeats, but not as a copy: the best hooks restate and then change something
  const restate = !repN ? 0.6 : rep >= 0.97 ? (machineStyle ? 0.9 : 0.7) : band(rep, 0.55, 0.97, 0.3);
  // 3. breathes before each phrase comes back round
  const phraseT = Math.max(1, s.phraseBars) * bar;
  let breaths = 0;
  let phrases = 0;
  for (let t = phraseT; t <= input.bars * bar; t += phraseT) {
    phrases++;
    const from = Math.round((t - beatT) / step);
    let quiet = 0;
    for (let x = from; x < Math.min(sounding.length, Math.round(t / step)); x++) if (!sounding[x]) quiet++;
    if (quiet >= 2) breaths++;
  }
  const breathScore = sparseStyle || machineStyle ? 1 : phrases ? 0.45 + 0.55 * (breaths / phrases) : 0.8;
  // 4. hook-sized: enough notes to be a tune, few enough to remember
  const sizeScore = busyStyle || sparseStyle ? 1 : (s.purpose ?? 'hook') === 'verse' ? band(perBar, 1, 4, 2) : band(perBar, 2.5, 6.5, 2.5);
  const craftR = contrastScore * 0.3 + restate * 0.3 + breathScore * 0.2 + sizeScore * 0.2;
  const rhythm = 100 * (hygieneR * 0.55 + craftR * 0.45);
  if (restate > 0.95 && syncScore > 0.8) good.push('catchy rhythm: syncopated, repeats, then changes');
  else if (repScore > 0.9) good.push('rhythm repeats clearly');
  if (!machineStyle && !sparseStyle && contrastScore < 0.6) watch.push('every note is about the same length – no rhythmic shape');
  if (!machineStyle && rep >= 0.97 && repN) watch.push('identical every bar – no development');
  if (!machineStyle && !sparseStyle && phrases > 1 && breaths / phrases < 0.5) watch.push('no breath between phrases');
  else if (!machineStyle && !sparseStyle && phrases > 1 && breaths === phrases) good.push('breathes before each phrase returns');
  if (repScore < 0.5) watch.push('rhythm changes a lot from bar to bar');
  if (densityScore < 0.6) watch.push(perBar > 8 ? 'very busy' : 'very few notes');
  if (airScore < 0.6) watch.push(air < 0.2 ? 'little breathing space' : 'mostly silence');
  if (airScore === 1 && !sparseStyle) good.push('leaves room for the rest of the track');

  // ── melody ────────────────────────────────────────────────────────────────
  const pitchOf = (e: SeqEvent) => {
    const sl = sliceMap.get(e.sliceId);
    const p = sl ? slicePitch(sl, srcMap.get(sl.sourceId)) : null;
    return p === null ? null : p + e.semitones;
  };
  const pitched = lead.map((e) => ({ e, p: pitchOf(e) })).filter((x): x is { e: SeqEvent; p: number } => x.p !== null);
  let melody = 55;
  const melodicMode = s.mode === 'melodic' || s.mode === 'midi' || s.mode === 'ghost' || s.mode === 'conversation';
  if (pitched.length >= 2) {
    const ps = pitched.map((x) => x.p);
    const range = Math.max(...ps) - Math.min(...ps);
    const inKey = scale ? pitched.filter((x) => scale.has(pc(x.p)) && Math.abs(x.p - Math.round(x.p)) < 0.3).length / pitched.length : 1;
    let stepwise = 0;
    let leaps = 0;
    let moves = 0;
    for (let i = 1; i < pitched.length; i++) {
      if (pitched[i].e.tick === pitched[i - 1].e.tick) continue;
      const d = Math.abs(pitched[i].p - pitched[i - 1].p);
      moves++;
      if (d > 0.5 && d <= 4.5) stepwise++;
      if (d > 7.5) leaps++;
    }
    const distinct = new Set(ps.map((p) => Math.round(p))).size;
    const still = moves ? 1 - (stepwise + leaps) / moves - 0 : 1; // share of repeated notes
    const motion = moves ? stepwise / moves : 0;
    const rangeScore = band(range, melodicMode ? 3 : 0, 14, 7);
    const motionScore = melodicMode ? band(motion, 0.25, 0.9, 0.3) : 1;
    const leapScore = band(moves ? leaps / moves : 0, 0, 0.2, 0.25);
    const varietyScore = melodicMode ? band(distinct, 2, 7, 2) : 1;
    // resolution: the last note rests on the tonic triad (or on the chord underneath)
    const lastP = pitched[pitched.length - 1];
    let resolves = 0.6;
    if (key) {
      const triad = [key.root, (key.root + (SCALES[key.scale].includes(4) ? 4 : 3)) % 12, (key.root + 7) % 12];
      const chord = beat ? chordAt(beat, lastP.e.tick) : null;
      resolves = pc(lastP.p) === key.root ? 1 : triad.includes(pc(lastP.p)) || chord?.pcs.includes(pc(lastP.p)) ? 0.85 : 0.35;
    }
    const hygieneM = inKey * 0.3 + rangeScore * 0.15 + motionScore * 0.15 + leapScore * 0.1 + varietyScore * 0.1 + resolves * 0.2;
    // craft
    let craftM = 0.8;
    if (melodicMode && s.mode !== 'ghost') {
      // 1. one clear high point, not a line that sits on its top note
      const top = Math.round(Math.max(...ps));
      const topShare = ps.filter((p) => Math.round(p) === top).length / ps.length;
      const apexScore = range < 1.5 ? 0.4 : band(topShare, 0.02, 0.3, 0.3) * (Math.round(ps[0]) === top && topShare < 0.2 ? 0.8 : 1);
      // 2. long / on-beat notes rest on stable degrees (root, third, fifth), movement happens in between
      let stableT = 0;
      let totalT = 0;
      if (key) {
        const triad = new Set([key.root, (key.root + (SCALES[key.scale].includes(4) ? 4 : 3)) % 12, (key.root + 7) % 12]);
        for (const { e, p } of pitched) {
          const w = Math.min(e.length, beatT * 2) * (e.tick % beatT === 0 ? 1.5 : 1);
          totalT += w;
          const chord = beat ? chordAt(beat, e.tick) : null;
          if (chord && chord.quality !== 'note' ? chord.pcs.includes(pc(p)) : triad.has(pc(p))) stableT += w;
        }
      }
      const stableScore = totalT ? band(stableT / totalT, 0.45, 0.85, 0.3) : 0.7;
      // 3. the tune itself comes back (same pitches on the same steps one phrase later)
      const byPos = new Map<number, number>();
      for (const { e, p } of pitched) byPos.set(Math.round(e.tick / step), Math.round(p));
      let same = 0;
      let shared = 0;
      const lagSteps = Math.round((Math.max(1, s.phraseBars) * bar) / step);
      for (const [pos, p] of byPos) {
        const q = byPos.get(pos - lagSteps);
        if (q === undefined) continue;
        shared++;
        if (q === p) same++;
      }
      const recall = shared >= 2 ? band(same / shared, 0.45, 0.92, 0.35) : 0.55;
      // 4. more than one kind of movement
      const kinds = new Set<number>();
      for (let i = 1; i < pitched.length; i++) kinds.add(Math.round(pitched[i].p - pitched[i - 1].p));
      const kindScore = band(kinds.size, 3, 9, 2);
      craftM = apexScore * 0.3 + stableScore * 0.3 + recall * 0.25 + kindScore * 0.15;
      if (apexScore === 1 && range >= 3) good.push('has one clear high point');
      if (topShare > 0.5 && range >= 1.5) watch.push('sits on its top note');
      if (recall === 1 && shared >= 3) good.push('the tune comes back, then varies');
      else if (shared >= 3 && same / shared < 0.25) watch.push('the tune never returns the same way');
      if (totalT && stableT / totalT < 0.3) watch.push('long notes avoid the chord – may sound restless');
    }
    melody = 100 * (hygieneM * 0.55 + craftM * 0.45);
    if (inKey > 0.97 && scale) good.push('every note is in key');
    if (inKey < 0.85) watch.push('some notes are out of key');
    if (resolves >= 1) good.push('resolves to the tonic');
    else if (resolves < 0.5) watch.push('ends on an unresolved note');
    if (melodicMode && motionScore > 0.9 && leapScore === 1 && distinct >= 3) good.push('singable line: small steps, few leaps');
    if (melodicMode && distinct < 2) watch.push('the line never changes pitch');
    void still;
  } else if (melodicMode) {
    melody = 35;
    watch.push('no clearly pitched slices – melody cannot be tuned');
  }

  // ── sound ─────────────────────────────────────────────────────────────────
  const lifts = DIRECTIONS[s.direction].traits.lifts;
  const typicalLift = lifts.reduce((a, b) => a + b, 0) / lifts.length;
  const extreme = pitched.filter((x) => Math.abs(x.e.semitones - typicalLift) > 12).length / Math.max(1, pitched.length);
  const conf = lead.reduce((a, e) => a + (sliceMap.get(e.sliceId)?.analysis?.pitchConfidence ?? 0.5), 0) / lead.length;
  const tiny = lead.filter((e) => (e.length * 60) / (input.bpm * PPQ) < 0.04).length / lead.length;
  const sound = 100 * ((1 - Math.min(1, extreme * 2)) * 0.4 + (melodicMode ? conf : 0.8) * 0.35 + (busyStyle ? 1 : 1 - Math.min(1, tiny * 2)) * 0.25);
  if (extreme > 0.25) watch.push('some chops are pitched very far from the voice');
  if (melodicMode && conf > 0.85) good.push('clean, clearly pitched vowels');

  // ── fit with the beat ─────────────────────────────────────────────────────
  let fit = (rhythm + melody) / 2;
  if (beat) {
    let strong = 0;
    let onChord = 0;
    let clash = 0;
    for (const { e, p } of pitched) {
      const chord = chordAt(beat, e.tick);
      if (!chord || chord.quality === 'note') continue;
      const long = e.length >= beatT / 2;
      if (e.tick % beatT === 0 || long) {
        strong++;
        if (chord.pcs.includes(pc(p))) onChord++;
        // a semitone above a chord tone is the classic clash
        else if (chord.pcs.includes((pc(p) + 11) % 12) && long) clash++;
      }
    }
    const chordScore = strong ? onChord / strong : 0.7;
    const clashScore = strong ? 1 - Math.min(1, (clash / strong) * 3) : 1;
    const busy = (t: number) => (beat.rhythm.steps[Math.round(t / step) % beat.rhythm.steps.length] ?? 0) >= 0.5;
    const busyShare = lead.filter((e) => busy(e.tick)).length / lead.length;
    const full = beat.rhythm.steps.filter((v) => v >= 0.5).length / beat.rhythm.steps.length;
    // judged relative to how much room the beat leaves at all
    const rhythmFit = beat.fit.rhythm === 'follow' ? band(busyShare, Math.min(0.6, full + 0.2), 1, 0.4) : beat.fit.rhythm === 'complement' ? band(busyShare, 0, Math.max(0.35, full * 0.9), 0.4) : 0.8;
    fit = 100 * (chordScore * 0.45 + clashScore * 0.2 + rhythmFit * 0.35);
    if (chordScore > 0.9 && strong >= 3) good.push('strong notes sit on your chords');
    if (clash > 0) watch.push(`${clash} note${clash > 1 ? 's' : ''} rub against the chord`);
    if (beat.fit.rhythm === 'complement' && rhythmFit === 1 && full < 0.8) good.push('chops fall in the gaps of your beat');
    if (rhythmFit < 0.6) watch.push(beat.fit.rhythm === 'complement' ? 'lands on top of the beat’s notes' : 'drifts away from the beat’s rhythm');
  }

  const total = beat ? rhythm * 0.3 + melody * 0.3 + sound * 0.15 + fit * 0.25 : rhythm * 0.4 + melody * 0.4 + sound * 0.2;
  const r = (x: number) => Math.round(Math.max(0, Math.min(100, x)));
  return { total: r(total), parts: { rhythm: r(rhythm), melody: r(melody), sound: r(sound), fit: r(fit) }, good: good.slice(0, 4), watch: watch.slice(0, 3) };
}
