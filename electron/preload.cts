// Runs in the app window before the web UI: signs it in and exposes a small, fixed bridge.
import { contextBridge, ipcRenderer } from 'electron';

try {
  window.localStorage.setItem('session-bot-password', ipcRenderer.sendSync('password') as string);
} catch {
  /* storage unavailable: the login screen will ask */
}

contextBridge.exposeInMainWorld('sessionBot', {
  version: () => ipcRenderer.invoke('version'),
  getKeys: () => ipcRenderer.invoke('keys:get'),
  setKeys: (keys: Record<string, string>) => ipcRenderer.invoke('keys:set', keys),
  getPhoneAccess: () => ipcRenderer.invoke('phone:get'),
  resetPassword: () => ipcRenderer.invoke('phone:reset'),
  copy: (text: string) => ipcRenderer.invoke('copy', text),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  dataFolder: () => ipcRenderer.invoke('data-folder'),
  revealDataFolder: () => ipcRenderer.invoke('reveal-data-folder'),
  /** Where the Music page's browser area is (CSS pixels in the window), or null when it's not shown. */
  showMusicTab: (bounds: { x: number; y: number; width: number; height: number } | null) => ipcRenderer.send('music:view', bounds),
});
