/**
 * Runs the showcase acapellas through the same core pipeline the app uses:
 *   import + auto-chop → load beat MIDI (Beat Fit analysis) → curated recipe →
 *   Generate 6 ideas → pick ideas → WAV export, and saves openable projects.
 *
 *   npx tsx scripts/showcase/run-showcase.ts <acapellaDir> <outDir>
 *
 * For listening convenience it also renders a "with beat" version: the vocal
 * export plus a simple synth playing the beat MIDI (like the app's preview).
 */
import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import type { AudioData, BeatContext, Candidate, GeneratorSettings, ProjectDoc, SourceAudio, Slice } from '../../src/core/types';
import { decodeWav, encodeWav } from '../../src/core/audio/wav';
import { autoChop } from '../../src/core/slicing/slices';
import { parseMidi } from '../../src/core/midi/midi';
import { analyseParts, keyName, barTicks } from '../../src/core/beat/analyze';
import { DIRECTIONS } from '../../src/core/compose/directions';
import type { Direction, ComposeMode } from '../../src/core/types';
import { beatRecipes, arrangementBarsFor, effectiveKey, vocalKeyFit, describeBeat } from '../../src/core/beat/fit';
import { demoBeatMidi, DEMO_BEATS } from '../../src/core/demo/beats';
import { defaultSettings } from '../../src/core/compose/engine';
import { generateCandidates } from '../../src/core/compose/candidates';
import { newProjectDoc, saveProject, type ProjectFS } from '../../src/core/project/project';
import { exportMixFile } from '../../src/core/project/exporters';
import { ticksToSeconds } from '../../src/core/time';

const acaDir = process.argv[2] ?? 'examples/showcase/acapellas';
const outDir = process.argv[3] ?? 'examples/showcase';
const audioOut = join(outDir, 'audio');
const projOut = join(outDir, 'projects');
mkdirSync(audioOut, { recursive: true });
mkdirSync(projOut, { recursive: true });

const nodeFS: ProjectFS = {
  readText: async (p) => readFileSync(p, 'utf8'),
  readBytes: async (p) => new Uint8Array(readFileSync(p)),
  writeText: async (p, t) => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, t)),
  writeBytes: async (p, b) => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, b)),
  exists: async (p) => existsSync(p),
  mkdir: async (p) => void mkdirSync(p, { recursive: true }),
};

/** what “Import audio” does: decode, register the source, auto-chop */
function importAcapella(doc: ProjectDoc, audio: Map<string, AudioData>, assets: Map<string, Uint8Array>, file: string, id: string, name: string) {
  const bytes = new Uint8Array(readFileSync(join(acaDir, file)));
  const a = decodeWav(bytes);
  const src: SourceAudio = { id, name, assetName: file, kind: 'import', sampleRate: a.sampleRate, channelCount: a.channels.length, frames: a.channels[0].length, createdAt: 0 };
  doc.sources.push(src);
  audio.set(id, a);
  assets.set(file, bytes);
  const { slices } = autoChop(src, a, { prefix: doc.sources.length > 1 ? String.fromCharCode(64 + doc.sources.length) : '' });
  doc.slices.push(...slices.map((s, i) => ({ ...s, id: `${id}-${i}`, parentId: s.parentId ? `${id}-${slices.findIndex((x) => x.id === s.parentId)}` : undefined })));
  return src;
}

/** what dropping a beat MIDI does (beatService.loadBeatBytes) */
function loadBeat(doc: ProjectDoc, key: string): BeatContext {
  const parsed = parseMidi(demoBeatMidi(key), DEMO_BEATS[key].title);
  const beat = analyseParts(parsed.tracks.map((t, i) => ({ id: `part${i + 1}`, name: parsed.tracks.length > 1 ? t.name : DEMO_BEATS[key].title, notes: t.notes, percussion: t.percussion })), { name: DEMO_BEATS[key].title, bpm: parsed.bpm, timeSig: parsed.timeSig });
  doc.beat = beat;
  doc.sequence.bpm = Math.round(beat.bpm! * 100) / 100;
  doc.sequence.timeSig = beat.timeSig;
  doc.sequence.bars = arrangementBarsFor(beat);
  doc.sequence.loop = { enabled: true, startTick: 0, endTick: doc.sequence.bars * barTicks(beat.timeSig) };
  return beat;
}

/** simple preview synth (same voice design as the app's live preview) */
function renderBeat(beat: BeatContext, bpm: number, totalTicks: number, sr: number, frames: number, gainDb = -12): Float32Array {
  const y = new Float32Array(frames);
  const g0 = Math.pow(10, gainDb / 20) * 0.35;
  for (let base = 0; base < totalTicks; base += beat.lengthTicks)
    for (const n of beat.notes) {
      const tick = base + n.tick;
      if (tick >= totalTicks) continue;
      const start = Math.round(ticksToSeconds(tick, bpm) * sr);
      const dur = ticksToSeconds(Math.min(n.length, totalTicks - tick), bpm);
      const len = Math.round(dur * sr);
      const f = 440 * Math.pow(2, (n.pitch - 69) / 12);
      const peak = g0 * (0.25 + 0.5 * n.velocity);
      const rel = Math.min(0.12, dur * 0.4);
      let lp = 0;
      for (let i = 0; i < len && start + i < frames; i++) {
        const t = i / sr;
        let env = t < 0.012 ? t / 0.012 : t < 0.25 ? 1 - 0.4 * ((t - 0.012) / 0.238) : 0.6;
        if (t > dur - rel) env *= Math.max(0, (dur - t) / rel);
        let v = 0;
        for (const det of [-4, 4]) {
          const ph = (t * f * Math.pow(2, det / 1200)) % 1;
          v += 4 * Math.abs(ph - 0.5) - 1; // triangle
        }
        lp += 0.3 * (v * 0.5 - lp); // gentle low-pass
        y[start + i] += lp * peak * env;
      }
    }
  return y;
}

function mp3(wav: string, mp3Path: string) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-codec:a', 'libmp3lame', '-b:a', '192k', mp3Path]);
}

interface Scenario {
  id: string;
  title: string;
  sources: { file: string; name: string }[];
  beat: string;
  recipe: string;
  pick: string[];
  seed: number;
  tweak?: (s: GeneratorSettings, beat: BeatContext) => void;
  note?: string;
}

/** switch a recipe to one of the style packs (what choosing a Musical direction in the app does) */
const style = (direction: Direction, mode: ComposeMode = 'melodic', extra: Partial<GeneratorSettings> = {}) => (s: GeneratorSettings) =>
  void Object.assign(s, { mode, direction, feel: DIRECTIONS[direction].defaultFeel, controls: { ...DIRECTIONS[direction].controls }, transpose: true, layers: [], ...extra });

const SCENARIOS: Scenario[] = [
  {
    id: '01-tonight-hook-am-f-c-g',
    title: '“Tonight” → hook in key over Am–F–C–G pads',
    sources: [{ file: 'acapella-tonight-sung.wav', name: 'Tonight (sung)' }],
    beat: 'am-f-c-g-pads',
    recipe: 'hook',
    pick: ['Most melodic', 'Most hypnotic'],
    seed: 101,
  },
  {
    id: '02-tonight-chops-cm-arp',
    title: '“Tonight” → chops in the gaps of a Cm–Ab–Eb–Bb arp',
    sources: [{ file: 'acapella-tonight-sung.wav', name: 'Tonight (sung)' }],
    beat: 'cm-arp',
    recipe: 'gaps',
    pick: ['Most rhythmic'],
    seed: 202,
  },
  {
    id: '03-tonight-ride-the-arp',
    title: '“Tonight” → ride the arp (the arp MIDI triggers the vocal)',
    sources: [{ file: 'acapella-tonight-sung.wav', name: 'Tonight (sung)' }],
    beat: 'cm-arp',
    recipe: 'follow',
    pick: ['Most hypnotic'],
    seed: 303,
  },
  {
    id: '04-never-meant-phrase',
    title: 'Spoken phrase → phrase reconstruction over Am–F–C–G',
    sources: [{ file: 'acapella-never-meant-spoken.wav', name: 'Never meant (spoken)' }],
    beat: 'am-f-c-g-pads',
    recipe: 'hook',
    pick: ['Most hypnotic'],
    seed: 404,
    tweak: (s) => Object.assign(s, { mode: 'phrase', direction: 'emotional', feel: 'bouncy', phraseBars: 2 }),
    note: 'Harmonise off – the spoken words keep their natural speech pitch; only timing/order is recomposed.',
  },
  {
    id: '05-whisper-hum-ghost',
    title: 'Whispers & hums → ghost layer under Am–F–C–G',
    sources: [{ file: 'acapella-whisper-hum.wav', name: 'Whisper & hum' }],
    beat: 'am-f-c-g-pads',
    recipe: 'ghost',
    pick: ['Most spacious'],
    seed: 505,
  },
  {
    id: '06-conversation-dorian',
    title: 'Two voices (sung + ad-libs) → call & response over Dm7–G7 stabs',
    sources: [
      { file: 'acapella-tonight-sung.wav', name: 'Tonight (sung)' },
      { file: 'acapella-adlibs.wav', name: 'Ad-libs' },
    ],
    beat: 'dorian-stabs',
    recipe: 'conversation',
    pick: ['Most rhythmic'],
    seed: 606,
  },
  {
    id: '07-adlibs-glitch-cm-arp',
    title: 'Ad-libs → glitch fills between the notes of the Cm arp',
    sources: [{ file: 'acapella-adlibs.wav', name: 'Ad-libs' }],
    beat: 'cm-arp',
    recipe: 'micro',
    pick: ['Most fragmented'],
    seed: 707,
  },
  {
    id: '08-drain-float-full-beat',
    title: 'Style: Drain / cloud → floating pitched mantra over a half-time beat (pads + bass + lead + drums)',
    sources: [{ file: 'acapella-tonight-sung.wav', name: 'Tonight (sung)' }],
    beat: 'full-beat',
    recipe: 'hook',
    pick: ['best'],
    seed: 808,
    tweak: style('drain'),
    note: 'The beat MIDI has four parts; the drums set the half-time feel and the chops stay out of the lead synth’s register.',
  },
  {
    id: '09-hyperpop-hook',
    title: 'Style: Hyperpop / glitch-pop → pitched-up hook with stutters, octave jumps and tape-stops',
    sources: [{ file: 'acapella-tonight-sung.wav', name: 'Tonight (sung)' }],
    beat: 'am-f-c-g-pads',
    recipe: 'hook',
    pick: ['best'],
    seed: 909,
    tweak: style('hyperpop'),
  },
  {
    id: '10-trance-lead',
    title: 'Style: Trance / euphoric → one vowel played like a synth lead',
    sources: [{ file: 'acapella-tonight-sung.wav', name: 'Tonight (sung)' }],
    beat: 'am-f-c-g-pads',
    recipe: 'hook',
    pick: ['best'],
    seed: 1010,
    tweak: style('trance', 'melodic', { purpose: 'drop' }),
  },
  {
    id: '11-garage-shuffle',
    title: 'Style: UK garage / 2-step → swung pitched chops over Dm7–G7 stabs',
    sources: [{ file: 'acapella-tonight-sung.wav', name: 'Tonight (sung)' }],
    beat: 'dorian-stabs',
    recipe: 'gaps',
    pick: ['best'],
    seed: 1111,
    tweak: style('ukg', 'rhythmic'),
  },
  {
    id: '12-ambient-wash',
    title: 'Style: Ambient texture → slow vowels for your own reverb (export is dry)',
    sources: [{ file: 'acapella-tonight-sung.wav', name: 'Tonight (sung)' }],
    beat: 'am-f-c-g-pads',
    recipe: 'ghost',
    pick: ['best'],
    seed: 1212,
    tweak: style('ambient', 'ghost'),
    note: 'Meant as raw material: put a long reverb on it in your DAW.',
  },
];

const report: string[] = [];

for (const sc of SCENARIOS) {
  const doc = newProjectDoc(sc.title.replace(/[“”→&–]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60));
  const audio = new Map<string, AudioData>();
  const assets = new Map<string, Uint8Array>();
  const srcs = sc.sources.map((s, i) => importAcapella(doc, audio, assets, s.file, `src${i + 1}`, s.name));
  const beat = loadBeat(doc, sc.beat);
  if (sc.id.startsWith('04')) beat.fit.harmonize = false;
  const recipe = beatRecipes(beat, { sources: srcs.length }).find((r) => r.id === sc.recipe)!;
  Object.assign(beat.fit, recipe.fit);
  if (sc.id.startsWith('04')) beat.fit.harmonize = false;
  const k = effectiveKey(beat);
  const material = (sid: string) => doc.slices.filter((s) => s.sourceId === sid && s.level !== 'phrase').map((s) => s.id);
  const settings = defaultSettings({ ...recipe.settings, seed: sc.seed, bars: doc.sequence.bars, keyRoot: k.root, scale: k.scale, sliceIds: srcs.length === 1 ? material(srcs[0].id) : [] });
  if (recipe.settings.mode === 'midi') {
    const pitches = beat.notes.map((n) => n.pitch).sort((a, b) => a - b);
    settings.midi = { name: `${beat.name} (beat)`, notes: beat.notes, bpm: beat.bpm, mapping: 'rhythm-cycle', pitchMap: {}, usePitch: true, rootPitch: pitches[Math.floor(pitches.length / 2)], useVelocity: true, useDuration: true, loopTicks: beat.lengthTicks };
  }
  if (recipe.settings.mode === 'conversation') {
    settings.voiceA = material(srcs[0].id);
    settings.voiceB = material(srcs[1].id);
  }
  sc.tweak?.(settings, beat);
  const t0 = Date.now();
  const cands: Candidate[] = generateCandidates({ settings, slices: doc.slices, sources: doc.sources, bpm: doc.sequence.bpm, timeSig: doc.sequence.timeSig, bars: doc.sequence.bars, beat, count: 6 });
  const ms = Date.now() - t0;
  doc.candidates = cands;
  const fit = vocalKeyFit(doc.slices.filter((s) => s.sourceId === srcs[0].id), doc.sources, beat);
  report.push(`## ${sc.title}`, '');
  report.push(`- **Vocal:** ${sc.sources.map((s) => `\`acapellas/${s.file}\``).join(' + ')} → auto-chopped into ${doc.slices.length} slices`);
  report.push(`- **Beat MIDI:** ${beat.name} → read as **${keyName(k.root, k.scale)}**, chords ${beat.chords.map((c) => c.symbol).join(' – ')}, ${beat.rhythm.kind}, ${beat.rhythm.onsetsPerBeat.toFixed(1)} onsets/beat`);
  report.push(`- **Vocal vs beat:** ${fit.inKey.length}/${fit.pitched} pitched slices in key${fit.suggestedShift ? ` (vocal sits ~${Math.abs(fit.suggestedShift)} st ${fit.suggestedShift > 0 ? 'below' : 'above'} – fixed per note by playback-rate transposition)` : ''}`);
  report.push(`- **Recipe:** “${recipe.title}” – ${recipe.why}${sc.note ? ` _${sc.note}_` : ''}`);
  report.push(`- **Generated:** 6 ideas in ${ms} ms (${cands.map((c) => c.label).join(', ')}) · ${doc.sequence.bars} bars at ${doc.sequence.bpm} BPM`, '');
  for (const label of sc.pick) {
    const c = label === 'best' ? cands.slice().sort((a, b) => (b.score?.total ?? 0) - (a.score?.total ?? 0))[0] : cands.find((x) => x.label === label) ?? cands[0];
    doc.sequence.groove = c.groove;
    doc.sequence.tracks = c.tracks;
    doc.sequence.events = c.events;
    doc.sequence.motifs = c.motifs;
    doc.sequence.settings = c.settings;
    c.favourite = true;
    const res = exportMixFile(doc, audio, { sampleRate: 44100, bitDepth: 24, level: 'normalize', clickFadeMs: 3, tail: 'keep' });
    const slug = `${sc.id}_${c.label.toLowerCase().replace(/\s+/g, '-')}`;
    const vocalWav = join(audioOut, `${slug}_vocals.wav`);
    writeFileSync(vocalWav, res.bytes);
    // with-beat listening version
    const v = decodeWav(res.bytes);
    const frames = v.channels[0].length;
    const total = doc.sequence.bars * barTicks(doc.sequence.timeSig);
    const synth = renderBeat(beat, doc.sequence.bpm, total, 44100, frames);
    const mix = v.channels.map((ch) => {
      const o = new Float32Array(frames);
      for (let i = 0; i < frames; i++) o[i] = ch[i] * 0.8 + synth[i];
      return o;
    });
    let pk = 0;
    for (const ch of mix) for (const x of ch) pk = Math.max(pk, Math.abs(x));
    if (pk > 0.98) for (const ch of mix) for (let i = 0; i < frames; i++) ch[i] *= 0.98 / pk;
    const beatWav = join(audioOut, `${slug}_with-beat.wav`);
    writeFileSync(beatWav, encodeWav({ sampleRate: 44100, channels: mix }, 16));
    mp3(vocalWav, vocalWav.replace(/\.wav$/, '.mp3'));
    mp3(beatWav, beatWav.replace(/\.wav$/, '.mp3'));
    rmSync(vocalWav);
    rmSync(beatWav);
    report.push(`### Idea: ${c.label}`, '');
    report.push(`- \`audio/${slug}_vocals.mp3\` – the app's WAV export (vocals only, normalised to −1 dBFS)`);
    report.push(`- \`audio/${slug}_with-beat.mp3\` – same, with the beat MIDI on a simple preview synth (listening reference only)`);
    if (c.score) report.push(`- Hook check **${c.score.total}/100**${c.score.good.length ? ` – ${c.score.good.join('; ')}` : ''}${c.score.watch.length ? ` · watch: ${c.score.watch.join('; ')}` : ''}`);
    report.push(`- ${c.events.length} events on ${c.tracks.filter((t) => c.events.some((e) => e.trackId === t.id)).map((t) => t.name).join(', ')}`);
    report.push('', '<details><summary>Why the app made these decisions</summary>', '', ...c.description.map((d) => `- ${d}`), '', '</details>', '');
    console.log(`✓ ${slug}  (${c.events.length} events)`);
  }
  // keep the first picked idea in the arrangement; all six ideas are in the Idea Lab
  const first = sc.pick[0] === 'best' ? cands.slice().sort((a, b) => (b.score?.total ?? 0) - (a.score?.total ?? 0))[0] : cands.find((x) => x.label === sc.pick[0]) ?? cands[0];
  Object.assign(doc.sequence, { tracks: first.tracks, events: first.events, motifs: first.motifs, settings: first.settings, groove: first.groove });
  const projDir = join(projOut, `${sc.id}.vcs`);
  if (existsSync(projDir)) rmSync(projDir, { recursive: true });
  await saveProject(nodeFS, projDir, doc, assets);
  report.push(`Project: \`projects/${sc.id}.vcs\` (open it in the app – all six ideas are in the Idea Lab).`, '');
}

const beatsUsed = Array.from(new Set(SCENARIOS.map((s) => s.beat)));
writeFileSync(
  join(outDir, 'README.md'),
  [
    '# Showcase: acapellas through Vocal Chop Studio',
    '',
    'Generated by `scripts/showcase/make-acapellas.ts` and `scripts/showcase/run-showcase.ts` (needs `espeak-ng` and `ffmpeg` with rubberband).',
    '',
    '**About the acapellas.** No external recordings were used. The four acapellas in `acapellas/` were made here with **espeak-ng**, a rule-based text-to-speech engine, so the words are real phonemes but the voices are robotic. The sung one (“Tonight”, E minor) was tuned syllable by syllable to a melody with ffmpeg’s rubberband filter. Expect results that sound like a vocoder or robot voice. Real human acapellas will chop and sound far better, but the structure the app creates is the same.',
    '',
    '**What each run does.** These are the same steps the desktop app performs: import (auto-chop into phrase/word/syllable slices with pitch analysis), drop the beat MIDI (Beat Fit analysis), apply a curated recipe, generate 6 ideas and export a WAV. The `_vocals` files are exactly what the app exports. The `_with-beat` files add a basic synth of the beat MIDI so the fit can be heard; your DAW has the real beat.',
    '',
    `Beat MIDIs used: ${beatsUsed.map((b) => `\`${b}\` (${DEMO_BEATS[b].title})`).join(', ')}. They are also in \`examples/media/beat-*.mid\`.`,
    '',
    ...report,
  ].join('\n'),
);
console.log(`\nREADME → ${join(outDir, 'README.md')}`);
void describeBeat;
