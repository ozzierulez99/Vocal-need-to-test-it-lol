import { app, BrowserWindow, dialog, ipcMain, session, shell, Menu } from 'electron';
import { promises as fs, existsSync } from 'fs';
import * as path from 'path';

/**
 * Electron main process: window, native dialogs and file-system access for
 * project folders and exports. All composition and audio work happens in the
 * renderer; the main process only moves bytes.
 */
const E2E_DIR = process.env.VCS_E2E_DIR; // test hook: replaces native dialogs
let win: BrowserWindow | null = null;

const AUDIO_EXT = ['wav', 'wave', 'mp3', 'flac', 'ogg', 'oga', 'm4a', 'aac', 'aif', 'aiff', 'webm'];

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
