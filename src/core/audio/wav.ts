import type { AudioData } from '../types';

export class AudioFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioFormatError';
  }
}

function readStr(v: DataView, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(v.getUint8(off + i));
  return s;
}

export function isWav(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riff = readStr(v, 0, 4);
  return (riff === 'RIFF' || riff === 'RF64') && readStr(v, 8, 4) === 'WAVE';
}

/**
 * Decode PCM / IEEE-float WAV files (8/16/24/32-bit int, 32/64-bit float,
 * including WAVE_FORMAT_EXTENSIBLE). Throws AudioFormatError with an
 * explanation for anything unsupported.
 */
export function decodeWav(bytes: Uint8Array): AudioData {
  if (!isWav(bytes)) throw new AudioFormatError('Not a WAV file (missing RIFF/WAVE header).');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number; blockAlign: number } | null = null;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= bytes.length) {
    const id = readStr(v, off, 4);
    let size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      let format = v.getUint16(body, true);
      const channels = v.getUint16(body + 2, true);
      const sampleRate = v.getUint32(body + 4, true);
      const blockAlign = v.getUint16(body + 12, true);
      const bits = v.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 40) format = v.getUint16(body + 24, true);
      fmt = { format, channels, sampleRate, bits, blockAlign };
    } else if (id === 'data') {
      dataOff = body;
      if (size === 0xffffffff || body + size > bytes.length) size = bytes.length - body;
      dataLen = size;
      break;
    }
    off = body + size + (size & 1);
  }
  if (!fmt) throw new AudioFormatError('WAV file has no format chunk.');
  if (dataOff < 0) throw new AudioFormatError('WAV file has no audio data chunk.');
  const { format, channels, sampleRate, bits } = fmt;
  if (channels < 1 || channels > 8) throw new AudioFormatError(`Unsupported channel count: ${channels}.`);
  if (sampleRate < 3000 || sampleRate > 384000) throw new AudioFormatError(`Unsupported sample rate: ${sampleRate}.`);
  const isFloat = format === 3;
  if (format !== 1 && format !== 3)
    throw new AudioFormatError(`Unsupported WAV encoding (format ${format}). Use PCM or float WAV.`);
  if (isFloat && bits !== 32 && bits !== 64) throw new AudioFormatError(`Unsupported float bit depth: ${bits}.`);
  if (!isFloat && ![8, 16, 24, 32].includes(bits)) throw new AudioFormatError(`Unsupported bit depth: ${bits}.`);
  const bps = bits / 8;
  const frameBytes = bps * channels;
  const frames = Math.floor(dataLen / frameBytes);
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c++) out.push(new Float32Array(frames));
  let p = dataOff;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      let s: number;
      if (isFloat) s = bits === 32 ? v.getFloat32(p, true) : v.getFloat64(p, true);
      else if (bits === 16) s = v.getInt16(p, true) / 32768;
      else if (bits === 24) {
        let x = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getUint8(p + 2) << 16);
        if (x & 0x800000) x |= ~0xffffff;
        s = x / 8388608;
      } else if (bits === 32) s = v.getInt32(p, true) / 2147483648;
      else s = (v.getUint8(p) - 128) / 128;
      out[c][i] = s;
      p += bps;
    }
  }
  return { sampleRate, channels: out };
}

/** Encode to WAV. 16/24-bit PCM with TPDF-free clipping, or 32-bit float. */
export function encodeWav(audio: AudioData, bitDepth: 16 | 24 | 32 = 24): Uint8Array {
  const channels = audio.channels.length;
  const frames = channels ? audio.channels[0].length : 0;
  const isFloat = bitDepth === 32;
  const bps = bitDepth / 8;
  const dataLen = frames * channels * bps;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, isFloat ? 3 : 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, audio.sampleRate, true);
  v.setUint32(28, audio.sampleRate * channels * bps, true);
  v.setUint16(32, channels * bps, true);
  v.setUint16(34, bitDepth, true);
  w(36, 'data');
  v.setUint32(40, dataLen, true);
  let p = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = audio.channels[c][i];
      if (isFloat) v.setFloat32(p, s, true);
      else {
        const x = Math.max(-1, Math.min(1, s));
        if (bitDepth === 16) v.setInt16(p, Math.round(x < 0 ? x * 32768 : x * 32767), true);
        else {
          const y = Math.round(x < 0 ? x * 8388608 : x * 8388607);
          v.setUint8(p, y & 0xff);
          v.setUint8(p + 1, (y >> 8) & 0xff);
          v.setUint8(p + 2, (y >> 16) & 0xff);
        }
      }
      p += bps;
    }
  }
  return new Uint8Array(buf);
}

export function audioDuration(a: AudioData): number {
  return a.channels.length ? a.channels[0].length / a.sampleRate : 0;
}

export function frameCount(a: AudioData): number {
  return a.channels.length ? a.channels[0].length : 0;
}

/** Extract frames [start, end) as a new AudioData (copy). */
export function sliceAudio(a: AudioData, start: number, end: number): AudioData {
  const s = Math.max(0, Math.floor(start));
  const e = Math.min(frameCount(a), Math.floor(end));
  return { sampleRate: a.sampleRate, channels: a.channels.map((ch) => ch.slice(s, Math.max(s, e))) };
}

/** Mono mixdown view (copy). */
export function toMono(a: AudioData): Float32Array {
  if (a.channels.length === 1) return a.channels[0];
  const n = frameCount(a);
  const out = new Float32Array(n);
  for (const ch of a.channels) for (let i = 0; i < n; i++) out[i] += ch[i] / a.channels.length;
  return out;
}
