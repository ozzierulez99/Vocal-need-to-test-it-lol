import { contextBridge, ipcRenderer } from 'electron';

const CHANNELS = new Set([
  'dialog:openAudio', 'dialog:openMidi', 'dialog:relink', 'dialog:openProject', 'dialog:saveProject', 'dialog:saveFile', 'dialog:exportDir',
  'fs:readText', 'fs:readBytes', 'fs:writeText', 'fs:writeBytes', 'fs:exists', 'fs:mkdir', 'fs:isFile',
  'shell:show', 'app:recent', 'app:addRecent', 'app:examples', 'app:confirm-close',
]);

contextBridge.exposeInMainWorld('vcs', {
  platform: process.platform,
  invoke: (channel: string, ...args: unknown[]) => {
    if (!CHANNELS.has(channel)) throw new Error(`Blocked IPC channel ${channel}`);
    return ipcRenderer.invoke(channel, ...args);
  },
  onBeforeClose: (fn: () => void) => ipcRenderer.on('app:before-close', fn),
});
