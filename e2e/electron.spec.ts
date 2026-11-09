import { test, expect, _electron } from '@playwright/test';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { decodeWav } from '../src/core/audio/wav';

/** Drives the real desktop app. Needs a display: run with `xvfb-run -a npx playwright test --project electron`. */
const root = process.cwd();
const exe = join(root, 'node_modules/electron/dist/electron');

async function launch(env: Record<string, string>) {
  const app = await _electron.launch({ executablePath: exe, args: [root, '--no-sandbox'], env: { ...process.env, ...env } as any });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win };
}

test('desktop app: example → save folder → reopen → export WAV to disk', async () => {
  test.skip(!process.env.DISPLAY, 'needs a display (use xvfb-run)');
  const dir = mkdtempSync(join(tmpdir(), 'vcs-e2e-'));
  let { app, win } = await launch({ VCS_E2E_DIR: dir });
  expect(await win.evaluate(() => !!(window as any).vcs)).toBe(true);
  await win.getByTestId('welcome-example-ethereal-hook').click();
  await expect(win.getByTestId('event').first()).toBeVisible();
  const events = await win.evaluate(() => (window as any).__vcs.useStore.getState().doc.sequence.events.length);
  await win.keyboard.press('Control+s');
  await expect(win.getByTestId('toasts')).toContainText('Saved');
  const proj = join(dir, 'Ethereal Hook.vcs');
  expect(existsSync(join(proj, 'project.json'))).toBe(true);
  expect(readdirSync(join(proj, 'audio'))).toEqual(['sung-phrase.wav']);
  await app.close();

  ({ app, win } = await launch({ VCS_E2E_DIR: dir, VCS_E2E_OPEN: proj }));
  await win.getByTestId('project-menu').click();
  await win.getByTestId('menu-open').click();
  await expect(win.getByTestId('toasts')).toContainText('Opened');
  expect(await win.evaluate(() => (window as any).__vcs.useStore.getState().doc.sequence.events.length)).toBe(events);
  await win.getByTestId('nav-export').click();
  await win.getByTestId('export-mix').click();
  await expect(win.getByTestId('export-log')).toContainText('Mix');
  const outDir = join(dir, 'export');
  const sub = readdirSync(outDir)[0];
  const wav = readdirSync(join(outDir, sub)).find((f) => f.endsWith('.wav'))!;
  const a = decodeWav(new Uint8Array(readFileSync(join(outDir, sub, wav))));
  expect(a.channels.length).toBe(2);
  expect(a.channels[0].length / a.sampleRate).toBeGreaterThan(8 * 4 * 60 / 132 - 0.01);
  await app.close();
});
