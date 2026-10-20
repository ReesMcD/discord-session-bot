import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { BrowserWindow, WebContentsView, ipcMain, type Rectangle } from 'electron';
import type { MusicControl, MusicStatus, MusicTab } from '../../src/music/control.js';

interface Tab {
  id: string;
  view: WebContentsView;
  title: string;
  url: string;
  volume: number;
  muted: boolean;
  audible: boolean;
}

export interface MusicBrowserOptions {
  /** The capture window's page and preload (built into dist-electron/). */
  capturePage: string;
  capturePreload: string;
  /** Each 20 ms PCM frame of the mix, while any tab is open. */
  onPcm: (pcm: Buffer) => void;
  /** The last tab closed: playback should stop. */
  onSilence: () => void;
  inChannel: () => boolean;
  log: (msg: string) => void;
}

/** Tabs share one browser profile, so logins (YouTube, Spotify…) are remembered between launches. */
const PARTITION = 'persist:music';

/**
 * The Mac app's music browser, like Kenku FM's: web pages in tabs whose audio is captured, mixed
 * and played into the voice channel by the recording bot. Tabs live in a hidden window so they keep
 * playing; the active one is moved into the app window while its Music page is open.
 */
export class MusicBrowser extends EventEmitter implements MusicControl {
  private readonly tabs = new Map<string, Tab>();
  private activeId: string | undefined;
  private master = 1;
  private monitor = true;
  private capture!: BrowserWindow;
  private host!: BrowserWindow;
  private shown: { win: BrowserWindow; bounds: Rectangle } | undefined;
  /** The window the active tab was last shown in, to take it back from when the page closes. */
  private lastWin: BrowserWindow | undefined;

  constructor(private readonly opts: MusicBrowserOptions) {
    super();
  }

  async start(): Promise<void> {
    const quiet = { show: false, skipTaskbar: true, width: 1200, height: 800 };
    this.host = new BrowserWindow({ ...quiet, webPreferences: { sandbox: true, contextIsolation: true } });
    this.capture = new BrowserWindow({
      ...quiet,
      webPreferences: { preload: this.opts.capturePreload, sandbox: true, contextIsolation: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
    });
    ipcMain.on('music:pcm', (e, data: Uint8Array) => {
      if (e.sender !== this.capture.webContents) return;
      this.opts.onPcm(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    });
    ipcMain.on('music:error', (e, id: string, message: string) => {
      if (e.sender === this.capture.webContents) this.opts.log(`music: couldn't capture tab ${id}: ${message}`);
    });
    await this.capture.loadFile(this.opts.capturePage);
  }

  status(): MusicStatus {
    return {
      available: true,
      inChannel: this.opts.inChannel(),
      master: this.master,
      monitor: this.monitor,
      tabs: [...this.tabs.values()].map(
        (t): MusicTab => ({ id: t.id, title: t.title, url: t.url, volume: t.volume, muted: t.muted, audible: t.audible, active: t.id === this.activeId }),
      ),
    };
  }

  /** Tells listeners something changed (also call it when the bot joins or leaves a channel). */
  changed(): void {
    this.emit('status', this.status());
  }

  openTab(url: string): string {
    const id = randomUUID().slice(0, 8);
    const view = new WebContentsView({
      webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
    });
    const wc = view.webContents;
    const tab: Tab = { id, view, title: url, url, volume: 1, muted: false, audible: false };
    this.tabs.set(id, tab);
    // Links that open a new window stay in this tab (logins and players work in place).
    wc.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:/.test(target)) void wc.loadURL(target);
      return { action: 'deny' };
    });
    wc.on('page-title-updated', (_e, title) => ((tab.title = title), this.changed()));
    wc.on('did-navigate', (_e, u) => ((tab.url = u), this.changed()));
    wc.on('did-navigate-in-page', (_e, u) => ((tab.url = u), this.changed()));
    wc.on('audio-state-changed', (e) => ((tab.audible = e.audible), this.changed()));
    this.host.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1200, height: 800 });
    void wc.loadURL(url).catch((err: Error) => this.opts.log(`music: couldn't load ${url}: ${err.message}`));
    this.capture.webContents.send('music:add', { id, mediaSourceId: wc.getMediaSourceId(this.capture.webContents), gain: 1 });
    this.activeId = id;
    this.place();
    this.changed();
    return id;
  }

  closeTab(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.capture.webContents.send('music:remove', id);
    for (const win of [this.host, this.lastWin]) {
      if (win && !win.isDestroyed() && win.contentView.children.includes(tab.view)) win.contentView.removeChildView(tab.view);
    }
    tab.view.webContents.close();
    this.tabs.delete(id);
    if (this.activeId === id) this.activeId = [...this.tabs.keys()].at(-1);
    if (!this.tabs.size) this.opts.onSilence();
    this.place();
    this.changed();
  }

  updateTab(id: string, patch: { volume?: number; muted?: boolean; active?: boolean }): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (patch.volume !== undefined) tab.volume = patch.volume;
    if (patch.muted !== undefined) tab.muted = patch.muted;
    if (patch.volume !== undefined || patch.muted !== undefined) this.capture.webContents.send('music:gain', { id, value: tab.muted ? 0 : tab.volume });
    if (patch.active) {
      this.activeId = id;
      this.place();
    }
    this.changed();
  }

  update(patch: { master?: number; monitor?: boolean }): void {
    if (patch.master !== undefined) this.capture.webContents.send('music:master', (this.master = patch.master));
    if (patch.monitor !== undefined) this.capture.webContents.send('music:monitor', (this.monitor = patch.monitor));
    this.changed();
  }

  /** Shows the active tab in `win` at `bounds` (the Music page's browser area), or hides it. */
  show(win: BrowserWindow, bounds: Rectangle | null): void {
    this.shown = bounds ? { win, bounds } : undefined;
    this.lastWin = win;
    this.place();
  }

  close(): void {
    for (const id of [...this.tabs.keys()]) this.closeTab(id);
    this.capture?.destroy();
    this.host?.destroy();
  }

  /** Every tab sits in the hidden host window, except the active one while the Music page shows it. */
  private place(): void {
    for (const tab of this.tabs.values()) {
      const visible = !!this.shown && tab.id === this.activeId && !this.shown.win.isDestroyed();
      const parent = visible ? this.shown!.win : this.host;
      const other = visible ? this.host : this.lastWin;
      // A view belongs to one window at a time: take it out of the other one first.
      if (other && !other.isDestroyed() && other.contentView.children.includes(tab.view)) other.contentView.removeChildView(tab.view);
      if (!parent.contentView.children.includes(tab.view)) parent.contentView.addChildView(tab.view);
      if (visible) tab.view.setBounds(this.shown!.bounds);
    }
  }
}
