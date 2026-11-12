import React, { useState } from 'react';
import { useStore, actions } from '../store/store';
import { Btn, Section, Select, NumberField } from '../components/ui';
import { exportMixFile, exportStems, exportSlices, exportMidiPackage, type ExportFile } from '../../core/project/exporters';
import { platform } from '../platform/platform';
import { mixFile, prepareDrag, startDrag, canDragOut } from '../services/exportService';
import { safeName } from '../../core/midi/midi';
import { ticksPerBar } from '../../core/time';

export function ExportView() {
  const doc = useStore((s) => s.doc);
  const rt = useStore((s) => s.rt);
  const ui = useStore((s) => s.ui);
  const es = doc.exportSettings;
  const fx = doc.fx;
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [trackId, setTrackId] = useState('');
  const seq = doc.sequence;
  const durSec = (seq.bars * ticksPerBar(seq.timeSig) * 60) / (seq.bpm * 960);
  const usedTracks = seq.tracks.filter((t) => seq.events.some((e) => e.trackId === t.id));
  const name = safeName(doc.name || 'vocal-chop');

  const run = async (label: string, make: () => ExportFile[] | (ExportFile & { result?: any })[] | Promise<ExportFile[]>, folder: string) => {
    if (!seq.events.length && !label.includes('slice')) return useStore.getState().toast('Nothing to export – the arrangement is empty', 'error');
    setBusy(true);
    await new Promise((r) => setTimeout(r, 20));
    try {
      const t0 = performance.now();
      const files = await make();
      const where = await platform.writeExport(files, folder);
      if (!where) return;
      const lines = files.map((f: any) => `  ${f.name}  (${(f.bytes.length / 1024).toFixed(0)} KB)${f.result ? `  peak ${(20 * Math.log10(Math.max(1e-9, f.result.peak))).toFixed(1)} dBFS${f.result.appliedGain !== 1 ? `, level ×${f.result.appliedGain.toFixed(2)}` : ''}` : ''}`);
      setLog((l) => [`${new Date().toLocaleTimeString()} ${label} → ${where} (${Math.round(performance.now() - t0)} ms)`, ...lines, '', ...l].slice(0, 200));
      useStore.getState().toast(`${label}: ${files.length} file(s) → ${where}`, 'success');
      if (platform.reveal && files.length) platform.reveal(`${where}/${files[0].name}`);
    } catch (e) {
      useStore.getState().toast(`Export failed: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  const bars = ui.bars;
  const favIds = doc.slices.filter((s) => s.favourite).map((s) => s.id);
  const usedSliceIds = Array.from(new Set(seq.events.map((e) => e.sliceId)));

  return (
    <div className="view export-view">
      <aside className="panel">
        <Section title="Audio format">
          <div className="row">
            <Select label="Sample rate" testid="exp-sr" value={es.sampleRate} options={[44100, 48000, 88200, 96000].map((v) => ({ value: v, label: `${v / 1000} kHz` }))} onChange={(v) => actions.setExportSettings({ sampleRate: v })} />
            <Select label="Bit depth" testid="exp-bits" value={es.bitDepth} options={[{ value: 16, label: '16-bit' }, { value: 24, label: '24-bit' }, { value: 32, label: '32-bit float' }]} onChange={(v) => actions.setExportSettings({ bitDepth: v as 16 | 24 | 32 })} />
          </div>
          <Select label="Level" value={es.level} options={[{ value: 'prevent-clip', label: 'Prevent clipping (scale down only if needed)' }, { value: 'normalize', label: 'Normalise to −1 dBFS' }, { value: 'none', label: 'Untouched (may clip in 16/24-bit)' }]} onChange={(v) => actions.setExportSettings({ level: v })} />
          <Select label="Tail after the last bar" value={es.tail} options={[{ value: 'keep', label: 'Keep ringing tails' }, { value: 'cut', label: 'Cut exactly at the end' }, { value: 'wrap', label: 'Wrap tail to start (loop-ready)' }]} onChange={(v) => actions.setExportSettings({ tail: v })} />
          <NumberField label="Click-guard fade at every event boundary" value={es.clickFadeMs} min={0} max={50} step={0.5} suffix="ms" onChange={(v) => { actions.setExportSettings({ clickFadeMs: v }); useStore.getState().setPrefs((d) => void (d.clickFadeMs = v)); }} />
        </Section>
        <Section title="Arrangement">
          <dl className="info-grid">
            <dt>Tempo</dt><dd>{seq.bpm} BPM · {seq.timeSig.join('/')}</dd>
            <dt>Length</dt><dd>{seq.bars} bars · {durSec.toFixed(2)} s</dd>
            <dt>Layers</dt><dd>{usedTracks.length}</dd>
            <dt>Events</dt><dd>{seq.events.length}</dd>
            <dt>Selected bars</dt><dd>{bars ? `${bars[0] + 1}–${bars[1]}` : 'none (select in Compose ruler)'}</dd>
          </dl>
          <p className="dim" style={{ margin: 0, fontSize: 11 }}>Exports are rendered offline from the same event model used for playback. Pitch changes are playback-rate based (pitch and duration together); no time-stretching or formant processing is applied.</p>
        </Section>
      </aside>
      <main className="main">
        <div className="export-cards">
          <div className="export-card">
            <h4>Full arrangement</h4>
            <p>Stereo mix of all audible layers (mute/solo respected).</p>
            <Btn kind="primary" testid="export-mix" disabled={busy} onClick={() => run('Mix', async () => [await mixFile()], `${name}_mix`)}>Export mix WAV</Btn>
            {canDragOut() && <span className="btn drag-out" data-testid="drag-mix" draggable title="Drag the arrangement straight into your DAW" onMouseEnter={() => void prepareDrag(null)} onDragStart={(e) => { e.preventDefault(); startDrag(null); }}>⇱ Drag into your DAW</span>}
            {fx?.print && (fx.reverb > 0 || fx.delay > 0) && <p className="watch" style={{ margin: 0 }}>Audition reverb/delay will be printed into this mix (toggle “Print” in Compose).</p>}
          </div>
          <div className="export-card">
            <h4>Selected bars / loop</h4>
            <p>Render only the bars selected in the ruler – optionally loop-ready (tail folded to the start so it loops seamlessly).</p>
            <div className="row tight">
              <Btn disabled={!bars || busy} testid="export-bars" onClick={() => bars && run('Bars', async () => [await mixFile({ startBar: bars[0], endBar: bars[1] })], `${name}_bars`)}>Export bars</Btn>
              <Btn disabled={busy} testid="export-loop" onClick={() => run('Loop', () => [exportMixFile(doc, rt.audio, es, { startBar: bars?.[0], endBar: bars?.[1], loopReady: true })], `${name}_loop`)}>Loop-ready WAV</Btn>
            </div>
          </div>
          <div className="export-card">
            <h4>Stems (one WAV per layer)</h4>
            <p>Equal-length files that line up from bar 1 – ideal for separate reverb/delay processing in your DAW. Stems sum to the dry mix (effects are never printed into stems).</p>
            <Btn disabled={busy} testid="export-stems" onClick={() => run('Stems', () => exportStems(doc, rt.audio, es), `${name}_stems`)}>Export {usedTracks.length} stems</Btn>
          </div>
          <div className="export-card">
            <h4>Single layer</h4>
            <div className="row tight">
              <Select value={trackId} options={[{ value: '', label: '— choose layer —' }, ...usedTracks.map((t) => ({ value: t.id, label: t.name }))]} onChange={setTrackId} />
              <Btn disabled={!trackId || busy} onClick={() => run('Layer', () => [{ ...exportMixFile(doc, rt.audio, es, { trackIds: [trackId] }), name: `${name}_${safeName(seq.tracks.find((t) => t.id === trackId)?.name ?? 'layer')}.wav` }], `${name}_layer`)}>Export</Btn>
            </div>
          </div>
          <div className="export-card">
            <h4>Slices</h4>
            <p>Individual chops as WAV (with the click-guard fade), for samplers.</p>
            <div className="row tight">
              <Btn disabled={busy || !usedSliceIds.length} testid="export-used-slices" onClick={() => run('Used slices', () => exportSlices(doc, rt.audio, usedSliceIds, es), `${name}_slices`)}>Slices used ({usedSliceIds.length})</Btn>
              <Btn disabled={busy || !favIds.length} onClick={() => run('Favourite slices', () => exportSlices(doc, rt.audio, favIds, es), `${name}_favourites`)}>Favourites ({favIds.length})</Btn>
              <Btn disabled={busy || !doc.slices.length} onClick={() => run('All slices', () => exportSlices(doc, rt.audio, doc.slices.map((s) => s.id), es), `${name}_all-slices`)}>All ({doc.slices.length})</Btn>
            </div>
          </div>
          <div className="export-card">
            <h4>MIDI triggers + slice map</h4>
            <p>One note per slice (C1 up), one MIDI track per layer, velocities from accents, plus the slice WAVs and a mapping file. MIDI alone cannot reproduce the audio – load the WAVs into a sampler using the mapping.</p>
            <div className="row tight">
              <Btn disabled={busy} testid="export-midi-trigger" onClick={() => run('MIDI triggers', () => exportMidiPackage(doc, rt.audio, es, 'trigger'), `${name}_midi-triggers`)}>Trigger package</Btn>
              <Btn disabled={busy} testid="export-midi-pitch" onClick={() => run('MIDI melodic', () => exportMidiPackage(doc, rt.audio, es, 'pitch'), `${name}_midi-melodic`)}>Melodic (per-slice tracks)</Btn>
            </div>
          </div>
        </div>
        <div style={{ padding: '0 14px 14px', overflow: 'auto', flex: 1 }}>
          <Section title="Export log">
            <div className="log" data-testid="export-log">{log.length ? log.join('\n') : 'Nothing exported yet.'}</div>
          </Section>
        </div>
      </main>
    </div>
  );
}
