# Vocal Chop Studio

An offline desktop workstation for turning vocal recordings into original vocal-chop ideas.
Import (or record) a vocal, chop it into reusable fragments, and let a procedural composition
engine write hooks, rhythmic chops, reconstructed phrases, ghost textures, stutter sequences,
MIDI-guided patterns and two-voice conversations from it. Everything stays editable on a
non-destructive timeline and exports to WAV / MIDI for your DAW.

The core idea: **simple, reliable audio operations** (slice, trim, repeat, reverse, layer, gain,
fades, playback-rate) combined with **musical decision-making** (motifs, form, call-and-response,
deliberate silence, development, roles).

---

## 1. Application overview

Main workflow (`Alt+1…5` switches workspaces):

| Workspace | What you do there |
|---|---|
| **Sources & Slices** | Import WAV/MP3/FLAC/…, record your voice, or add a synthetic demo vocal. Inspect the waveform, auto-chop or slice by hand on four coexisting levels (phrase / word / syllable / sound), tag and audition fragments. |
| **Beat Fit** | *Optional.* Drop the MIDI of your beat's chords or arp (anywhere in the window). The app reads its key & scale, chord progression, rhythm and free space, aligns the session (tempo, metre, key, length) and offers recipes curated to the song. With a beat loaded, generation is tuned to its chords and placed around its rhythm, and a quiet synth preview of the MIDI plays under the vocals. See §6b. |
| **Compose & Explore** | Pick a composition mode, a musical direction and six high-level controls. *Generate 6 ideas* fills the **Idea Lab** with meaningfully different candidates you can audition, A/B, keep, apply (whole / selected bars / as extra layers) or vary. Edit the result on the multi-layer timeline; lock events, bars, layers, silences and motifs; regenerate only selected bars or one layer. |
| **Library** | Browse/filter every slice (search, level, category, favourites, sorting), audition, build collections, save timeline phrases for reuse, export chops. |
| **Export** | Mix, selected bars, loop-ready audio, per-layer stems, single layers, slices (used / favourites / all), MIDI trigger + slice-map packages, melodic MIDI. |

A first-time user can: *Add demo vocal → Compose with these slices → ✦ Generate 6 ideas → ▶ → Apply → Export mix* in under a minute. The welcome screen also offers six example projects, one per first-class workflow (A–F).

## 2. Technical architecture

* **Stack:** Electron 45 (desktop shell) · React 19 + TypeScript (UI) · Zustand + Immer (state, undo/redo) · Web Audio API (live playback) · a pure-TypeScript offline renderer (export) · `@tonejs/midi` (MIDI I/O) · `fflate` (zip bundles) · Vite (bundling) · Vitest + Playwright (tests).
* **Separation of responsibilities** (`src/core` has no DOM or React dependency and runs in Node):

```
src/core/types.ts              data model (sources, slices, events, tracks, motifs, candidates, project)
src/core/audio/wav.ts          WAV decode/encode (8/16/24/32-bit PCM, 32/64-bit float, extensible)
src/core/audio/analysis.ts     RMS envelopes, silence regions, onset detection, YIN-style pitch, slice features
src/core/audio/peaks.ts        multi-resolution waveform peak cache
src/core/audio/plan.ts         Sequence → PlannedEvent[]  (the single bridge used by playback AND export)
src/core/audio/render.ts       offline mixer (sample-accurate placement, Hermite resampling, fades, pan, biquad)
src/core/slicing/slices.ts     slice operations, boundary suggestions, auto-chop, category suggestions
src/core/compose/*             composition engine (see §5)
src/core/midi/midi.ts          MIDI import, trigger/melodic export, mapping files
src/core/project/project.ts    project format, save/load, missing-file handling, portable bundles
src/core/project/exporters.ts  WAV / stems / slices / MIDI packages
src/core/demo/*                synthetic vocal-like recordings + the six example projects
src/app/store/store.ts         project state, history (undo/redo), domain actions
src/app/audio/engine.ts        Web Audio playback (lookahead scheduler) and slice audition
src/app/platform/platform.ts   Electron (folders on disk) vs. browser (IndexedDB + downloads) adapters
src/app/services/*             project + composition services used by the UI
src/app/components, views      React UI
electron/main.ts, preload.ts   window, native dialogs, file I/O (contextIsolation, whitelisted IPC)
```

* **Non-destructive model.** A `Slice` is `{sourceId, start, end}` in source frames plus metadata. A `SeqEvent` is `{sliceId, trackId, tick, length (gate), offset, gain dB, semitones, reverse, fadeIn, fadeOut, pan, velocity, locked, role, motifId, gesture}`. Imported audio is copied into the project and never modified.
* **Timing.** Positions are integer ticks (960 PPQ). Each event's start frame is computed absolutely (`round(tick·60·sr / (bpm·960))`), so there is no accumulated drift.
* **Playback = export.** `buildPlan()` resolves every event (slice bounds, offset, gate, playback rate, reverse, gain×layer gain, pan, protective fades). The live engine schedules exactly that plan with `AudioBufferSourceNode`s on the audio clock (25 ms lookahead pump, partial starts when playing from the middle of an event, loop cycles, per-layer filter buses, click-free stop). The offline renderer mixes the same plan in JS. Fades are linear in both; panning uses the StereoPannerNode equations in both.
* **Project format.** A project is a folder `Name.vcs/` containing `project.json` (all state, no audio) and `audio/` (managed copies). Paths are relative, so folders can be moved/shared. *Project ▸ Export portable bundle* writes the same thing as a single `.vcsz` zip. Missing audio is detected on load: the source is flagged, its slices/events are kept, rendering skips it and *Relink…* restores it.

## 3. Slicing capabilities

* Waveform with time ruler, beat grid (when the source has a BPM), wheel zoom, horizontal scroll, region selection, cursor, playback of source/selection/slice with a moving audition cursor.
* Four coexisting lanes: **phrase, word, syllable, sound**. Chopping a word into syllables keeps the word (`parentId` links children).
* Create from selection, markers (double-click / `M`, draggable), *Slice at markers*, split at cursor, merge, sub-slice by onsets or into N equal parts, duplicate references, rename, delete, favourite, drag boundaries (constrained by parent and neighbours), full undo/redo.
* **Boundary suggestions** (always editable markers): fixed interval, beat grid (BPM × division), rhythmic pattern (e.g. `0.75 0.75 0.5` beats), silence/low-energy regions, amplitude onsets, finer transients. *Auto-chop* proposes phrase/word/syllable slices at once.
* **Metadata:** name, level, category (word, syllable, sustained/short vowel, consonant, breath, whisper, ad-lib, hum, sung note, spoken, percussive, other), tags, favourite, manual root note, role tendency, notes. Measured (approximate) features: duration, pitch + confidence, attack, sustain, noisiness, intensity. Categories are *suggested* from these features; nothing has to be labelled.
* The **Library** filters and sorts by these properties, auditions on click, builds collections and reusable phrases.

## 4. Composition modes

All modes share one material-casting step, one form planner, one motif system and the same role writers; they differ in the decisions they make.

1. **Melodic Chop Composer** – builds a central motif (rhythm cells, contour such as arch/descend/pendulum, hook slice on strong beats, a phrase-ending slice, often a deliberate gap before the last word), then develops it through the form. Melody is realised either by playback-rate transposition to a key/scale or — with *Transpose* off — by choosing slices whose natural pitches follow the contour.
2. **Rhythmic Vocal Composer** – a one-bar rhythmic identity from feel-specific cell grammars (bouncy, tight, syncopated, sparse, energetic, broken, experimental, hypnotic), accents on sharp-attack slices, retriggers, swing (UKG feel), a complementary rhythm layer that avoids the hook's onsets, structural accents, stutter-roll transitions, contrasting endings.
3. **Phrase Reconstruction** – finds the "words" of a phrase (word-level slices in source order), keeps their original timing (quantised, fitted to the phrase), then goes through original → reordered with the beginning preserved → anchor word repeated → words removed leaving gaps before the anchor → progressively fragmented → original returns. One anchor word (user-protected or the most recognisable) stays recognisable.
4. **Ghost Vocal Composer** – sparse hook stated only every other phrase, two atmosphere layers with delayed entrances, slow slice rotation, overlaps, long fades, pitched-down sustains, reverse swells landing on downbeats, breaths at phrase ends. Space is never filled.
5. **Microchop & Stutter** – a fixed per-piece vocabulary of chop cells (single, 2/3/4-fold stutters, accelerating retriggers, reverse blips, scrubbing through a long slice, gaps) mapped onto an underlying euclidean pattern; sections change subdivision (1/32 → sixteenth-triplets → shortening repetitions → sound/silence alternation).
6. **MIDI-Guided Composer** – standard MIDI files (type 0/1) trigger slices on note-on timing. Mappings: *rhythm cycle* (a stable A A B A slice pattern per bar), *one slice on every note* (with optional playback-rate pitch relative to a root note), *pitch map* (each MIDI pitch → a chosen slice). Velocity → gain/accent, durations → gates. Timing-only works without pitch.
7. **Vocal Conversation** – two voices (slices from two sources) in one of eight relationships: call-and-response, alternating phrases, interruption (B truncates A), imitation (B copies A's rhythm a bar later), gradually increasing overlap, complementary hocket rhythms, ostinato underneath, increasingly fragmented turns.

**Directions** (ethereal, playful electronic, emotional repetition, ambient texture, hyperactive glitch, sparse experimental, dance riff) are sets of tendencies — density, subdivision stride, swing, gap/sustain/stutter/reverse/overlap/call-response tendencies, register, fade style, accent contrast, build-up, preferred contours — read by every writer. **Roles** (lead, rhythm, response, atmosphere, accent, transition) are separate writers with different density, timing, gain, pan, fade and slice preferences; the *Layers* checkboxes choose which roles are written.

## 5. Procedural generation

* **Seeded and reproducible.** Every decision area (cast, motif, form, lead, rhythm, atmosphere, transition, …) draws from its own named random stream derived from the seed, so identical settings + seed produce identical events (including ids) and changing one area does not shift the others.
* **Material casting** scores every slice for hook / percussive / pad / ending / breath / accent jobs from category, role tendency, favourite status, duration vs. the *Recognisability/Fragmentation* targets, attack, sustain, noisiness and pitch.
* **Form planning** turns `bars ÷ phrase bars` into sections such as `A(state) → A'(vary) → B(contrast) → A''(return)` or, for 8 phrases, adds break / fragment / build sections. Controls change the plan (high fragmentation turns contrast into fragmentation, high space into breakdowns, high repetition into returns).
* **Motif development operations:** repeat, vary ending, replace one slice, shift one note, insert rest, fragment (repeat the opening cell), shorten, extend, displace by an eighth, reverse some, densify into a stutter roll, simplify to strong beats, transpose by scale steps, answer (imitating or complementary). The last repetition in a phrase usually gets a changed final gesture.
* **Motif protection:** an *important* motif is honoured according to its level — **preserve** (note-for-note identical everywhere it appears), **develop** (its first two notes — the head — are never altered), **transform** (substantially changed once, then developed), **replace** (a new motif). *Make motif* turns any selected events into a protected motif.
* **Transitions** between sections: stutter rolls (optionally rising), reverse swells, breaths, or a deliberate drop-out that cuts the lead before the downbeat.
* Every generation returns a plain-language explanation (form, motif, per-section decisions) shown under *Why?* in the Idea Lab.

## 6. Exploration

* **Candidates:** *Generate 6 ideas* composes each candidate with a different bias (melodic, rhythmic, hypnotic, spacious, fragmented, surprising — changing controls, feel and layer set, not just the seed). Candidates that come out too similar (event-signature Jaccard ≥ 0.7) are recomposed with another seed. Labels are then assigned by an optimal matching against measured metrics (pitch spread, syncopation/density, bar repetition, silence, fragmentation, surprise), so "Most spacious" is measured, not assumed.
* **Compare:** audition any idea from the current position, mark A and B, and switch *A ⇄ B* seamlessly while playing; return to the arrangement at any time.
* **Keep / discard / apply / undo:** ★ keeps an idea (kept ideas survive pruning and saving), ✕ discards, *Apply* replaces the arrangement (undoable), *Bars* takes only the selected bars from an idea, *+Layers* adds the idea's layers on top — a practical way to combine pieces of different candidates.
* **Variations** of a favourite or of the current arrangement: close variation (motif preserved), developed further, same rhythm with new slices, new ending (only the last phrase regenerated), denser.
* **Locks respected by every regeneration:** individual events, bars (🔒 in the ruler), whole layers, a layer's **rhythm** (R in the layer header: onsets, gates and dynamics are kept, only slices/pitches are re-chosen), protected silences (*Lock silence* on selected bars, per layer or all layers — generators never place notes there and shorten notes that would ring into it), and the important motif. *↻ Bars* regenerates only the selected bars (optionally only the selected layer); *↻ layer* regenerates one layer.

## 6b. Beat Fit – curating ideas to your song

Drop a `.mid` from your beat (a chord progression or an arp; drum tracks on channel 10 are ignored) onto the window or the drop zone. Everything else in the app works exactly as before; the beat simply adds awareness of your song.

**What is read from the MIDI** (`src/core/beat/analyze.ts`):

* **Key & scale.** Duration- and velocity-weighted pitch-class profile (bass notes count extra) correlated with Krumhansl–Kessler major/minor profiles. On top of that, keys whose scale leaves out notes that are clearly played are penalised, and the first chord counts as a strong tonal cue (loops usually start on the tonic, so Am–F–C–G is read as A minor, not C major). Minor keys are refined to dorian, phrygian or harmonic minor when the raised 6th, flat 2nd or raised 7th is clearly present. You get a confidence value and alternatives, and you can override the key with one click.
* **Chords.** Per-beat windows (per half-bar for arps and lines, which spread a chord over time) are matched against major, minor, diminished, augmented, sus2, sus4, 7, maj7 and m7 templates with a bass-note bonus. Repeats are merged, passing chords folded in, and chord names are spelled with flats in flat keys.
* **Rhythm & space.** For each sixteenth of the bar: how often the beat starts a note there and how often something is sounding. Also onsets per beat, syncopation (off-beats with an empty preceding beat), sustain (pads ↔ plucks), texture (block chords / arp / line / mixed), register, density per bar and harmonic rhythm.

**What changes when composing with a beat** (`src/core/beat/fit.ts`, used by the shared engine, so every mode benefits):

* The beat's key and scale replace the panel key. Melodic targets are always in key.
* **Harmonise (on by default).** Pitched vocal notes on the beat, accented or long are nudged (by at most 3 semitones, or 5 for atmosphere) to a tone of the chord sounding underneath. Other notes are kept in the scale. This is playback-rate transposition like everything else. An important motif set to *preserve* is never altered.
* **Rhythm fit.** *Leave room* (default): motif notes that land on the beat's busiest sixteenths are moved to a free neighbour or dropped (except the downbeat), and the rhythm layer avoids busy steps, so the chops answer the beat. *Follow*: chops are pulled onto the steps where the beat plays. *Off*: the beat's rhythm is ignored.
* Ghost and atmosphere layers enter on chord changes, and reverse swells land on them.
* In MIDI-guided mode the vocal sings each MIDI note's pitch class from the slice's own pitch (nearest octave), so a vocal can double your arp.
* Arrangement length tiles the loop (8–16 bars). Phrase length follows the harmonic rhythm.

**Curated recipes** are chosen from tempo, density, sustain, texture and harmonic rhythm, and each explains why. Examples: *Hook in key, on the chords* (ethereal for slow / half-time beats, playful for fast ones); *Chops in the gaps* (more space when the beat is busy); *Ride the arp* (your arp MIDI triggers the vocal) or *Lock to the chord rhythm*; *Ghost layer under the progression*; plus *Glitch fills* for fast/busy beats and *Two voices answering each other* when you have two recordings. *✦ Generate 6 ideas* applies the recipe and fills the Idea Lab; *Set up only* just applies the settings.

**Your vocal vs this beat.** For pitched slices: how many sit in the beat's key, how many are a semitone away, and the global offset that would fit best. *Use in-key slices as material* restricts the generator to fitting slices (unpitched breaths and consonants are always allowed). The same set is available as the *Fits the beat's key* material option in Compose.

**Preview.** During playback a simple two-oscillator synth plays the beat MIDI, looped over the arrangement, at an adjustable level, so you can audition ideas against the chords. It is never included in exports: your DAW has the real beat.

The beat is saved inside the project (undoable; *Remove beat* returns to the normal workflow). Three demo beats are built in (Am–F–C–G pads, a Cm–Ab–Eb–Bb arp, Dm7–G7 off-beat stabs) and are also in `examples/media/beat-*.mid`.

## 7. Editing and playback

* Timeline: bars/beats ruler (click to seek, drag to select bars, per-bar locks, loop band), adjustable grid (1/4…1/32, triplets), snap (hold Ctrl for free placement), zoom + *Fit*.
* Events: click/Shift-click/Ctrl+A selection, drag to move (also across layers), drag the right edge to shorten the gate (up to the slice's natural length), Alt-drag to duplicate, Delete, Ctrl+C / Ctrl+V (at playhead) / Ctrl+D, `R` reverse, `L` lock, ↑↓ transpose (Shift = octave), ←→ nudge. The inspector edits slice, gain, playback-rate transposition, pan, fades, gate, start offset (microchops), velocity, reverse, lock — for one or many events.
* Layers: add any role, rename, change role, mute, solo, lock, rhythm-lock, layer gain/pan, low/high-pass filter, regenerate, delete.
* `?` in the top bar lists every shortcut and gesture.
* Transport: play/stop (Space), stop & rewind (Esc), loop (whole arrangement or selected bars), tempo, time signature (4/4, 3/4, 6/8, 5/4, 7/8), length. Undo/redo (Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y) covers slicing, arrangement edits, applying ideas and regenerations; generator preferences and the candidate list are intentionally not rolled back. Slice-boundary drags and event drags are single undo steps.

## 8. Export

| Export | Details |
|---|---|
| Mix | Stereo WAV, 44.1 / 48 / 88.2 / 96 kHz, 16 / 24-bit PCM or 32-bit float; mute/solo respected. |
| Selected bars | Only the bars selected in the ruler. |
| Loop-ready | Tail beyond the loop end is folded back onto the start so the file loops seamlessly. |
| Stems | One WAV per layer, identical length from bar 1, sharing one gain so they sum exactly to the mix. |
| Single layer | Any layer on its own. |
| Slices | Used slices, favourites, all, a collection, or a library selection — each as its own WAV with the click-guard fade. |
| MIDI triggers | `.mid` with one note per slice (C1 upward) and one track per layer, velocities from accents, plus `slices/*.wav`, `mapping.txt` and `mapping.json`. |
| MIDI melodic | One MIDI track per slice with note = 60 + transposition; load each slice into a sampler rooted at C3. |
| Project bundle | `.vcsz` portable single-file project. |

Level handling: *prevent clipping* (scale down only if needed), *normalise to −1 dBFS*, or untouched. Tails: keep, cut or wrap. A configurable protective fade (default 3 ms) is applied at every event boundary in playback and export. File names include project, tempo, range and format. In the desktop app exports go to a folder you choose; in the browser build multiple files are zipped.
**DAW compatibility:** standard RIFF/WAVE files and type-1 SMF files; MIDI alone cannot reproduce the composition (reverse, offsets and fades are audio-only) — use the slice WAVs + mapping.

## 9. Tests

Commands run for this delivery (all passing):

| Command | What it covers | Result |
|---|---|---|
| `npm run typecheck` | TypeScript (strict) over app, core, Electron, tests | ✔ no errors |
| `npm test` | 149 Vitest unit/integration tests: WAV codec (16/24/32-bit, mono/stereo, 22.05–96 kHz, invalid/truncated/unsupported files), renderer (sample-accurate placement, slice bounds, offsets, reverse, gates, playback rate, gain, fades & click-free boundaries, overlaps/repeats, very short slices, stereo/pan, sample-rate conversion, exact durations, clip prevention/normalisation, mute/solo/stems, loop wrap, missing sources, filters), analysis & slicing, every composition mode, determinism & seeds, mode/direction differences, locks (events, bars, layers, rhythm, silences), bar/layer regeneration, motif preserve/develop/replace, MIDI alignment & mappings, all eight conversation relations, candidates (distinctness, metric-based labels, reproducibility, variations), odd meters, single-slice material, project save/load/bundles/missing files/migration, exports (mix duration, stems sum to mix, slices, MIDI package), store undo/redo; Beat Fit: key detection on 7 progressions (incl. relative major/minor, dorian, ii–V–I), chord qualities & timeline, rhythm/space profile, rhythm fit (complement/follow/off), harmonisation to chord tones, beat-aware ghost/MIDI modes, determinism, recipes, vocal key fit, persistence | ✔ 149 / 149 |
| `npm run test:e2e` | 16 Playwright tests on the production renderer build in Chromium: Import → Slice → Generate → Audition → Export (WAV verified); Record (fake microphone) → Slice → Compose; Generate → A/B → Keep; Select bars → Regenerate (+ undo); Lock motif → Variations/ideas preserve it; Save → Reopen → Export stems; MIDI-guided + MIDI export; Conversation + timeline drag/keys + undo/redo; Library collections; MP3/FLAC import + invalid-file message; live scheduler timing vs. the event model incl. loop cycles (< 0.5 ms); playback from an arbitrary position joining events part-way; Beat Fit: drag-and-drop MIDI → analysis → recipe → beat-fitted ideas, “ride the arp”, key override, fit settings, preview synth scheduling on/off, save/reopen, audio drop, example G | ✔ 16 / 16 |
| `npm run test:electron` | Real Electron app under `xvfb-run`: example → save project folder → relaunch → reopen → export WAV to disk (decoded and checked) | ✔ 1 / 1 |

Also verified manually during development: the packaged Linux build (`npm run package`) starts, loads examples and lists its bundled example folders.

## 10. Example projects

`examples/` (regenerate with `npm run examples`) holds one project folder per workflow (A–G), each with a rendered `preview_*.wav`, plus `examples/media/` with the synthetic recordings (`sung-phrase`, `spoken-phrase`, `hum-whisper`, `voice-b` [stereo, 48 kHz], `chop-attacks`) `garage-riff.mid` and three demo beats (`beat-*.mid`):

* **A · Ethereal Vocal Hook** – sung phrase, six candidates, the melodic favourite applied, motif marked important.
* **B · Playful Electronic Chops** – syncopated riff with stutters; motif preserved while the final bar was regenerated.
* **C · Ambient Ghost Vocals** – 16 bars of sparse hums/breaths/whispers on separate layers (low-passed second layer) for stem export.
* **D · Vocal Phrase Reconstruction** – spoken phrase reordered/repeated/removed/fragmented around a protected anchor word.
* **E · Two-Voice Conversation** – call-and-response between the sung phrase and a second voice (switch the relationship and recompose).
* **F · MIDI-Guided Vocal Pattern** – sharp syllables triggered by a 2-step MIDI riff with velocity accents and rate-based pitch.
* **G · Fit to My Beat** – the Am–F–C–G demo beat loaded as beat context; six “Hook in key, on the chords” ideas harmonised to the progression.

The same examples are available inside the app (*Project ▸ Example projects* or the welcome screen); the desktop app also opens the on-disk folders. The demo voices are produced by a small formant synthesiser (`src/core/demo/synthVoice.ts`) — vocal-*like* material with vowels, consonant bursts, breaths and hums, not real singing or speech.

## 11. Instructions

Requirements: Node.js 20+ (developed with Node 22) and npm.

```bash
npm install            # installs dependencies (downloads the Electron binary)
npm run dev            # Vite dev server + Electron window with hot reload
npm run build          # renderer → dist/, main/preload → dist-electron/
npm start              # run the built desktop app (Linux as root: npx electron . --no-sandbox)
npm run dev:web        # renderer only, in a browser (projects stored in IndexedDB)

npm run typecheck && npm test           # unit tests
npm run test:e2e                         # UI tests (builds + serves the renderer)
npm run test:electron                    # desktop E2E (needs xvfb-run on headless Linux)
npm run examples                         # regenerate examples/

npm run package        # unpacked Linux app in release/linux-unpacked (uses the local Electron binary)
npm run package:linux  # AppImage   (electron-builder downloads what it needs)
npm run package:win    # NSIS installer (build on Windows or with wine)
npm run package:mac    # DMG (build on macOS)
```

If `npm install` cannot download Electron (e.g. behind a proxy), download `electron-v45.2.3-<platform>-<arch>.zip` from the Electron releases page, unzip it into `node_modules/electron/dist` and write the executable name into `node_modules/electron/path.txt`.

## 12. Limitations (honest list)

* **Pitch:** all transposition is playback-rate based — pitch and duration change together. There is no independent time-stretching, pitch-shifting or formant preservation. Key/scale targeting relies on *approximate* pitch estimates (YIN-style, monophonic, confidence-gated) or manual root notes; unpitched slices are transposed relative to their own pitch.
* **Segmentation:** silence, onset and transient suggestions are energy-based. There is no speech recognition or linguistic syllable detection — "word"/"syllable" levels are names for granularity, and suggestions should be checked by ear. Phrase Reconstruction uses slice order, not meaning.
* **Analysis-derived categories** are tendencies and can be wrong (e.g. a whispered word may be suggested as "breath"); user-set categories always win.
* **Formats:** WAV is decoded natively at its original sample rate (PCM 8/16/24/32-bit, float 32/64, mono to 8 channels; >2 channels are downmixed for playback/export). MP3, FLAC, OGG/Opus, AAC/M4A depend on Chromium's decoders and are resampled to the audio device rate when decoded. AIFF is not supported. Whole sources are held in memory, which is fine for vocal takes but not for hour-long files.
* **Live vs. export:** both use the same plan, fades and pan law; at non-unity playback rates Web Audio's resampler and the exporter's cubic interpolation can differ very slightly. Mute/solo/edits during playback take effect within the ~180 ms scheduling window.
* **MIDI import:** only the first tempo and time signature are read; tempo maps, pitch-bend and controllers are ignored; notes after the arrangement end are ignored (an empty arrangement adopts the MIDI tempo and length). MIDI export cannot represent reverse, offsets or fades.
* **Recording:** simple mono capture (ScriptProcessorNode, no monitoring, max 3 minutes) at the device sample rate.
* **UI:** no rubber-band (marquee) selection — use Shift-click and Ctrl+A. The candidate history keeps favourites plus the most recent ideas.
* **Beat Fit:** the analysis reads MIDI only (not audio). It assumes one key for the whole loop, so modulations and borrowed chords are averaged in. Chord detection uses the triad/7th templates listed above (no 9ths, 11ths or slash-chord names). Only the first tempo and time signature are used, and rhythm fit works on the sixteenth grid of one bar. Harmonisation needs slices with a detectable (or manually set) pitch, and the preview synth is a rough reference sound, not your beat's instruments.
* **Packaging:** the unpacked Linux build was produced and launched here; AppImage/Windows/macOS targets are configured but were not built or tested in this environment, and builds are unsigned with the default Electron icon.
* **Browser build:** intended for development and automated tests; real project folders on disk require the desktop app.
