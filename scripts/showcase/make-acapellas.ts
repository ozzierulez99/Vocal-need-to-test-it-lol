/**
 * Builds four synthetic acapellas for the showcase with espeak-ng (rule-based
 * speech synthesis, real phonemes) and ffmpeg's rubberband filter.
 * Sung syllables use flat-intonation voice variants pitched at the melody note,
 * then rubberband fine-tunes pitch and length.
 *
 * Requirements: espeak-ng and ffmpeg (with rubberband) on PATH.
 *   npx tsx scripts/showcase/make-acapellas.ts <outDir>
 *
 * These are not human recordings – they are robotic TTS voices used to show
 * what the program does with word-like vocal material.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, existsSync } from 'fs';
import { join } from 'path';
import { decodeWav, encodeWav } from '../../src/core/audio/wav';
import { estimatePitch } from '../../src/core/audio/analysis';
import type { AudioData } from '../../src/core/types';

const out = process.argv[2] ?? 'examples/showcase/acapellas';
const tmp = join(out, '.tmp');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
const SR = 44100;
let n = 0;

// Private copy of the espeak-ng data so flat-intonation "singing" variants can be added.
const systemData = ['/usr/lib/x86_64-linux-gnu/espeak-ng-data', '/usr/share/espeak-ng-data', '/usr/lib/espeak-ng-data'].find((d) => existsSync(d));
if (!systemData) throw new Error('espeak-ng data directory not found – install espeak-ng');
const dataDir = join(tmp, 'espeak-ng-data');
cpSync(systemData, dataDir, { recursive: true });
const env = { ...process.env, ESPEAK_DATA_PATH: dataDir };

function run(cmd: string, args: string[]) {
  execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], env });
}

function load(path: string): Float32Array {
  return decodeWav(readFileSync(path)).channels[0];
}

/** espeak-ng → trimmed 44.1 kHz mono */
function speak(text: string, voice: string, opts: { speed?: number; pitch?: number } = {}): Float32Array {
  const raw = join(tmp, `s${n++}.wav`);
  const res = join(tmp, `s${n++}.wav`);
  run('espeak-ng', ['-v', voice, '-s', String(opts.speed ?? 140), '-p', String(opts.pitch ?? 50), '-w', raw, text]);
  run('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-af', 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,aresample=44100', '-ac', '1', '-c:a', 'pcm_s16le', res]);
  return load(res);
}

function medianPitch(x: Float32Array): number | null {
  const ps: number[] = [];
  const w = Math.round(SR * 0.06);
  for (let s = Math.floor(x.length * 0.15); s + w < x.length * 0.9; s += w) {
    const p = estimatePitch(x.subarray(s, s + w), SR);
    if (p.midi !== null && p.confidence > 0.7) ps.push(p.midi);
  }
  ps.sort((a, b) => a - b);
  return ps.length ? ps[Math.floor(ps.length / 2)] : null;
}

/** A voice variant whose pitch is (almost) flat at `midi` – espeak's speech intonation would glide. */
function singingVariant(base: string, midi: number): string {
  const name = `vcs_${base}_${midi}`;
  const hz = Math.round(440 * Math.pow(2, (midi - 69) / 12));
  const lines = readFileSync(join(dataDir, 'voices', '!v', base), 'utf8')
    .split('\n')
    .filter((l) => !/^(name|pitch|intonation|flutter)\b/.test(l.trim()));
  writeFileSync(join(dataDir, 'voices', '!v', name), [`name ${name}`, `pitch ${hz} ${hz + 2}`, 'intonation 1', 'flutter 0', ...lines].join('\n'));
  return `en-us+${name}`;
}

/** pitch-correct and stretch with rubberband (formants preserved) */
function tune(x: Float32Array, semis: number, targetSec: number): Float32Array {
  const a = join(tmp, `t${n++}.wav`);
  const b = join(tmp, `t${n++}.wav`);
  writeFileSync(a, encodeWav({ sampleRate: SR, channels: [x] }, 32));
  const tempo = Math.max(0.2, Math.min(5, x.length / SR / targetSec));
  run('ffmpeg', ['-y', '-loglevel', 'error', '-i', a, '-af', `rubberband=pitch=${Math.pow(2, semis / 12).toFixed(5)}:tempo=${tempo.toFixed(5)}:formant=preserved:pitchq=quality:transients=smooth`, '-c:a', 'pcm_f32le', b]);
  return load(b);
}

/** one sung syllable at an exact MIDI note and length */
function sing(text: string, base: string, midi: number, sec: number): Float32Array {
  const x = speak(text, singingVariant(base, midi), { speed: 75, pitch: 50 });
  const got = medianPitch(x) ?? midi;
  let d = midi - got;
  while (d > 6) d -= 12; // guard against octave errors in the estimate
  while (d < -6) d += 12;
  const y = tune(x, d, sec);
  if (process.env.DEBUG) console.log(`  ${text.padEnd(6)} target ${midi} raw ${got.toFixed(1)} shift ${d.toFixed(1)} → ${(medianPitch(y) ?? NaN).toFixed(1)}`);
  return y;
}

function fade(x: Float32Array, inMs = 8, outMs = 40) {
  const fi = Math.min(x.length / 2, (inMs / 1000) * SR);
  const fo = Math.min(x.length / 2, (outMs / 1000) * SR);
  for (let i = 0; i < fi; i++) x[i] *= i / fi;
  for (let i = 0; i < fo; i++) x[x.length - 1 - i] *= i / fo;
  return x;
}

function concat(parts: (Float32Array | number)[], lead = 0.2, tail = 0.4): AudioData {
  const segs = parts.map((p) => (typeof p === 'number' ? new Float32Array(Math.round(p * SR)) : fade(p)));
  const total = segs.reduce((a, s) => a + s.length, 0) + Math.round((lead + tail) * SR);
  const y = new Float32Array(total);
  let o = Math.round(lead * SR);
  for (const s of segs) {
    y.set(s, o);
    o += s.length;
  }
  let pk = 0;
  for (const v of y) pk = Math.max(pk, Math.abs(v));
  for (let i = 0; i < y.length; i++) y[i] *= 0.8 / (pk || 1);
  return { sampleRate: SR, channels: [y] };
}

const save = (name: string, a: AudioData) => {
  writeFileSync(join(out, `${name}.wav`), encodeWav(a, 16));
  console.log(`✓ ${name}.wav  ${(a.channels[0].length / SR).toFixed(1)} s`);
};

// 1 · “Tonight” – sung, female, E minor
{
  const S = (t: string, m: number, s: number) => sing(t, 'f2', m, s);
  save('acapella-tonight-sung', concat([
    S('take', 64, 0.42), S('me', 62, 0.34), S('high', 67, 0.5), S('er', 66, 0.32), 0.18,
    S('to', 64, 0.3), S('night', 71, 1.0), 0.45,
    speak('hhhh', 'en-us+whisperf', { speed: 80 }), 0.15,
    S("don't", 69, 0.38), S('let', 67, 0.32), S('go', 64, 1.1), 0.4,
    S('oh', 71, 0.5), S('oh', 69, 0.5), S('ooh', 67, 1.4),
  ]));
}

// 2 · spoken phrase – male voice with natural pauses
save('acapella-never-meant-spoken', concat([
  speak('We were never meant to stay.', 'en-us+m3', { speed: 135 }), 0.55,
  speak('Fade away.', 'en-us+m3', { speed: 120 }), 0.6,
  speak("Call me when it's over.", 'en-us+m3', { speed: 135 }),
]));

// 3 · whispers, hums and breaths
save('acapella-whisper-hum', concat([
  sing('hmm', 'f5', 62, 1.6), 0.4,
  speak('hold on', 'en-us+whisperf', { speed: 100 }), 0.5,
  sing('ooh', 'f5', 65, 1.4), 0.35,
  speak('hhhhh', 'en-us+whisperf', { speed: 70 }), 0.4,
  speak('let it go', 'en-us+whisperf', { speed: 100 }), 0.5,
  sing('hmm', 'f5', 60, 1.8),
]));

// 4 · hype ad-libs – bright second voice
save('acapella-adlibs', concat(
  ['hey!', 'yeah!', 'go!', 'uh!', "let's go!", 'woo!', 'come on!', 'oh!'].flatMap((w) => [speak(w, 'en-us+f4', { speed: 170, pitch: 80 }), 0.28]),
));

rmSync(tmp, { recursive: true, force: true });
