import React, { useMemo, useState } from 'react';
import { useStore, actions } from '../store/store';
import type { BeatContext, BeatRole, ScaleName } from '../../core/types';
import { Btn, Section, Select, Slider, Toggle, Empty, Meter } from '../components/ui';
import { keyName, barTicks, chordSymbol, prefersFlats, noteName } from '../../core/beat/analyze';
import { effectiveKey, describeBeat, vocalKeyFit } from '../../core/beat/fit';
import { SCALES } from '../../core/compose/theory';
import { DEMO_BEATS } from '../../core/demo/beats';
import { midiToName } from '../../core/time';
import { loadDemoBeat, pickBeatFile, setBeatFit, setBeatEnabled, overrideKey, removeBeat, recipesForCurrent, applyRecipe, inKeySliceIds, setPartRole, removePart, togglePartMute, pickBacking, setBacking, removeBacking } from '../services/beatService';
import { runInstant } from '../services/composeService';
import { play, stop } from '../transport';

function DropZone({ big }: { big?: boolean }) {
  return (
    <div className={`beat-drop ${big ? 'big' : ''}`} data-testid="beat-drop" onClick={() => pickBeatFile()}>
      <div className="beat-drop-icon">♫</div>
      <b>Drop your beat’s MIDI here</b>
      <span className="muted">Chords, arp, bass, lead, drums – one multi-track .mid or several files. Each part is recognised and used differently. You can also drop it anywhere in the window.</span>
      <Btn small onClick={(e) => { e.stopPropagation(); void pickBeatFile(); }}>Choose MIDI file…</Btn>
    </div>
  );
}

function DemoBeats() {
  return (
    <div className="col" style={{ gap: 4 }}>
      <span className="lbl">No MIDI to hand? Try a demo beat</span>
      {Object.entries(DEMO_BEATS).map(([k, b]) => (
        <Btn key={k} small testid={`demo-beat-${k}`} onClick={() => loadDemoBeat(k)}>{b.title}</Btn>
      ))}
    </div>
  );
}

const ROLE_OPTIONS: { value: BeatRole; label: string }[] = [
  { value: 'chords', label: 'Chords' },
  { value: 'arp', label: 'Arp' },
  { value: 'bass', label: 'Bass' },
  { value: 'lead', label: 'Lead / melody' },
  { value: 'drums', label: 'Drums' },
];
const ROLE_COLORS: Record<BeatRole, string> = { chords: '#8f9bff', arp: '#5fd0c5', bass: '#f0a35e', lead: '#ff7eb6', drums: '#9aa3b5' };
const ROLE_USE: Record<BeatRole, string> = {
  chords: 'sets key and chords; chops are tuned to them',
  arp: 'key, chords and rhythm; “Ride the arp” follows it',
  bass: 'confirms the chord roots',
  lead: 'chops stay out of its way (time and register)',
  drums: 'groove: half-time feel, kick/snare anchors',
};

function Parts({ beat }: { beat: BeatContext }) {
  const parts = beat.parts ?? [];
  return (
    <Section title={`Parts of your beat (${parts.length})`}>
      <div className="col" style={{ gap: 6 }} data-testid="beat-parts">
        {parts.map((p) => (
          <div key={p.id} className={`part ${p.muted ? 'muted-part' : ''}`} data-testid="beat-part">
            <div className="row tight" style={{ alignItems: 'center' }}>
              <span className="part-dot" style={{ background: ROLE_COLORS[p.role] }} />
              <b className="part-name" title={p.name}>{p.name}</b>
              <button className={`tbtn ${p.muted ? 'on' : ''}`} title="Mute in the preview (still analysed)" onClick={() => togglePartMute(p.id)}>M</button>
              {parts.length > 1 && <button className="tbtn" title="Remove this part" onClick={() => removePart(p.id)}>✕</button>}
            </div>
            <div className="row tight" style={{ alignItems: 'center' }}>
              <Select testid="part-role" value={p.role} options={ROLE_OPTIONS} onChange={(r) => setPartRole(p.id, r)} />
              <span className="dim" style={{ fontSize: 10.5 }}>{p.notes.length} notes</span>
            </div>
            <span className="dim" style={{ fontSize: 10.5 }}>{ROLE_USE[p.role]}</span>
          </div>
        ))}
      </div>
      <div className="beat-drop small" data-drop="add-part" data-testid="beat-add-part" onClick={() => pickBeatFile('add')}>
        <b>＋ Add another MIDI part</b>
        <span className="muted">bass, drums, lead… drop here or click</span>
      </div>
    </Section>
  );
}

function Backing() {
  const k = useStore((s) => s.doc.backing);
  return (
    <Section title="Beat audio (reference)">
      {!k ? (
        <div className="beat-drop small" data-drop="backing" data-testid="backing-drop" onClick={() => pickBacking()}>
          <b>＋ Add a bounce of your beat</b>
          <span className="muted">WAV/MP3 exported from bar 1 at the session tempo. It plays under the chops so you hear them in your actual track. Never exported.</span>
        </div>
      ) : (
        <div className="col" style={{ gap: 6 }} data-testid="backing">
          <Toggle label={`Play “${k.name}” under the chops`} testid="backing-enabled" value={k.enabled} onChange={(v) => setBacking({ enabled: v })} />
          <Slider label="Level" value={k.gain} min={-36} max={6} step={0.5} format={(v) => `${v.toFixed(1)} dB`} onChange={(v) => setBacking({ gain: v })} />
          <Slider label="Start offset" value={k.offsetMs} min={-2000} max={2000} step={1} format={(v) => `${v > 0 ? '+' : ''}${v} ms`} onChange={(v) => setBacking({ offsetMs: v })} />
          <span className="dim" style={{ fontSize: 10.5 }}>{(k.frames / k.sampleRate).toFixed(1)} s · loops with the arrangement · nudge the offset if the bounce has silence at the start</span>
          <div className="row tight">
            <Btn small onClick={() => pickBacking()}>Replace…</Btn>
            <Btn small kind="danger" onClick={() => removeBacking()}>Remove</Btn>
          </div>
        </div>
      )}
    </Section>
  );
}

function PianoRoll({ beat }: { beat: BeatContext }) {
  const W = 800;
  const H = 120;
  const pitched = beat.parts ? beat.parts.filter((p) => p.role !== 'drums').flatMap((p) => p.notes) : beat.notes;
  const all = pitched.length ? pitched : beat.notes;
  const lo = Math.min(...all.map((n) => n.pitch)) - 1;
  const hi = Math.max(...all.map((n) => n.pitch)) + 1;
  const x = (t: number) => (t / beat.lengthTicks) * W;
  const y = (p: number) => H - ((p - lo) / Math.max(1, hi - lo)) * H;
  const bar = barTicks(beat.timeSig);
  return (
    <svg className="roll" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" data-testid="beat-roll">
      {beat.chords.map((c, i) => <rect key={i} x={x(c.tick)} y={0} width={x(c.length)} height={H} fill={i % 2 ? '#ffffff05' : '#ffffff0b'} />)}
      {Array.from({ length: Math.round(beat.lengthTicks / bar) }, (_, b) => <line key={b} x1={x(b * bar)} x2={x(b * bar)} y1={0} y2={H} stroke="#323846" />)}
      {(beat.parts?.filter((p) => p.role !== 'drums') ?? [{ id: 'all', role: 'chords' as BeatRole, notes: beat.notes }]).flatMap((p) =>
        p.notes.filter((n) => n.tick < beat.lengthTicks).map((n, i) => <rect key={`${p.id}-${i}`} x={x(n.tick)} y={y(n.pitch) - 2} width={Math.max(1.5, x(n.length) - 1)} height={Math.max(2, H / (hi - lo) - 1)} rx={1} fill={ROLE_COLORS[p.role]} opacity={0.45 + n.velocity * 0.55} />),
      )}
    </svg>
  );
}

function DrumGrid({ beat }: { beat: BeatContext }) {
  const d = beat.drums;
  if (!d) return null;
  const rows: [string, number[]][] = [['Hat', d.hat], ['Snare', d.snare], ['Kick', d.kick]];
  return (
    <div className="drum-grid" data-testid="beat-drums">
      {rows.map(([name, steps]) => (
        <div key={name} className="drum-row">
          <span>{name}</span>
          {steps.map((v, i) => <i key={i} className={`${i % 4 === 0 ? 'beat' : ''} ${v >= 0.5 ? 'on' : v > 0 ? 'some' : ''}`} />)}
        </div>
      ))}
    </div>
  );
}

function RhythmProfile({ beat }: { beat: BeatContext }) {
  const steps = beat.rhythm.steps;
  return (
    <div className="steps" data-testid="beat-steps">
      {steps.map((v, i) => (
        <div key={i} className={`step ${i % 4 === 0 ? 'beat' : ''} ${v < 0.2 ? 'free' : ''}`} title={`step ${i + 1}: ${Math.round(v * 100)}% of bars have an onset${v < 0.2 ? ' – free for vocal chops' : ''}`}>
          <div style={{ height: `${Math.max(4, v * 100)}%` }} />
        </div>
      ))}
    </div>
  );
}

const SCALE_OPTIONS: ScaleName[] = ['minor', 'major', 'dorian', 'phrygian', 'harmonic-minor', 'minor-pentatonic', 'major-pentatonic'];

export function BeatView() {
  const doc = useStore((s) => s.doc);
  const playing = useStore((s) => s.playing);
  const setUI = useStore((s) => s.setUI);
  const beat = doc.beat;
  const [showAll, setShowAll] = useState(false);
  const fit = useMemo(() => (beat ? vocalKeyFit(doc.slices, doc.sources, beat) : null), [beat, doc.slices, doc.sources]);
  const recipes = useMemo(() => (beat ? recipesForCurrent() : []), [beat, doc.sources]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!beat)
    return (
      <div className="view beat-view-empty">
        <div className="welcome">
          <h1>Fit your vocal chops to your beat.</h1>
          <p className="muted" style={{ margin: 0 }}>
            Drop the MIDI of your beat’s chords or arp. Vocal Chop Studio reads its key, scale, chord changes, rhythm and free space, sets the tempo and key of the session, and suggests ideas that are tuned to the chords and placed around the beat’s rhythm. Your existing workflow stays exactly the same – this just adds awareness of your song.
          </p>
          <DropZone big />
          <DemoBeats />
        </div>
      </div>
    );

  const k = effectiveKey(beat);
  const flats = prefersFlats(k.root, k.scale);
  const bars = beat.lengthTicks / barTicks(beat.timeSig);
  const bar = barTicks(beat.timeSig);
  const pitchedVocal = fit && fit.pitched > 0;

  return (
    <div className="view beat-view">
      <aside className="panel">
        <Section title="Beat">
          <DropZone />
          <dl className="info-grid" data-testid="beat-info">
            <dt>Name</dt><dd>{beat.name}</dd>
            <dt>Tempo</dt><dd>{beat.bpm ? `${Math.round(beat.bpm * 100) / 100} BPM` : 'not in file (kept session tempo)'}</dd>
            <dt>Metre</dt><dd>{beat.timeSig.join('/')}</dd>
            <dt>Loop</dt><dd>{bars} bar{bars > 1 ? 's' : ''} · {beat.notes.length} notes</dd>
            {beat.rhythm.feel && <><dt>Feel</dt><dd>{beat.rhythm.feel === 'half' ? 'half-time (from the drums)' : 'normal time'}</dd></>}
            <dt>Range</dt><dd>{midiToName(Math.min(...beat.notes.map((n) => n.pitch)))}–{midiToName(Math.max(...beat.notes.map((n) => n.pitch)))}</dd>
          </dl>
          <Toggle label="Use this beat when composing" testid="beat-enabled" value={beat.enabled} onChange={setBeatEnabled} />
          <Toggle label="Play beat preview under the vocals" testid="beat-preview" value={beat.fit.preview} onChange={(v) => setBeatFit({ preview: v })} title="A simple synth playback of the MIDI – for auditioning only, never exported" />
          {beat.fit.preview && <Slider label="Preview level" value={beat.fit.previewGain} min={-36} max={0} step={1} format={(v) => `${v} dB`} onChange={(v) => setBeatFit({ previewGain: v })} />}
          <div className="row tight">
            <Btn small testid="beat-play" onClick={() => (playing ? stop() : play(0))}>{playing ? '■ Stop' : '▶ Play with vocals'}</Btn>
            <Btn small kind="danger" onClick={() => window.confirm('Remove the beat context? (Your arrangement is kept.)') && removeBeat()}>Remove beat</Btn>
          </div>
        </Section>
        <Parts beat={beat} />
        <Backing />
        <Section title="Other beats">
          <DemoBeats />
        </Section>
      </aside>
      <main className="main" style={{ overflow: 'auto' }}>
        <div className="beat-main">
          <div className="beat-key-card" data-testid="beat-key">
            <div>
              <span className="lbl">Key & scale</span>
              <div className="beat-key">{keyName(k.root, k.scale)}</div>
              {!beat.keyOverride ? <Meter label="confidence" value={beat.key.confidence} /> : <span className="chip on">set by you</span>}
            </div>
            <div className="col" style={{ gap: 6 }}>
              <span className="lbl">Could also be</span>
              <div className="tags">
                {beat.key.alternatives.map((a, i) => (
                  <span key={i} className="chip" style={{ cursor: 'pointer' }} onClick={() => overrideKey(a.root, a.scale)}>{keyName(a.root, a.scale)}</span>
                ))}
                {beat.keyOverride && <span className="chip on" style={{ cursor: 'pointer' }} data-testid="key-auto" onClick={() => overrideKey(null)}>↺ detected: {keyName(beat.key.root, beat.key.scale)}</span>}
              </div>
              <div className="row tight">
                <Select testid="key-root" value={k.root} options={Array.from({ length: 12 }, (_, i) => ({ value: i, label: noteName(i, flats) }))} onChange={(r) => overrideKey(r, k.scale)} />
                <Select testid="key-scale" value={k.scale} options={SCALE_OPTIONS.map((x) => ({ value: x, label: x }))} onChange={(sc) => overrideKey(k.root, sc)} />
              </div>
            </div>
          </div>
          <Section title="Chords">
            <div className="chord-strip" data-testid="beat-chords">
              {beat.chords.map((c, i) => (
                <div key={i} className="chord" style={{ flex: c.length }} title={`${chordSymbol(c.root, c.quality, flats)} · bar ${Math.floor(c.tick / bar) + 1} · ${c.pcs.map((p) => noteName(p, flats)).join(' ')}`}>
                  <b>{chordSymbol(c.root, c.quality, flats)}</b>
                  <small>{c.pcs.map((p) => noteName(p, flats)).join(' ')}</small>
                </div>
              ))}
            </div>
            <PianoRoll beat={beat} />
          </Section>
          <Section title="Rhythm & space – where the beat hits (one bar, sixteenths)">
            <RhythmProfile beat={beat} />
            <DrumGrid beat={beat} />
            <ul className="desc-list" data-testid="beat-description" style={{ maxHeight: 'none' }}>
              {describeBeat(beat).map((d, i) => <li key={i}>{d}</li>)}
            </ul>
          </Section>
        </div>
      </main>
      <aside className="panel right">
        <Section title="Your vocal vs this beat">
          {!doc.slices.length ? (
            <Empty>Import or record your vocal (Sources & Slices) – it will be checked against this key.</Empty>
          ) : pitchedVocal ? (
            <>
              <Meter label="in key" value={fit!.fitRatio} />
              <span className="muted" style={{ fontSize: 12 }} data-testid="vocal-fit">
                {fit!.inKey.length} of {fit!.pitched} pitched slices sit in {keyName(k.root, k.scale)}, {fit!.near.length} are a semitone away, {fit!.outOfKey.length} are out of key; {fit!.unpitched.length} unpitched sounds (breaths, consonants) fit anywhere.
                {fit!.suggestedShift !== 0 && ` Your vocal sits about ${Math.abs(fit!.suggestedShift)} semitone${Math.abs(fit!.suggestedShift) > 1 ? 's' : ''} ${fit!.suggestedShift > 0 ? 'below' : 'above'} the beat’s key – transposition (playback rate) will be applied per note.`}
              </span>
              <Btn small testid="use-inkey" onClick={() => { actions.setSettings({ sliceIds: inKeySliceIds(), materialKey: 'beat-key' }); useStore.getState().toast('Material: slices that fit the beat’s key', 'success'); }}>Use in-key slices as material</Btn>
            </>
          ) : (
            <span className="muted">No pitched slices detected – chops will be placed rhythmically; pitch fitting needs pitched material.</span>
          )}
        </Section>
        <Section title="Fit settings">
          <Toggle label="Harmonise pitched notes to the chords" testid="fit-harmonize" value={beat.fit.harmonize} onChange={(v) => setBeatFit({ harmonize: v })} />
          <Select label="Rhythm" testid="fit-rhythm" value={beat.fit.rhythm} options={[
            { value: 'complement', label: 'Leave room for the beat (fill its gaps)' },
            { value: 'follow', label: 'Follow the beat (lock to its hits)' },
            { value: 'off', label: 'Ignore the beat’s rhythm' },
          ]} onChange={(v) => setBeatFit({ rhythm: v as any })} />
        </Section>
        <Section title="Curated for your song">
          <Btn kind="primary" testid="beat-instant" disabled={!doc.slices.length} onClick={() => runInstant()} title="Tries several styles against this beat and keeps the six strongest, most different ideas">⚡ Instant ideas for this beat</Btn>
          {(showAll ? recipes : recipes.slice(0, 4)).map((r) => (
            <div key={r.id} className="recipe" data-testid={`recipe-${r.id}`}>
              <b>{r.title}</b>
              <span>{r.why}</span>
              <div className="row tight">
                <Btn small kind="primary" testid={`recipe-go-${r.id}`} disabled={!doc.slices.length} onClick={() => applyRecipe(r, true)}>✦ Generate 6 ideas</Btn>
                <Btn small onClick={() => { applyRecipe(r, false); setUI({ view: 'compose' }); }}>Set up only</Btn>
              </div>
            </div>
          ))}
          {recipes.length > 4 && <Btn small kind="ghost" onClick={() => setShowAll(!showAll)}>{showAll ? 'Fewer' : `${recipes.length - 4} more`}</Btn>}
          {!doc.slices.length && <span className="dim" style={{ fontSize: 11 }}>Add a vocal first to generate.</span>}
        </Section>
      </aside>
    </div>
  );
}
