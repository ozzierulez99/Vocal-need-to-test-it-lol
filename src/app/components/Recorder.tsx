import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/store';
import { Btn, TextField } from './ui';
import { keepRecording } from '../services/projectService';
import { engine } from '../audio/engine';
import type { AudioData } from '../../core/types';
import { WaveThumb } from './WaveThumb';

/**
 * Simple microphone recorder: record → stop → replay → keep or discard.
 * Captures raw PCM (no lossy codec) at the device sample rate.
 */
export function Recorder() {
  const setUI = useStore((s) => s.setUI);
  const count = useStore((s) => s.doc.sources.filter((x) => x.kind === 'recording').length);
  const [state, setState] = useState<'idle' | 'recording' | 'done' | 'error'>('idle');
  const [err, setErr] = useState('');
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [take, setTake] = useState<AudioData | null>(null);
  const [name, setName] = useState(`Recording ${count + 1}`);
  const rec = useRef<{ ctx: AudioContext; stream: MediaStream; node: ScriptProcessorNode; chunks: Float32Array[]; t0: number } | null>(null);

  const cleanup = () => {
    const r = rec.current;
    if (!r) return;
    r.node.disconnect();
    r.stream.getTracks().forEach((t) => t.stop());
    void r.ctx.close();
    rec.current = null;
  };
  useEffect(() => () => cleanup(), []);

  const start = async () => {
    setErr('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const ctx = new AudioContext();
      const srcNode = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      node.onaudioprocess = (e) => {
        const x = e.inputBuffer.getChannelData(0);
        chunks.push(x.slice());
        let pk = 0;
        for (let i = 0; i < x.length; i++) pk = Math.max(pk, Math.abs(x[i]));
        setLevel(pk);
        setElapsed((Date.now() - (rec.current?.t0 ?? Date.now())) / 1000);
        if (chunks.length * 4096 > ctx.sampleRate * 180) void stopRec();
      };
      srcNode.connect(node);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(ctx.destination); // keep the processor running without monitoring
      rec.current = { ctx, stream, node, chunks, t0: Date.now() };
      setState('recording');
    } catch (e) {
      setErr(`Microphone unavailable: ${(e as Error).message}`);
      setState('error');
    }
  };

  const stopRec = async () => {
    const r = rec.current;
    if (!r) return;
    const sr = r.ctx.sampleRate;
    const total = r.chunks.reduce((a, c) => a + c.length, 0);
    const out = new Float32Array(total);
    let o = 0;
    for (const c of r.chunks) {
      out.set(c, o);
      o += c.length;
    }
    cleanup();
    setTake({ sampleRate: sr, channels: [out] });
    setState('done');
    setLevel(0);
  };

  const replay = () => {
    if (!take) return;
    engine.setAudio('__take', take);
    engine.audition('__take', 0, take.channels[0].length);
  };

  return (
    <div className="modal-back">
      <div className="modal" data-testid="recorder">
        <h2>Record a vocal idea</h2>
        <p className="muted" style={{ margin: 0 }}>Spoken phrases, sung notes, humming, ad-libs, breaths… Recordings are saved inside the project as WAV and sliced automatically.</p>
        <div className="row" style={{ alignItems: 'center' }}>
          {state === 'recording' && <span className="rec-dot" />}
          <span className="mono">{elapsed.toFixed(1)} s</span>
          <div className="rec-meter" style={{ flex: 1 }}>
            <div style={{ width: `${Math.min(100, level * 100)}%` }} />
          </div>
        </div>
        {take && state === 'done' && <WaveThumb data={take} height={60} />}
        {err && <div className="toast error">{err}</div>}
        <TextField label="Name" value={name} onChange={setName} testid="rec-name" />
        <div className="row">
          {state !== 'recording' && <Btn kind="primary" testid="rec-start" onClick={start}>{take ? '● Record again' : '● Record'}</Btn>}
          {state === 'recording' && <Btn kind="primary" testid="rec-stop" onClick={stopRec}>■ Stop</Btn>}
          <Btn testid="rec-replay" disabled={!take || state === 'recording'} onClick={replay}>▶ Replay</Btn>
          <div className="spacer" />
          <Btn testid="rec-discard" onClick={() => { cleanup(); setUI({ showRecorder: false }); }}>Discard</Btn>
          <Btn kind="primary" testid="rec-keep" disabled={!take || state === 'recording'} onClick={() => { if (take) keepRecording(take, name); setUI({ showRecorder: false, view: 'slice' }); }}>Keep</Btn>
        </div>
      </div>
    </div>
  );
}
