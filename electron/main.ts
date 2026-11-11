import { app, BrowserWindow, dialog, ipcMain, session, shell, Menu, nativeImage } from 'electron';
import * as os from 'os';
import { promises as fs, existsSync } from 'fs';
import * as path from 'path';

/**
 * Electron main process: window, native dialogs and file-system access for
 * project folders and exports. All composition and audio work happens in the
 * renderer; the main process only moves bytes.
 */
const E2E_DIR = process.env.VCS_E2E_DIR; // test hook: replaces native dialogs
let win: BrowserWindow | null = null;

const AUDIO_EXT = ['wav', 'wave', 'mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'webm'];

function recentFile() {
  return path.join(app.getPath('userData'), 'recent.json');
}

async function readRecent(): Promise<any[]> {
  try {
    return JSON.parse(await fs.readFile(recentFile(), 'utf8'));
  } catch {
    return [];
  }
}

function examplesDir() {
  const packaged = path.join(process.resourcesPath ?? '', 'examples');
  if (app.isPackaged && existsSync(packaged)) return packaged;
  return path.join(app.getAppPath(), 'examples');
}

async function readPicked(paths: string[]) {
  return Promise.all(paths.map(async (p) => ({ name: path.basename(p), path: p, bytes: new Uint8Array(await fs.readFile(p)) })));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0d0e12',
    title: 'Vocal Chop Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  win.on('close', (e) => {
    if ((win as any).__forceClose) return;
    e.preventDefault();
    win?.webContents.send('app:before-close');
  });
}

app.whenReady().then(() => {
  // microphone recording
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { label: 'File', submenu: [{ label: 'Quit', role: 'quit' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('app:confirm-close', () => {
  if (win) {
    (win as any).__forceClose = true;
    win.close();
  }
});

ipcMain.handle('dialog:openAudio', async () => {
  if (E2E_DIR) {
    const p = process.env.VCS_E2E_AUDIO;
    return p ? readPicked(p.split(path.delimiter)) : [];
  }
  const r = await dialog.showOpenDialog(win!, { title: 'Import vocal recordings', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Audio', extensions: AUDIO_EXT }, { name: 'All files', extensions: ['*'] }] });
  return r.canceled ? [] : readPicked(r.filePaths);
});

ipcMain.handle('dialog:openMidi', async () => {
  if (E2E_DIR) {
    const p = process.env.VCS_E2E_MIDI;
    return p ? (await readPicked([p]))[0] : null;
  }
  const r = await dialog.showOpenDialog(win!, { title: 'Import MIDI', properties: ['openFile'], filters: [{ name: 'MIDI', extensions: ['mid', 'midi'] }] });
  return r.canceled ? null : (await readPicked(r.filePaths))[0];
});

ipcMain.handle('dialog:relink', async (_e, name: string) => {
  const r = await dialog.showOpenDialog(win!, { title: `Locate “${name}”`, properties: ['openFile'], filters: [{ name: 'Audio', extensions: AUDIO_EXT }] });
  return r.canceled ? null : (await readPicked(r.filePaths))[0];
});

ipcMain.handle('dialog:openProject', async () => {
  if (E2E_DIR) return process.env.VCS_E2E_OPEN ?? null;
  const r = await dialog.showOpenDialog(win!, {
    title: 'Open project (.vcs folder, project.json or .vcsz bundle)',
    properties: ['openFile', 'openDirectory'],
    filters: [{ name: 'Vocal Chop Studio', extensions: ['json', 'vcsz'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  return path.basename(p) === 'project.json' ? path.dirname(p) : p;
});

ipcMain.handle('dialog:saveProject', async (_e, name: string) => {
  if (E2E_DIR) return path.join(E2E_DIR, `${name}.vcs`);
  const r = await dialog.showSaveDialog(win!, { title: 'Save project folder', defaultPath: `${name}.vcs`, buttonLabel: 'Save project' });
  if (r.canceled || !r.filePath) return null;
  return r.filePath.endsWith('.vcs') ? r.filePath : `${r.filePath}.vcs`;
});

ipcMain.handle('dialog:saveFile', async (_e, name: string) => {
  if (E2E_DIR) return path.join(E2E_DIR, name);
  const r = await dialog.showSaveDialog(win!, { defaultPath: name });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('dialog:exportDir', async (_e, name: string) => {
  if (E2E_DIR) return path.join(E2E_DIR, 'export', name);
  const r = await dialog.showOpenDialog(win!, { title: 'Choose export folder', properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Export here' });
  if (r.canceled || !r.filePaths[0]) return null;
  return path.join(r.filePaths[0], name);
});

ipcMain.handle('fs:readText', (_e, p: string) => fs.readFile(p, 'utf8'));
ipcMain.handle('fs:readBytes', async (_e, p: string) => new Uint8Array(await fs.readFile(p)));
ipcMain.handle('fs:writeText', async (_e, p: string, t: string) => {
  await fs.mkdir(path.dirname(p), { recursive: true });
  // write-then-rename keeps project.json intact if the app crashes mid-save
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, t, 'utf8');
  await fs.rename(tmp, p);
});
ipcMain.handle('fs:writeBytes', async (_e, p: string, b: Uint8Array) => {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, Buffer.from(b));
});
ipcMain.handle('fs:exists', (_e, p: string) => existsSync(p));
ipcMain.handle('fs:mkdir', (_e, p: string) => fs.mkdir(p, { recursive: true }).then(() => undefined));
ipcMain.handle('fs:isFile', async (_e, p: string) => {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
});
/* Drag to DAW: rendered audio is written to a temp folder and handed to the OS as a real file drag. */
const DRAG_ICON = 'data:image/png;base64,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';
const dragDir = path.join(os.tmpdir(), 'vocal-chop-studio-drag');
ipcMain.handle('drag:prepare', async (_e, name: string, bytes: Uint8Array) => {
  await fs.mkdir(dragDir, { recursive: true });
  const p = path.join(dragDir, name.replace(/[\\/:*?"<>|]+/g, '_'));
  await fs.writeFile(p, Buffer.from(bytes));
  return p;
});
ipcMain.on('drag:start', (event, file: string) => {
  if (!file.startsWith(dragDir) || !existsSync(file)) return;
  event.sender.startDrag({ file, icon: nativeImage.createFromDataURL(DRAG_ICON) });
});
app.on('will-quit', () => {
  try {
    require('fs').rmSync(dragDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

ipcMain.handle('shell:show', (_e, p: string) => shell.showItemInFolder(p));
ipcMain.handle('app:recent', () => readRecent());
ipcMain.handle('app:addRecent', async (_e, entry: { name: string; location: string }) => {
  const list = (await readRecent()).filter((r) => r.location !== entry.location);
  list.unshift({ ...entry, savedAt: Date.now() });
  await fs.mkdir(path.dirname(recentFile()), { recursive: true });
  await fs.writeFile(recentFile(), JSON.stringify(list.slice(0, 12), null, 1));
});
ipcMain.handle('app:examples', async () => {
  const dir = examplesDir();
  try {
    const names = await fs.readdir(dir);
    return names.filter((n) => n.endsWith('.vcs')).map((n) => ({ name: n.replace(/\.vcs$/, ''), location: path.join(dir, n) }));
  } catch {
    return [];
  }
});
