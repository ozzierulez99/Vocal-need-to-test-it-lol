import { test, expect } from '@playwright/test';
import { fresh, importWav, state, downloadBytes, wavInfo, dragRulerBars } from './helpers';
import { unzipSync } from 'fflate';

test.describe('core workflows', () => {
  test('Import → Slice → Generate → Audition → Export', async ({ page }) => {
    await fresh(page);
    await importWav(page, 'sung-phrase');
    await expect(page.getByTestId('source-list').locator('.source-item')).toHaveCount(1);
    const auto = await state<number>(page, '(s) => s.doc.slices.length');
    expect(auto).toBeGreaterThan(5); // automatic phrase/word suggestions

    // manual slice: drag a region on the waveform and slice it at syllable level
    const wave = (await page.getByTestId('waveform').boundingBox())!;
    await page.mouse.move(wave.x + wave.width * 0.2, wave.y + 100);
    await page.mouse.down();
    await page.mouse.move(wave.x + wave.width * 0.3, wave.y + 100, { steps: 5 });
    await page.mouse.up();
    await page.getByTestId('new-level').selectOption('sound');
    await page.getByTestId('create-slice').click();
    expect(await state<number>(page, '(s) => s.doc.slices.filter(x => x.level === "sound" && !x.tags.includes("vowel")).length')).toBe(1);
    // rename + favourite the new slice
    await page.getByTestId('slice-name').fill('ah-chop');
    await page.getByTestId('slice-name').press('Enter');
    await page.getByTestId('slice-fav').click();
    expect(await state<string>(page, '(s) => s.doc.slices.find(x => x.level === "sound" && !x.tags.includes("vowel")).name')).toBe('ah-chop');

    // compose
    await page.getByTestId('go-compose').click();
    await page.getByTestId('mode-melodic').click();
    await page.getByTestId('generate-ideas').click();
    await expect(page.getByTestId('candidate')).toHaveCount(6);
    const labels = await page.locator('[data-testid=candidate] .card-title b').allTextContents();
    expect(new Set(labels).size).toBe(6);

    // audition a candidate: transport runs and the position advances
    await page.getByTestId('candidate').first().getByTestId('audition').click();
    await expect(page.getByTestId('auditioning')).toBeVisible();
    await page.waitForTimeout(900);
    expect(await state<number>(page, '(s) => s.positionTick')).toBeGreaterThan(200);
    expect(await page.evaluate(() => (window as any).__vcsEngine.isPlaying)).toBe(true);
    await page.getByTestId('play').click(); // stop
    expect(await page.evaluate(() => (window as any).__vcsEngine.isPlaying)).toBe(false);
    expect(await state<boolean>(page, '(s) => s.playing')).toBe(false);

    await page.getByTestId('candidate').first().getByTestId('apply').click();
    const n = await state<number>(page, '(s) => s.doc.sequence.events.length');
    expect(n).toBeGreaterThan(0);
    await expect(page.getByTestId('event')).toHaveCount(n);

    // export the mix
    await page.getByTestId('nav-export').click();
    await page.getByTestId('exp-bits').selectOption('16');
    const dl = page.waitForEvent('download');
    await page.getByTestId('export-mix').click();
    const info = wavInfo(await downloadBytes(await dl));
    const expected = await state<number>(page, '(s) => s.doc.sequence.bars * 4 * 60 / s.doc.sequence.bpm');
    expect(info.channels).toBe(2);
    expect(info.sampleRate).toBe(44100);
    expect(info.seconds).toBeGreaterThanOrEqual(expected - 0.01);
    expect(info.peak).toBeGreaterThan(0.01);
    expect(info.peak).toBeLessThanOrEqual(1);
    await expect(page.getByTestId('export-log')).toContainText('Mix');
  });

  test('Record → Slice → Compose', async ({ page }) => {
    await fresh(page);
    await page.getByTestId('open-recorder').click();
    await page.getByTestId('rec-start').click();
    await page.waitForTimeout(2200);
    await page.getByTestId('rec-stop').click();
    await expect(page.getByTestId('rec-keep')).toBeEnabled();
    await page.getByTestId('rec-name').fill('My hum');
    await page.getByTestId('rec-name').press('Enter');
    await page.getByTestId('rec-keep').click();
    const src = await state<any>(page, '(s) => s.doc.sources[0]');
    expect(src.kind).toBe('recording');
    expect(src.name).toBe('My hum');
    expect(src.frames / src.sampleRate).toBeGreaterThan(1.5);
    // ensure there is material: auto-chop result or a manual whole-source slice
    if ((await state<number>(page, '(s) => s.doc.slices.length')) === 0) {
      await page.getByTestId('suggest-method').selectOption('interval');
      await page.getByTestId('suggest').click();
      await page.getByTestId('slice-markers').click();
    }
    expect(await state<number>(page, '(s) => s.doc.slices.length')).toBeGreaterThan(0);
    await page.getByTestId('nav-compose').click();
    await page.getByTestId('mode-rhythmic').click();
    await page.getByTestId('compose-direct').click();
    expect(await state<number>(page, '(s) => s.doc.sequence.events.length')).toBeGreaterThan(0);
  });

  test('Generate → Compare A/B → Keep', async ({ page }) => {
    await fresh(page);
    await page.getByTestId('welcome-demo').click();
    await page.getByTestId('nav-compose').click();
    await page.getByTestId('generate-ideas').click();
    await expect(page.getByTestId('candidate')).toHaveCount(6);
    const [a, b] = await state<string[]>(page, '(s) => [s.ui.candidateA, s.ui.candidateB]');
    expect(a && b && a !== b).toBeTruthy();
    await page.getByTestId('candidate').first().getByTestId('audition').click();
    await page.waitForTimeout(300);
    await page.getByTestId('ab-swap').click();
    const first = await state<string>(page, '(s) => s.ui.auditioning');
    await page.getByTestId('ab-swap').click();
    const second = await state<string>(page, '(s) => s.ui.auditioning');
    expect([first, second].sort()).toEqual([a, b].sort());
    expect(await page.evaluate(() => (window as any).__vcsEngine.isPlaying)).toBe(true);
    await page.keyboard.press('Escape');
    // keep one
    await page.getByTestId('candidate').nth(2).getByTestId('keep').click();
    await page.getByText('Show kept only').click();
    await expect(page.getByTestId('candidate')).toHaveCount(1);
    expect(await state<number>(page, '(s) => s.doc.candidates.filter(c => c.favourite).length')).toBe(1);
  });

  test('Select bar → Regenerate keeps everything else', async ({ page }) => {
    await fresh(page);
    await page.getByTestId('welcome-example-playful-chops').click();
    await expect(page.getByTestId('event').first()).toBeVisible();
    await page.getByTestId('zoom-fit').click();
    const before = await state<any[]>(page, '(s) => s.doc.sequence.events.map(e => ({ ...e }))');
    await dragRulerBars(page, 6, 8); // bars 7–8 → selection [6, 8)
    const sel = await state<number[]>(page, '(s) => s.ui.bars');
    expect(sel).toEqual([6, 8]);
    await page.getByTestId('regen-bars').click();
    const after = await state<any[]>(page, '(s) => s.doc.sequence.events');
    const early = (es: any[]) => es.filter((e) => e.tick < 6 * 3840).map((e) => JSON.stringify(e)).sort();
    expect(early(after)).toEqual(early(before));
    const late = (es: any[]) => es.filter((e) => e.tick >= 6 * 3840).map((e) => `${e.tick}:${e.sliceId}`).sort().join();
    expect(late(after)).not.toBe(late(before));
    // undo restores the previous arrangement
    await page.getByTestId('undo').click();
    expect((await state<any[]>(page, '(s) => s.doc.sequence.events')).length).toBe(before.length);
  });

  test('Lock motif → Generate variation preserves it', async ({ page }) => {
    await fresh(page);
    await page.getByTestId('welcome-example-playful-chops').click();
    await expect(page.getByTestId('motif')).toHaveCount(1);
    await expect(page.getByTestId('motif-important')).toBeChecked();
    await page.getByTestId('motif-protection').selectOption('preserve');
    const sig = await state<string>(page, '(s) => s.doc.sequence.motifs[0].notes.map(n => n.tick + ":" + n.sliceId + ":" + n.semitones).join("|")');
    await page.getByTestId('variations-current').click();
    await expect(page.getByTestId('candidate')).toHaveCount(5);
    const sigs = await state<string[]>(page, '(s) => s.doc.candidates.filter(c => c.label !== "Same rhythm, new slices").map(c => c.motifs[0].notes.map(n => n.tick + ":" + n.sliceId + ":" + n.semitones).join("|"))');
    for (const x of sigs) expect(x).toBe(sig);
    // a generated idea also keeps the important motif in its opening bar
    await page.getByTestId('generate-ideas').click();
    const opening = await state<string[]>(page, `(s) => s.doc.candidates.slice(-6).map(c => { const lead = c.tracks.find(t => t.role === 'lead'); return c.events.filter(e => e.trackId === lead.id && e.tick < s.doc.sequence.motifs[0].span).sort((a,b)=>a.tick-b.tick).map(e => e.tick + ":" + e.sliceId + ":" + e.semitones).join("|") })`);
    for (const o of opening) expect(o).toBe(sig);
  });

  test('Save → Reopen → Export stems', async ({ page }) => {
    await fresh(page);
    await page.getByTestId('welcome-example-ambient-ghost').click();
    await expect(page.getByTestId('event').first()).toBeVisible();
    // edit something, then save
    await page.getByTestId('project-name').fill('Ghost test');
    await page.keyboard.press('Control+s');
    await expect(page.getByTestId('toasts')).toContainText('Saved');
    const snapshot = await state<any>(page, '(s) => ({ e: s.doc.sequence.events, t: s.doc.sequence.tracks, sl: s.doc.slices.length })');
    // new project, then reopen from the browser project store
    page.once('dialog', (d) => d.accept());
    await page.getByTestId('project-menu').click();
    await page.getByTestId('menu-new').click();
    expect(await state<number>(page, '(s) => s.doc.sources.length')).toBe(0);
    await page.getByTestId('project-menu').click();
    await page.getByTestId('menu-open').click();
    await page.getByTestId('open-Ghost test').click();
    await expect(page.getByTestId('toasts')).toContainText('Opened');
    expect(await state<any>(page, '(s) => ({ e: s.doc.sequence.events, t: s.doc.sequence.tracks, sl: s.doc.slices.length })')).toEqual(snapshot);
    expect(await state<number>(page, '(s) => s.rt.audio.size')).toBe(1);
    // export stems (zip download)
    await page.getByTestId('nav-export').click();
    const dl = page.waitForEvent('download');
    await page.getByTestId('export-stems').click();
    const zip = unzipSync(new Uint8Array(await downloadBytes(await dl)));
    const names = Object.keys(zip);
    const used = await state<number>(page, '(s) => s.doc.sequence.tracks.filter(t => s.doc.sequence.events.some(e => e.trackId === t.id)).length');
    expect(names.length).toBe(used);
    expect(names.every((n) => n.endsWith('.wav'))).toBe(true);
  });

  test('MIDI-guided pattern and MIDI trigger export', async ({ page }) => {
    await fresh(page);
    await page.getByTestId('welcome-demo').click();
    await page.getByTestId('nav-compose').click();
    await page.getByTestId('mode-midi').click();
    await page.getByTestId('demo-midi').click();
    await page.getByTestId('midi-mapping').selectOption('single');
    await page.getByTestId('midi-pitch').check();
    await page.getByTestId('compose-direct').click();
    const ticks = await state<number[]>(page, '(s) => s.doc.sequence.events.map(e => e.tick)');
    const guideTicks = await state<number[]>(page, '(s) => s.doc.sequence.settings.midi.notes.filter(n => n.tick < s.doc.sequence.bars * 3840).map(n => n.tick)');
    expect(ticks).toEqual(guideTicks);
    expect(new Set(await state<string[]>(page, '(s) => s.doc.sequence.events.map(e => e.sliceId)')).size).toBe(1);
    await page.getByTestId('nav-export').click();
    const dl = page.waitForEvent('download');
    await page.getByTestId('export-midi-trigger').click();
    const zip = unzipSync(new Uint8Array(await downloadBytes(await dl)));
    expect(Object.keys(zip).some((n) => n.endsWith('.mid'))).toBe(true);
    expect(Object.keys(zip).some((n) => n.endsWith('_mapping.txt'))).toBe(true);
    expect(Object.keys(zip).some((n) => n.startsWith('slices/'))).toBe(true);
  });

  test('Conversation mode, timeline editing and undo/redo', async ({ page }) => {
    await fresh(page);
    await page.getByTestId('welcome-example-two-voice-conversation').click();
    await page.getByTestId('relation').selectOption('imitate');
    await page.getByTestId('compose-direct').click();
    const tracks = await state<string[]>(page, '(s) => s.doc.sequence.tracks.map(t => t.name)');
    expect(tracks).toContain('Voice A');
    expect(tracks).toContain('Voice B');
    const total = await state<number>(page, '(s) => s.doc.sequence.events.length');
    // select an event, delete it, undo, redo
    await page.getByTestId('zoom-fit').click();
    await page.getByTestId('event').first().click();
    await page.keyboard.press('Delete');
    expect(await state<number>(page, '(s) => s.doc.sequence.events.length')).toBe(total - 1);
    await page.keyboard.press('Control+z');
    expect(await state<number>(page, '(s) => s.doc.sequence.events.length')).toBe(total);
    await page.keyboard.press('Control+Shift+z');
    expect(await state<number>(page, '(s) => s.doc.sequence.events.length')).toBe(total - 1);
    // drag an event one beat to the right
    const ev = page.getByTestId('event').first();
    const id = await ev.getAttribute('data-event-id');
    const t0 = await state<number>(page, `(s) => s.doc.sequence.events.find(e => e.id === '${id}').tick`);
    const box = (await ev.boundingBox())!;
    const ppb = await state<number>(page, '(s) => s.ui.pxPerBeat');
    await page.mouse.move(box.x + 3, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 3 + ppb, box.y + 20, { steps: 5 });
    await page.mouse.up();
    expect(await state<number>(page, `(s) => s.doc.sequence.events.find(e => e.id === '${id}').tick`)).toBe(t0 + 960);
    // lock it and reverse it via keyboard
    await page.keyboard.press('r');
    await page.keyboard.press('l');
    expect(await state<any>(page, `(s) => { const e = s.doc.sequence.events.find(e => e.id === '${id}'); return [e.reverse, e.locked]; }`)).toEqual([true, true]);
  });

  test('Library: filter, collections, compose with selection', async ({ page }) => {
    await fresh(page);
    await page.getByTestId('welcome-demo').click();
    await page.getByTestId('nav-library').click();
    const all = await page.getByTestId('slice-card').count();
    expect(all).toBeGreaterThan(3);
    await page.getByTestId('slice-card').nth(1).click();
    await page.getByTestId('slice-card').nth(2).click({ modifiers: ['Shift'] });
    await page.getByTestId('collection-name').fill('Vowels');
    await page.getByTestId('collection-name').press('Enter');
    await page.getByTestId('create-collection').click();
    await expect(page.getByTestId('collection')).toHaveCount(1);
    await page.getByTestId('compose-selection').click();
    expect(await state<number>(page, '(s) => s.doc.sequence.settings.sliceIds.length')).toBe(2);
    await page.getByTestId('compose-direct').click();
    const used = await state<string[]>(page, '(s) => Array.from(new Set(s.doc.sequence.events.map(e => e.sliceId)))');
    const allowed = await state<string[]>(page, '(s) => s.doc.sequence.settings.sliceIds');
    expect(used.every((u) => allowed.includes(u))).toBe(true);
  });
});

test('imports MP3 and FLAC, explains invalid files', async ({ page }) => {
  await fresh(page);
  const fx = (n: string) => `e2e/fixtures/${n}`;
  for (const f of ['chops.mp3', 'spoken.flac', 'broken.wav']) {
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('import-audio').first().click();
    await (await chooser).setFiles(fx(f));
    await page.waitForTimeout(400);
  }
  await expect.poll(() => state<number>(page, '(s) => s.doc.sources.length')).toBe(2);
  const srcs = await state<any[]>(page, '(s) => s.doc.sources.map(x => ({ name: x.name, ch: x.channelCount, sec: x.frames / x.sampleRate }))');
  expect(srcs.map((s) => s.name)).toEqual(['chops', 'spoken']);
  expect(srcs[0].ch).toBe(2);
  expect(srcs[0].sec).toBeGreaterThan(2.4);
  expect(srcs[1].sec).toBeGreaterThan(3);
  await expect(page.getByTestId('toasts')).toContainText('Could not import “broken.wav”');
  expect(await state<number>(page, '(s) => s.doc.slices.length')).toBeGreaterThan(4);
});

test('live scheduler timing matches the event model (incl. loop cycles)', async ({ page }) => {
  await fresh(page);
  await page.getByTestId('welcome-example-midi-guided').click();
  await expect(page.getByTestId('event').first()).toBeVisible();
  // loop the first bar so several cycles get scheduled quickly
  await page.evaluate(() => {
    const s = (window as any).__vcs.useStore.getState();
    // grid-exact placement for this check: no onset pre-roll, no swing / humanise (those are covered by unit tests)
    s.commit('loop', (d: any) => {
      d.sequence.loop = { enabled: true, startTick: 0, endTick: 3840 };
      d.sequence.groove = undefined;
      d.sequence.tracks.forEach((t: any) => (t.choke = false));
      d.sequence.events.forEach((e: any) => (e.align = false));
    });
    (window as any).__vcsEngine.debugSchedule = [];
  });
  await page.getByTestId('play').click();
  await page.waitForTimeout(4200); // > 2 cycles of a 132 BPM bar (1.82 s)
  await page.getByTestId('play').click();
  const r = await page.evaluate(() => {
    const st = (window as any).__vcs.useStore.getState();
    const seq = st.doc.sequence;
    const log = (window as any).__vcsEngine.debugSchedule;
    return { log, bpm: seq.bpm, events: seq.events.filter((e: any) => e.tick < 3840).map((e: any) => ({ id: e.id, tick: e.tick })) };
  });
  const barSec = (4 * 60) / r.bpm;
  const sec = (tick: number) => (tick * 60) / (r.bpm * 960);
  expect(r.log.length).toBeGreaterThanOrEqual(r.events.length * 2);
  for (const entry of r.log) {
    const ev = r.events.find((e: any) => e.id === entry.eventId);
    expect(ev).toBeTruthy();
    const cycle = Math.round((entry.at - sec(ev.tick)) / barSec);
    expect(Math.abs(entry.at - (sec(ev.tick) + cycle * barSec))).toBeLessThan(0.0005);
  }
  // every event of the bar was scheduled in cycle 0 and cycle 1, exactly once each
  for (const ev of r.events) {
    const times = r.log.filter((x: any) => x.eventId === ev.id).map((x: any) => Math.round((x.at - sec(ev.tick)) / barSec) + 0);
    expect(times.slice(0, 2)).toEqual([0, 1]);
    expect(new Set(times).size).toBe(times.length);
  }
  expect(await page.evaluate(() => (window as any).__vcsEngine.isPlaying)).toBe(false);
});

test('playback from an arbitrary position joins sounding events part-way', async ({ page }) => {
  await fresh(page);
  await page.getByTestId('welcome-example-ambient-ghost').click();
  await expect(page.getByTestId('event').first()).toBeVisible();
  const target = await page.evaluate(() => {
    const s = (window as any).__vcs.useStore.getState();
    const e = s.doc.sequence.events.find((x: any) => x.length > 1500 && !x.reverse);
    s.commit('no loop', (d: any) => {
      d.sequence.loop.enabled = false;
      d.sequence.groove = undefined;
      d.sequence.events.forEach((x: any) => (x.align = false));
    });
    (window as any).__vcs.useStore.setState({ positionTick: e.tick + 480 });
    (window as any).__vcsEngine.debugSchedule = [];
    return { id: e.id, tick: e.tick };
  });
  await page.getByTestId('play').click();
  await page.waitForTimeout(500);
  const pos = await state<number>(page, '(s) => s.positionTick');
  expect(pos).toBeGreaterThan(target.tick + 480);
  await page.getByTestId('play').click();
  const entry = await page.evaluate((id) => (window as any).__vcsEngine.debugSchedule.find((x: any) => x.eventId === id), target.id);
  expect(entry).toBeTruthy();
  expect(Math.abs(entry.at)).toBeLessThan(0.001); // starts immediately…
  const bpm = await state<number>(page, '(s) => s.doc.sequence.bpm');
  const skipped = (480 * 60) / (bpm * 960);
  const sliceStart = await page.evaluate((id) => {
    const s = (window as any).__vcs.useStore.getState();
    const ev = s.doc.sequence.events.find((x: any) => x.id === id);
    const sl = s.doc.slices.find((x: any) => x.id === ev.sliceId);
    const src = s.doc.sources.find((x: any) => x.id === sl.sourceId);
    return (sl.start + ev.offset) / src.sampleRate;
  }, target.id);
  // …from the right point inside the slice (skip × playback rate)
  expect(Math.abs(entry.offset - (sliceStart + skipped * entry.rate))).toBeLessThan(0.002);
});
