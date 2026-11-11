import type { AudioData } from '../../core/types';
import { buildFx, makeImpulse } from './engine';

/**
 * Prints the audition effects (reverb / tempo delay) into rendered audio using
 * an OfflineAudioContext – the same graph the live engine monitors through.
 */
export async function printFx(audio: AudioData, fx: { reverb: number; delay: number }, bpm: number, tailSec = 3): Promise<AudioData> {
  if (!fx.reverb && !fx.delay) return audio;
  const n = audio.channels[0].length;
  const total = n + Math.round(tailSec * audio.sampleRate);
  const ctx = new OfflineAudioContext(2, total, audio.sampleRate);
  const buf = ctx.createBuffer(audio.channels.length, n, audio.sampleRate);
  audio.channels.forEach((ch, c) => buf.copyToChannel(ch as Float32Array<ArrayBuffer>, c));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = buildFx(ctx, ctx.destination, bpm, fx, makeImpulse(ctx));
  src.connect(g.input);
  src.start(0);
  const out = await ctx.startRendering();
  const channels = [out.getChannelData(0).slice(), out.getChannelData(1).slice()];
  // keep the printed result out of the red
  let pk = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) pk = Math.max(pk, Math.abs(ch[i]));
  if (pk > 0.989) for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] *= 0.989 / pk;
  return { sampleRate: audio.sampleRate, channels };
}
