import { test, expect } from '@playwright/test';
import { fresh, state, importWav, demoWav, downloadBytes, wavInfo } from './helpers';
import { demoBeatMidi, fullBeatParts } from '../src/core/demo/beats';
import { buildMidiFile } from '../src/core/midi/midi';

async function dropFiles(page: any, files: { name: string; bytes: Uint8Array; mime?: string }[], selector?: string) {
  await page.evaluate(
    ({ files, selector }: { files: { name: string; data: number[]; mime: string }[]; selector?: string }) => {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(new File([new Uint8Array(f.data)], f.name, { type: f.mime }));
      const target: EventTarget = selector ? document.querySelector(selector)! : window;
      target.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
      target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    { files: files.map((f) => ({ name: f.name, data: Array.from(f.bytes), mime: f.mime ?? 'audio/midi' })), selector },
  );
}

test.describe('v1.1', () => {
  test('instant ideas: scored, style-spanning ideas; purpose and time feel are generator settings', async ({ page }) => {
    await fresh(page);
    await importWav(page, 'sung-phrase');
    await page.getByTestId('go-compose').click();
    await page.getByTestId('purpose').selectOption('build');
    await page.getByTestId('time-feel').selectOption('half');
    expect(await state<any>(page, '(s) => [s.doc.sequence.settings.purpose, s.doc.sequence.settings.timeFeel]')).toEqual(['build', 'half']);
    await page.getByTestId('direction').selectOption('drain');
    await page.getByTestId('instant-ideas').click();
    await expect(page.getByTestId('candidate')).toHaveCount(6);
    await expect(page.getByTestId('score').first()).toBeVisible();
    const cands = await state<any[]>(page, '(s) => s.doc.candidates.map(c => ({ label: c.label, score: c.score.total, dir: c.settings.direction, groove: !!c.groove }))');
    expect(new Set(cands.map((c) => c.dir)).size).toBeGreaterThanOrEqual(3);
    for (const c of cands) {
      expect(c.score).toBeGreaterThan(40);
      expect(c.groove).toBe(true);
    }
    // applying an idea brings its groove along; the swing slider edits it non-destructively
    await page.getByTestId('candidate').first().getByTestId('apply').click();
    const before = await state<string>(page, '(s) => JSON.stringify(s.doc.sequence.events.map(e => e.tick))');
    await page.getByTestId('groove-swing').fill('0.4');
    expect(await state<number>(page, '(s) => s.doc.sequence.groove.swing')).toBeCloseTo(0.4, 5);
    expect(await state<string>(page, '(s) => JSON.stringify(s.doc.sequence.events.map(e => e.tick))')).toBe(before);
    // save an idea as a WAV without applying it
    const dl = page.waitForEvent('download');
    await page.getByTestId('candidate').nth(1).getByTestId('idea-wav').click();
    expect(wavInfo(await downloadBytes(await dl)).peak).toBeGreaterThan(0.01);
  });

  test('multi-part beat: roles, drums, half-time, add part, backing audio', async ({ page }) => {
    await fresh(page);
    await importWav(page, 'sung-phrase');
    await dropFiles(page, [{ name: 'full beat.mid', bytes: demoBeatMidi('full-beat') }]);
    await expect(page.getByTestId('beat-part')).toHaveCount(4);
    await expect(page.getByTestId('beat-drums')).toBeVisible();
    await expect(page.getByTestId('beat-description')).toContainText('half-time');
    expect(await state<string[]>(page, '(s) => s.doc.beat.parts.map(p => p.role).sort()')).toEqual(['bass', 'chords', 'drums', 'lead']);
    // change a role → re-analysed
    await page.getByTestId('beat-part').nth(2).getByTestId('part-role').selectOption('arp');
    expect(await state<string[]>(page, '(s) => s.doc.beat.parts.map(p => p.role).sort()')).toEqual(['arp', 'bass', 'chords', 'drums']);
    await page.getByTestId('undo').click();
    // add another part by dropping on the "add part" zone
    const extra = fullBeatParts()[1].notes.map((n) => ({ ...n, pitch: n.pitch + 12 }));
    await dropFiles(page, [{ name: 'sub.mid', bytes: buildMidiFile(extra, 140, 'sub') }], '[data-drop=add-part]');
    await expect(page.getByTestId('beat-part')).toHaveCount(5);
    expect(await state<string>(page, '(s) => s.doc.beat.key.root + s.doc.beat.key.scale')).toBe('9minor');
    // backing audio dropped on its zone becomes the reference track, not a vocal source
    const nSources = await state<number>(page, '(s) => s.doc.sources.length');
    const wav = demoWav('hum-whisper');
    await dropFiles(page, [{ name: 'beat bounce.wav', bytes: new Uint8Array(wav.buffer), mime: 'audio/wav' }], '[data-drop=backing]');
    await expect(page.getByTestId('backing')).toBeVisible();
    expect(await state<number>(page, '(s) => s.doc.sources.length')).toBe(nSources);
    expect(await state<string>(page, '(s) => s.doc.backing.name')).toBe('beat bounce');
    // it plays under the arrangement (and the synth preview steps aside)
    await page.evaluate(() => {
      (window as any).__vcsEngine.debugBacking = [];
      (window as any).__vcsEngine.debugSynth = [];
    });
    await page.getByTestId('beat-play').click();
    await page.waitForTimeout(700);
    await page.getByTestId('beat-play').click();
    expect(await page.evaluate(() => (window as any).__vcsEngine.debugBacking.length)).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as any).__vcsEngine.debugSynth.length)).toBe(0);
    // instant ideas use the beat
    await page.getByTestId('beat-instant').click();
    await expect(page.getByTestId('candidate')).toHaveCount(6);
    const desc = await state<string[][]>(page, '(s) => s.doc.candidates.map(c => c.description)');
    for (const d of desc) expect(d.some((x) => x.includes('Fitted to beat'))).toBe(true);
  });

  test('keyboard sampler plays the chop and records into the timeline', async ({ page }) => {
    await fresh(page);
    await importWav(page, 'sung-phrase');
    await page.getByTestId('go-compose').click();
    await page.getByTestId('compose-direct').click();
    const n0 = await state<number>(page, '(s) => s.doc.sequence.events.length');
    await page.getByTestId('keys-toggle').click();
    await expect(page.getByTestId('keys-strip')).toBeVisible();
    // not recording: keys only audition
    await page.keyboard.press('a');
    expect(await state<number>(page, '(s) => s.doc.sequence.events.length')).toBe(n0);
    await page.getByTestId('keys-rec').click();
    await page.getByTestId('play').click();
    await page.waitForTimeout(300);
    await page.keyboard.down('g');
    await page.waitForTimeout(250);
    await page.keyboard.up('g');
    await page.getByTestId('play').click();
    const played = await state<any[]>(page, '(s) => s.doc.sequence.events.filter(e => e.gesture === "played")');
    expect(played.length).toBe(1);
    expect(played[0].tick % 240).toBe(0);
    expect(played[0].length).toBeGreaterThanOrEqual(120);
    // with keys off the same letter is no longer captured
    await page.getByTestId('keys-toggle').click();
    await page.keyboard.press('g');
    expect(await state<number>(page, '(s) => s.doc.sequence.events.filter(e => e.gesture === "played").length')).toBe(1);
    await page.getByTestId('undo').click();
    expect(await state<number>(page, '(s) => s.doc.sequence.events.length')).toBe(n0);
  });

  test('sustain, find vowels, choke toggle and printed effects', async ({ page }) => {
    await fresh(page);
    await importWav(page, 'sung-phrase');
    const vowels = await state<number>(page, '(s) => s.doc.slices.filter(x => x.tags.includes("vowel")).length');
    expect(vowels).toBeGreaterThan(2);
    // sustain a vowel into a pad
    await page.evaluate(() => {
      const s = (window as any).__vcs.useStore.getState();
      s.setUI({ sliceIds: [s.doc.slices.find((x: any) => x.tags.includes('vowel')).id] });
    });
    await page.getByTestId('sustain-slice').click();
    const derived = await state<any>(page, '(s) => s.doc.sources.find(x => x.kind === "derived")');
    expect(derived.frames / derived.sampleRate).toBeGreaterThan(3.9);
    expect(await state<number>(page, '(s) => s.doc.slices.filter(x => x.tags.includes("sustained")).length')).toBe(1);
    // find vowels again: nothing is duplicated
    await page.getByTestId('find-vowels').click();
    expect(await state<number>(page, '(s) => s.doc.slices.filter(x => x.tags.includes("vowel")).length')).toBe(vowels);

    await page.getByTestId('go-compose').click();
    await page.getByTestId('compose-direct').click();
    // choke is on for a generated lead and can be switched off
    await page.evaluate(() => {
      const s = (window as any).__vcs.useStore.getState();
      s.setUI({ trackId: s.doc.sequence.tracks.find((t: any) => t.role === 'lead').id });
    });
    await expect(page.getByTestId('track-choke')).toBeChecked();
    await page.getByTestId('track-choke').uncheck();
    expect(await state<boolean>(page, '(s) => s.doc.sequence.tracks.find(t => t.role === "lead").choke')).toBe(false);

    // dry export vs printed reverb: the printed file carries a tail and is marked _fx
    await page.getByTestId('nav-export').click();
    let dl = page.waitForEvent('download');
    await page.getByTestId('export-mix').click();
    const dry = await dl;
    const dryInfo = wavInfo(await downloadBytes(dry));
    await page.getByTestId('nav-compose').click();
    await page.getByTestId('fx-reverb').fill('0.5');
    await page.getByTestId('fx-print').check();
    await page.getByTestId('nav-export').click();
    dl = page.waitForEvent('download');
    await page.getByTestId('export-mix').click();
    const wet = await dl;
    expect(wet.suggestedFilename()).toContain('_fx');
    const wetInfo = wavInfo(await downloadBytes(wet));
    expect(wetInfo.seconds).toBeGreaterThan(dryInfo.seconds + 1);
    expect(wetInfo.peak).toBeLessThanOrEqual(1);
  });
});
