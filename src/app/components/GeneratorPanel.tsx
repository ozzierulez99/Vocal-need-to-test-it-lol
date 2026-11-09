import React from 'react';
import { useStore, actions } from '../store/store';
import type { ComposeMode, Direction, RhythmFeel, Role, ScaleName, MidiMapping, ConversationRelation, CreativeControls } from '../../core/types';
import { ROLES } from '../../core/types';
import { DIRECTIONS, FEEL_LABELS } from '../../core/compose/directions';
import { MODE_LABELS, defaultLayers } from '../../core/compose/engine';
import { SCALES } from '../../core/compose/theory';
import { NOTE_NAMES, midiToName } from '../../core/time';
import { Btn, NumberField, Section, Select, Slider, Toggle } from './ui';
import { generateIdeas, composeDirect, regenerateBars, regenerateLayer } from '../services/composeService';
import { importMidi, importMidiBytes } from '../services/projectService';
import { demoMidiFile } from '../../core/demo/examples';
import { guidePitches } from '../../core/midi/midi';

const MODE_INFO: Record<ComposeMode, string> = {
  melodic: 'Memorable hooks: motif, contour, phrase endings, rests',
  rhythmic: 'Syncopation, accents, retriggers, groove',
  phrase: 'Reorder, repeat, remove & fragment words',
  ghost: 'Sparse, sustained, overlapping atmosphere',
  microchop: 'Tiny retriggers & stutters with a rhythmic idea',
  midi: 'Trigger slices from a MIDI file',
  conversation: 'Two voices: call & response and more',
};

const CONTROL_INFO: Record<keyof CreativeControls, [string, string]> = {
  recognisability: ['Recognisability', 'Abstract fragments ↔ full words and phrases'],
  repetition: ['Repetition', 'How often familiar slices and motifs return'],
  fragmentation: ['Fragmentation', 'Long phrases ↔ syllables and microchops'],
  space: ['Space', 'How many rests and gaps appear'],
  melodicMovement: ['Melodic movement', 'How actively pitch / register changes'],
  surprise: ['Surprise', 'How unconventional the decisions become'],
};

const RELATIONS: { value: ConversationRelation; label: string }[] = [
  { value: 'call-response', label: 'Call and response' },
  { value: 'alternating', label: 'Alternating phrases' },
  { value: 'interrupt', label: 'B interrupts A' },
  { value: 'imitate', label: 'B imitates A’s rhythm' },
  { value: 'overlap-growth', label: 'Gradually increasing overlap' },
  { value: 'complementary', label: 'Complementary rhythms (hocket)' },
  { value: 'ostinato', label: 'B repeats underneath A' },
  { value: 'fragmenting', label: 'Increasingly fragmented' },
];

export function GeneratorPanel() {
  const s = useStore((st) => st.doc.sequence.settings);
  const doc = useStore((st) => st.doc);
  const ui = useStore((st) => st.ui);
  const set = actions.setSettings;
  const autoLayers = defaultLayers(s.mode, { ...s, bars: doc.sequence.bars });
  const layers = s.layers.length ? s.layers : autoLayers;
  const sources = doc.sources.filter((x) => !x.missing);
  const sliceIdsOf = (srcId: string) => doc.slices.filter((x) => x.sourceId === srcId && x.level !== 'phrase').map((x) => x.id);

  const materialOptions = [
    { value: 'all', label: `All slices (${doc.slices.length})` },
    { value: 'favourites', label: `Favourites (${doc.slices.filter((x) => x.favourite).length})` },
    { value: 'selection', label: `Selected in library (${ui.sliceIds.length})` },
    ...sources.map((x) => ({ value: `source:${x.id}`, label: `Source: ${x.name}` })),
    ...doc.collections.map((c) => ({ value: `collection:${c.id}`, label: `Collection: ${c.name} (${c.sliceIds.length})` })),
  ];
  const setMaterial = (key: string) => {
    let ids: string[] = [];
    if (key === 'favourites') ids = doc.slices.filter((x) => x.favourite).map((x) => x.id);
    else if (key === 'selection') ids = ui.sliceIds.slice();
    else if (key.startsWith('source:')) ids = doc.slices.filter((x) => x.sourceId === key.slice(7)).map((x) => x.id);
    else if (key.startsWith('collection:')) ids = doc.collections.find((c) => c.id === key.slice(11))?.sliceIds.slice() ?? [];
    if (key !== 'all' && !ids.length) return useStore.getState().toast('That material set is empty', 'error');
    set({ sliceIds: ids, materialKey: key });
  };
  const voiceSrc = (ids?: string[]) => doc.slices.find((x) => ids?.includes(x.id))?.sourceId ?? '';

  const guide = s.midi;
  const pitches = guide ? guidePitches(guide) : [];
  const material = s.sliceIds.length ? doc.slices.filter((x) => s.sliceIds.includes(x.id)) : doc.slices;

  return (
    <aside className="panel" data-testid="generator">
      <Section title="Composition mode">
        <div className="modes">
          {(Object.keys(MODE_LABELS) as ComposeMode[]).map((m) => (
            <button key={m} data-testid={`mode-${m}`} className={`mode-tile ${s.mode === m ? 'on' : ''}`} onClick={() => set({ mode: m })}>
              <b>{MODE_LABELS[m].replace(' Composer', '').replace('Chop ', '')}</b>
              <small>{MODE_INFO[m]}</small>
            </button>
          ))}
        </div>
      </Section>
      <Section title="Musical direction">
        <Select testid="direction" value={s.direction} options={(Object.keys(DIRECTIONS) as Direction[]).map((d) => ({ value: d, label: DIRECTIONS[d].label }))} onChange={(d) => set({ direction: d, feel: DIRECTIONS[d].defaultFeel, controls: { ...DIRECTIONS[d].controls } })} />
        <div className="blurb">{DIRECTIONS[s.direction].blurb}</div>
        <Select label="Rhythmic feel" testid="feel" value={s.feel} options={(Object.keys(FEEL_LABELS) as RhythmFeel[]).map((f) => ({ value: f, label: FEEL_LABELS[f] }))} onChange={(f) => set({ feel: f })} />
      </Section>
      <Section title="Creative controls" right={<Btn small kind="ghost" onClick={() => set({ controls: { ...DIRECTIONS[s.direction].controls } })}>Reset</Btn>}>
        {(Object.keys(CONTROL_INFO) as (keyof CreativeControls)[]).map((k) => (
          <Slider key={k} testid={`ctl-${k}`} label={CONTROL_INFO[k][0]} hint={CONTROL_INFO[k][1]} value={s.controls[k]} format={(v) => `${Math.round(v * 100)}`} onChange={(v) => set({ controls: { ...s.controls, [k]: v } })} />
        ))}
      </Section>
      <Section title="Material">
        <Select testid="material" value={s.materialKey && materialOptions.some((o) => o.value === s.materialKey) ? s.materialKey : s.sliceIds.length ? 'selection' : 'all'} options={materialOptions} onChange={setMaterial} />
        <span className="dim" style={{ fontSize: 11 }}>{material.length} slices available to the generator</span>
        {s.mode === 'conversation' && (
          <>
            <Select label="Voice A" testid="voice-a" value={voiceSrc(s.voiceA)} options={[{ value: '', label: '— choose source —' }, ...sources.map((x) => ({ value: x.id, label: x.name }))]} onChange={(v) => set({ voiceA: v ? sliceIdsOf(v) : [] })} />
            <Select label="Voice B" testid="voice-b" value={voiceSrc(s.voiceB)} options={[{ value: '', label: '— choose source —' }, ...sources.map((x) => ({ value: x.id, label: x.name }))]} onChange={(v) => set({ voiceB: v ? sliceIdsOf(v) : [] })} />
            <Select label="Relationship" testid="relation" value={s.relation ?? 'call-response'} options={RELATIONS} onChange={(v) => set({ relation: v })} />
          </>
        )}
        {s.mode === 'midi' && (
          <>
            <div className="row tight">
              <Btn small testid="import-midi" onClick={() => importMidi()}>Import MIDI…</Btn>
              <Btn small testid="demo-midi" onClick={() => importMidiBytes(demoMidiFile(), 'Garage riff (demo).mid')}>Demo riff</Btn>
            </div>
            {doc.midiGuides.length > 0 && (
              <Select label="Guide" value={guide ? doc.midiGuides.findIndex((g) => g.name === guide.name && g.notes.length === guide.notes.length) : -1} options={[{ value: -1, label: '— none —' }, ...doc.midiGuides.map((g, i) => ({ value: i, label: `${g.name} (${g.notes.length} notes)` }))]} onChange={(i) => set({ midi: i >= 0 ? { ...doc.midiGuides[i] } : undefined })} />
            )}
            {guide && (
              <>
                <Select label="Mapping" testid="midi-mapping" value={guide.mapping} options={[{ value: 'rhythm-cycle', label: 'Rhythm: cycle motif slices' }, { value: 'single', label: 'One slice on every note' }, { value: 'pitch-map', label: 'Map pitches to slices' }] as { value: MidiMapping; label: string }[]} onChange={(v) => set({ midi: { ...guide, mapping: v } })} />
                <div className="row">
                  <Toggle label="Use pitch (rate)" value={guide.usePitch} onChange={(v) => set({ midi: { ...guide, usePitch: v } })} testid="midi-pitch" title="Transpose by playback rate – pitch and length change together" />
                  <Toggle label="Velocity" value={guide.useVelocity} onChange={(v) => set({ midi: { ...guide, useVelocity: v } })} />
                  <Toggle label="Durations" value={guide.useDuration} onChange={(v) => set({ midi: { ...guide, useDuration: v } })} />
                </div>
                {guide.usePitch && guide.mapping !== 'pitch-map' && <NumberField label={`Root (plays untransposed) ${midiToName(guide.rootPitch)}`} value={guide.rootPitch} min={0} max={127} onChange={(v) => set({ midi: { ...guide, rootPitch: v } })} />}
                {guide.mapping === 'single' && (
                  <Select label="Slice" value={s.sliceIds[0] ?? ''} options={[{ value: '', label: 'best hook slice' }, ...material.map((x) => ({ value: x.id, label: x.name }))]} onChange={(v) => set({ sliceIds: v ? [v, ...s.sliceIds.filter((i) => i !== v)] : s.sliceIds })} />
                )}
                {guide.mapping === 'pitch-map' && (
                  <div className="col" style={{ gap: 4 }}>
                    {pitches.map((p) => (
                      <Select key={p} label={`${midiToName(p)} →`} value={guide.pitchMap[p] ?? ''} options={[{ value: '', label: 'auto' }, ...material.map((x) => ({ value: x.id, label: x.name }))]} onChange={(v) => set({ midi: { ...guide, pitchMap: { ...guide.pitchMap, [p]: v } } })} />
                    ))}
                  </div>
                )}
              </>
            )}
            {!guide && <span className="dim">Import a standard MIDI file – its note timing triggers your slices.</span>}
          </>
        )}
      </Section>
      <Section title="Musical settings">
        <div className="row">
          <NumberField label="Phrase bars" testid="phrase-bars" value={s.phraseBars} min={1} max={8} onChange={(v) => set({ phraseBars: v })} />
          <Select label="Register" value={s.register} options={[{ value: 'low', label: 'Low' }, { value: 'mid', label: 'Mid' }, { value: 'high', label: 'High' }]} onChange={(v) => set({ register: v })} />
        </div>
        <div className="row">
          <Select label="Key" value={s.keyRoot ?? -1} options={[{ value: -1, label: 'none (natural)' }, ...NOTE_NAMES.map((n, i) => ({ value: i, label: n }))]} onChange={(v) => set({ keyRoot: v < 0 ? null : v })} />
          <Select label="Scale" value={s.scale} options={(Object.keys(SCALES) as ScaleName[]).map((x) => ({ value: x, label: x }))} onChange={(v) => set({ scale: v })} />
        </div>
        <Toggle label="Transpose slices to the melody (playback rate)" testid="transpose" value={s.transpose} onChange={(v) => set({ transpose: v })} title="Off: melodies are made by choosing slices with different natural pitches" />
        <Slider label="Rhythmic complexity" value={s.complexity} onChange={(v) => set({ complexity: v })} format={(v) => `${Math.round(v * 100)}`} />
        <div>
          <span className="lbl">Layers {s.layers.length ? '' : '(automatic for this mode)'}</span>
          <div className="row tight" style={{ marginTop: 4 }}>
            {ROLES.map((r) => (
              <Toggle key={r} label={r} testid={`layer-${r}`} value={layers.includes(r)} onChange={(on) => set({ layers: on ? Array.from(new Set([...layers, r])) : layers.filter((x) => x !== r) })} />
            ))}
            {s.layers.length > 0 && <Btn small kind="ghost" onClick={() => set({ layers: [] })}>auto</Btn>}
          </div>
        </div>
        <div className="row">
          <NumberField label="Seed" testid="seed" value={s.seed} min={0} onChange={(v) => set({ seed: Math.floor(v) })} width={100} />
          <Btn small onClick={() => set({ seed: Math.floor(Math.random() * 1e6) })} title="New random seed">🎲</Btn>
        </div>
      </Section>
      <div className="gen-actions">
        <Btn kind="primary" testid="generate-ideas" onClick={() => generateIdeas(6)}>✦ Generate 6 ideas</Btn>
        <div className="row tight">
          <Btn testid="compose-direct" onClick={() => composeDirect()}>Compose into arrangement</Btn>
        </div>
        <div className="row tight">
          <Btn small testid="regen-bars" disabled={!ui.bars} onClick={() => ui.bars && regenerateBars(ui.bars[0], ui.bars[1])} title="Select bars in the ruler first">↻ Bars {ui.bars ? `${ui.bars[0] + 1}–${ui.bars[1]}` : ''}</Btn>
          <Btn small testid="regen-layer" disabled={!ui.trackId} onClick={() => ui.trackId && regenerateLayer(ui.trackId)}>↻ Selected layer</Btn>
        </div>
      </div>
    </aside>
  );
}

export type { Role };
