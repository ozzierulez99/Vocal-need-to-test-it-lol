import { describe, it, expect } from 'vitest';
import { encodeWav, decodeWav, AudioFormatError, isWav } from '../src/core/audio/wav';

function sine(n: number, sr: number, ch = 1) {
  return { sampleRate: sr, channels: Array.from({ length: ch }, (_, c) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr + c))) };
}

describe('WAV codec', () => {
  for (const bits of [16, 24, 32] as const)
    for (const ch of [1, 2])
      for (const sr of [22050, 44100, 48000, 96000])
        it(`round-trips ${bits}-bit ${ch}ch ${sr}Hz`, () => {
          const a = sine(1000, sr, ch);
          const d = decodeWav(encodeWav(a, bits));
          expect(d.sampleRate).toBe(sr);
          expect(d.channels.length).toBe(ch);
          expect(d.channels[0].length).toBe(1000);
          const tol = bits === 16 ? 1 / 16000 : bits === 24 ? 1e-6 : 1e-7;
          for (let c = 0; c < ch; c++) for (let i = 0; i < 1000; i += 37) expect(Math.abs(d.channels[c][i] - a.channels[c][i])).toBeLessThan(tol);
        });

  it('clips out-of-range samples when encoding integer PCM', () => {
    const d = decodeWav(encodeWav({ sampleRate: 44100, channels: [Float32Array.from([2, -2, 0.5])] }, 16));
    expect(d.channels[0][0]).toBeCloseTo(32767 / 32768, 4);
    expect(d.channels[0][1]).toBe(-1);
  });

  it('rejects non-WAV data with an explanation', () => {
    expect(() => decodeWav(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]))).toThrow(AudioFormatError);
    expect(isWav(new TextEncoder().encode('ID3 not a wav file'))).toBe(false);
  });

  it('rejects unsupported encodings', () => {
    const b = encodeWav(sine(10, 44100), 16);
    new DataView(b.buffer).setUint16(20, 2, true); // ADPCM
    expect(() => decodeWav(b)).toThrow(/Unsupported WAV encoding/);
  });

  it('reports a missing data chunk', () => {
    const b = encodeWav(sine(10, 44100), 16).slice(0, 36);
    expect(() => decodeWav(b)).toThrow(/no audio data/);
  });

  it('tolerates a truncated data chunk', () => {
    const b = encodeWav(sine(100, 44100), 16).slice(0, 44 + 50 * 2);
    expect(decodeWav(b).channels[0].length).toBe(50);
  });
});
