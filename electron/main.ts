/**
 * Scrying Eye for macOS: a menu bar app that runs the Discord bot, the API and the web UI in one
 * process. Data lives in ~/Library/Application Support/Session Bot/ (its name before the rename).
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, powerSaveBlocker, safeStorage, shell, Tray, type MenuItemConstructorOptions } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { generateDependencyReport } from '@discordjs/voice';
import { BotService } from '../src/bot/BotService.js';
import { MusicBrowser } from './music/MusicBrowser.js';
import { startServer, type RunningServer } from '../src/app/startServer.js';
import { listSessions } from '../src/app/sessions.js';
import { PROMPT_NAMES } from '../src/app/promptStore.js';
import { buildMenu, elapsed, type MenuAction, type MenuItem } from './menuModel.js';
import { APP_BUNDLE, bundlePath, checkForUpdate, downloadVerified, parseManifest, planUpdate, stageCommands, swapScript, updateTarget, type Release } from './updates.js';
import { applyToEnv, generatePassword, SecretStore, type Cipher } from './secrets.js';

const SMOKE = process.argv.includes('--smoke-test');
const PORT = Number(process.env.SESSION_BOT_PORT ?? 4400);
const require = createRequire(import.meta.url);

// --- Paths ------------------------------------------------------------------------------------
// The app was called Session Bot. Electron names the Keychain entry that encrypts the saved keys
// after the app, so it keeps that name inside, along with its data folder.
const STORAGE_NAME = 'Session Bot';
app.setName(STORAGE_NAME);
app.setPath('userData', SMOKE ? mkdtempSync(join(tmpdir(), 'scrying-eye-smoke-')) : join(app.getPath('appData'), STORAGE_NAME));
const userData = app.getPath('userData');
const dataDir = join(userData, 'data');
const configPath = join(userData, 'config.yaml');
mkdirSync(dataDir, { recursive: true });
process.chdir(userData); // relative settings (e.g. prompts.local/) live next to config.yaml
// Packaged: extra files sit in Contents/Resources. Dev (`npm run mac:dev`): the repo root.
const root = app.getAppPath();
process.env.PROMPTS_BUILTIN_DIR = app.isPackaged ? join(process.resourcesPath, 'prompts') : join(root, 'prompts');
const webDist = app.isPackaged ? join(process.resourcesPath, 'web') : join(root, 'web', 'dist');
const assets = app.isPackaged ? join(process.resourcesPath, 'assets') : join(root, 'electron', 'assets');
// ffmpeg-static ships inside the app; binaries must be read from the unpacked copy.
process.env.FFMPEG_PATH ??= (require('ffmpeg-static') as string).replace('app.asar', 'app.asar.unpacked');

// --- Secrets (Keychain-encrypted) ---------------------------------------------------------------
const cipher: Cipher =
  SMOKE || !safeStorage.isEncryptionAvailable()
    ? { encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() }
    : { encrypt: (s) => safeStorage.encryptString(s), decrypt: (b) => safeStorage.decryptString(b) };
let secretStore: SecretStore;
let secrets: ReturnType<SecretStore['read']>;

function missingKeys(): string[] {
  const out: string[] = [];
  if (!secrets.discord) out.push('Discord token');
  if (!secrets.groq) out.push('Groq key');
  if (!secrets.anthropic) out.push('Anthropic key');
  return out;
}

// --- State ------------------------------------------------------------------------------------
let server: RunningServer | undefined;
let bot: BotService;
let music: MusicBrowser;
/** Smoke test only: loudness of the captured music, to prove tab capture works on a real Mac. */
const captured = { frames: 0, sumSquares: 0, samples: 0 };
let tray: Tray | undefined;
let win: BrowserWindow | undefined;
let update: Release | null = null;
/** What an update in progress is doing, for the menu. */
let updating: string | null = null;
let sleepBlocker: number | undefined;
let quitting = false;

const log = (m: string) => console.log(`[scrying-eye] ${m}`);

async function startBot(): Promise<void> {
  await bot.shutdown();
  if (secrets.discord) await bot.start(secrets.discord).catch((err: Error) => log(`Discord: ${err.message}`));
}

// --- Window -----------------------------------------------------------------------------------
function openWindow(route = ''): void {
  if (!server) return;
  const url = `${server.url}/#/${route}`;
  if (win && !win.isDestroyed()) {
    void win.loadURL(url);
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 380,
    minHeight: 500,
    title: 'Scrying Eye',
    // The UI's own background, so the window doesn't flash white while it loads.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d0f15' : '#f4f5f8',
    show: false,
    webPreferences: { preload: join(app.getAppPath(), 'dist-electron', 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('close', (e) => {
    // Keep running in the menu bar; recordings continue.
    if (!quitting) {
      e.preventDefault();
      win?.hide();
      app.dock?.hide();
    }
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: 'deny' };
  });
  app.dock?.show();
  void win.loadURL(url);
}

// --- Menu bar ---------------------------------------------------------------------------------
function toElectron(items: MenuItem[]): MenuItemConstructorOptions[] {
  return items.map((i) => {
    if (i.type === 'separator') return { type: 'separator' };
    return {
      label: i.label ?? '',
      ...(i.type ? { type: i.type } : {}),
      ...(i.checked !== undefined ? { checked: i.checked } : {}),
      enabled: i.enabled ?? true,
      ...(i.submenu ? { submenu: toElectron(i.submenu) } : {}),
      ...(i.action ? { click: () => void run(i.action!) } : {}),
    };
  });
}

async function run(action: MenuAction): Promise<void> {
  try {
    switch (action.kind) {
      case 'join':
        await bot.join(action.channelId);
        break;
      case 'stop': {
        const { sessionId } = await bot.stop();
        openWindow(`sessions/${encodeURIComponent(sessionId)}`);
        break;
      }
      case 'open':
        openWindow(action.route);
        break;
      case 'toggleLogin':
        app.setLoginItemSettings({ openAtLogin: !app.getLoginItemSettings().openAtLogin });
        break;
      case 'update':
        await shell.openExternal(action.url);
        break;
      case 'installUpdate':
        await installUpdate();
        break;
      case 'checkUpdates':
        update = await checkForUpdate(app.getVersion()).catch(() => null);
        if (!update) void dialog.showMessageBox({ message: `You're up to date (${app.getVersion()}).` });
        break;
      case 'quit':
        await quit();
        break;
    }
  } catch (err) {
    void dialog.showMessageBox({ type: 'warning', message: (err as Error).message });
  }
  refreshTray();
}

let recent: ReturnType<typeof listSessions> = [];

/** Rebuilds the dropdown; called when something changes (bot status, jobs, settings). */
function refreshTray(): void {
  if (!tray) return;
  const status = bot.status();
  const rec = status.recording;
  recent = listSessions(dataDir, server?.configStore.read().config ?? null).slice(0, 6);
  const state = {
    bot: status,
    guilds: bot.guilds(),
    recent,
    openAtLogin: app.getLoginItemSettings().openAtLogin,
    update,
    updating,
    now: Date.now(),
    missingKeys: missingKeys(),
  };
  tray.setContextMenu(Menu.buildFromTemplate(toElectron(buildMenu(state))));
  tray.setImage(icon(rec ? 'trayRecording' : 'trayTemplate'));
  tray.setToolTip(rec ? `Recording #${rec.channelName}` : 'Scrying Eye');
  refreshTitle();

  // Don't let the Mac sleep mid-recording.
  if (rec && sleepBlocker === undefined) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!rec && sleepBlocker !== undefined) {
    powerSaveBlocker.stop(sleepBlocker);
    sleepBlocker = undefined;
  }
}

/** The elapsed time next to the menu bar icon, updated every second while recording. */
function refreshTitle(): void {
  const rec = bot.status().recording;
  tray?.setTitle(rec ? ` ${elapsed(Date.now() - rec.startedAt)}` : '', { fontType: 'monospacedDigit' });
}

function icon(name: 'trayTemplate' | 'trayRecording') {
  const img = nativeImage.createFromPath(join(assets, `${name}.png`));
  img.setTemplateImage(name === 'trayTemplate');
  return img;
}

// --- IPC for the window (Settings → Keys) ---------------------------------------------------------
function registerIpc(): void {
  ipcMain.on('password', (e) => (e.returnValue = secrets.password));
  ipcMain.handle('version', () => app.getVersion());
  ipcMain.handle('keys:get', () => ({ discord: !!secrets.discord, groq: !!secrets.groq, anthropic: !!secrets.anthropic, wiki: !!secrets.wiki, password: true }));
  ipcMain.handle('keys:set', async (_e, input: Record<string, unknown>) => {
    // Only the known keys, as strings: the password is reset through its own call.
    const patch = Object.fromEntries((['discord', 'groq', 'anthropic', 'wiki'] as const).filter((k) => typeof input[k] === 'string').map((k) => [k, input[k] as string]));
    const discordChanged = patch.discord !== undefined && patch.discord.trim() !== (secrets.discord ?? '');
    secrets = secretStore.update(patch);
    applyToEnv(secrets);
    if (discordChanged) await startBot();
    refreshTray();
    return { restarted: discordChanged };
  });
  ipcMain.handle('phone:get', () => ({ password: secrets.password, port: server?.port ?? PORT }));
  ipcMain.handle('phone:reset', () => {
    secrets = secretStore.update({ password: generatePassword() });
    return { password: secrets.password };
  });
  ipcMain.handle('copy', (_e, text: string) => clipboard.writeText(text));
  ipcMain.handle('open-external', (_e, url: string) => (/^https?:\/\//.test(url) ? shell.openExternal(url) : undefined));
  ipcMain.handle('data-folder', () => userData);
  ipcMain.handle('reveal-data-folder', () => shell.openPath(userData));
  ipcMain.on('music:view', (e, b: { x: number; y: number; width: number; height: number } | null) => {
    if (!win || win.isDestroyed() || e.sender !== win.webContents) return;
    const ok = b && [b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n) && n >= 0);
    music.show(win, ok ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } : null);
  });
}

// --- Updates (#64) -----------------------------------------------------------------------------
/** Written once the app is up, so the update script knows the new version started. */
const launchedMarker = join(userData, 'launched-version');

const canWrite = (path: string) => {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/** Downloads, verifies and installs the update, then quits; a script swaps the app and restarts it. */
async function installUpdate(): Promise<void> {
  const release = update;
  if (!release || updating) return;
  const appPath = app.isPackaged ? bundlePath(process.execPath) : null;
  if (!appPath || !canWrite(dirname(appPath)) || !canWrite(appPath)) {
    await shell.openExternal(release.url);
    void dialog.showMessageBox({ message: 'Install this one by hand', detail: 'Scrying Eye can update itself once it lives in Applications (not on the disk image). Download it from the page that just opened.' });
    return;
  }
  if (bot.status().recording) throw new Error('Stop the recording first: the app restarts to update.');
  if (server?.encounters.current()?.status === 'running') throw new Error('End the encounter first: the app restarts to update.');
  const manifest = release.manifest ? parseManifest(await (await fetch(release.manifest.url)).json().catch(() => null)) : null;
  const plan = planUpdate(release, manifest, process.versions.electron);
  if (!plan) {
    await shell.openExternal(release.url);
    return;
  }
  const mb = Math.max(1, Math.round(plan.asset.size / 1_048_576));
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Install and Restart', 'Later'],
    message: `Install Scrying Eye ${release.version}?`,
    detail: `It downloads ${mb} MB${plan.kind === 'app' ? ' (just the app’s own code)' : ''}, then restarts, which takes about a minute. Your sessions and settings stay as they are.`,
  });
  if (response !== 0) return;

  const dir = join(userData, 'updates');
  const staging = join(dir, 'staging');
  mkdirSync(dir, { recursive: true });
  try {
    let shown = -1;
    updating = `Downloading ${release.version}…`;
    refreshTray();
    const zip = join(dir, plan.asset.name);
    await downloadVerified(plan.asset, zip, fetch, (f) => {
      const pct = Math.floor(f * 10) * 10;
      if (pct === shown) return;
      shown = pct;
      updating = `Downloading ${release.version}… ${pct}%`;
      refreshTray();
    });
    updating = `Installing ${release.version}…`;
    refreshTray();
    for (const [cmd, ...args] of stageCommands({ kind: plan.kind, zip, currentApp: appPath, staging, version: release.version })) {
      const r = spawnSync(cmd!, args, { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`Couldn't prepare the update (${basename(cmd!)}): ${(r.stderr || r.error?.message || '').trim().slice(0, 300)}`);
    }
    const script = join(dir, 'swap.sh');
    writeFileSync(script, swapScript({ pid: process.pid, appPath, target: updateTarget(appPath, existsSync), newApp: join(staging, APP_BUNDLE), previous: join(dir, 'previous.app'), marker: launchedMarker, version: release.version }), { mode: 0o755 });
    spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' }).unref();
    log(`updating to ${release.version} (${plan.kind}); restarting`);
  } catch (err) {
    updating = null;
    throw err;
  }
  quitting = true;
  music?.close();
  await bot.shutdown();
  await server?.close();
  app.exit(0);
}

async function quit(): Promise<void> {
  if (bot.status().recording) {
    const { response } = await dialog.showMessageBox({ type: 'question', buttons: ['Stop & Quit', 'Cancel'], message: 'A recording is in progress. Stop it and quit?' });
    if (response !== 0) return;
  }
  quitting = true;
  music?.close();
  await bot.shutdown();
  await server?.close();
  app.exit(0);
}

// --- Smoke test (CI on a real Mac): everything starts and the pieces work -----------------------
/** Smoke test: running loudness of the captured mix (16-bit stereo samples). */
function measure(pcm: Buffer): void {
  captured.frames++;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = pcm.readInt16LE(i);
    captured.sumSquares += v * v;
    captured.samples++;
  }
}

/** A page that plays a steady tone, for the smoke test's music capture check. */
const TONE_PAGE = `data:text/html,${encodeURIComponent(
  '<title>tone</title><script>const c=new AudioContext();const o=c.createOscillator();const g=c.createGain();g.gain.value=0.3;o.frequency.value=440;o.connect(g).connect(c.destination);o.start();c.resume();</script>',
)}`;

/** A WAV file of a 660 Hz tone, for the smoke test's soundboard check. */
function toneWav(seconds: number): Uint8Array {
  const rate = 48_000;
  const samples = rate * seconds;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 660) * 12_000), 44 + i * 2);
  return new Uint8Array(wav);
}

async function smokeTest(): Promise<void> {
  const results: Record<string, unknown> = {};
  try {
    const health = await fetch(`${server!.url}/api/health`, { headers: { Authorization: `Bearer ${secrets.password}` } });
    results.api = health.status;
    const page = await fetch(`${server!.url}/`);
    results.webUi = page.ok && (await page.text()).includes('<div id="root">');
    const ff = spawnSync(process.env.FFMPEG_PATH!, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    results.ffmpeg = ff.status === 0 && /libopus/.test(ff.stdout) && /\sflac\s/.test(ff.stdout);
    const report = generateDependencyReport();
    results.dave = /@snazzah\/davey: \d/.test(report);
    results.aesGcm = /aes-256-gcm: yes/.test(report);
    results.prompts = (await (await fetch(`${server!.url}/api/prompts`, { headers: { Authorization: `Bearer ${secrets.password}` } })).json()) as unknown as object;
    results.prompts = Array.isArray((results.prompts as { prompts?: unknown[] }).prompts) && (results.prompts as { prompts: unknown[] }).prompts.length === PROMPT_NAMES.length;
    results.tray = !!tray;
    results.updater = !!bundlePath(process.execPath);
    // Music: a tab playing a tone is captured, mixed and turned into PCM frames for the bot.
    const tab = music.openTab(TONE_PAGE);
    await new Promise((r) => setTimeout(r, 4000));
    music.closeTab(tab);
    const rms = captured.samples ? Math.sqrt(captured.sumSquares / captured.samples) : 0;
    results.musicFrames = captured.frames;
    results.musicRms = Math.round(rms);
    results.music = captured.frames >= 50 && rms > 1000;
    // Soundboard: a one-second effect, with no tab open, also reaches the bot, then stops.
    await new Promise((r) => setTimeout(r, 500));
    const before = { ...captured };
    music.playSound('smoke', toneWav(1), 0.8);
    await new Promise((r) => setTimeout(r, 2000));
    const frames = captured.frames - before.frames;
    const soundRms = Math.sqrt((captured.sumSquares - before.sumSquares) / Math.max(1, captured.samples - before.samples));
    results.soundFrames = frames;
    results.soundRms = Math.round(soundRms);
    results.sound = frames >= 40 && frames <= 75 && soundRms > 1000 && music.status().playingSounds.length === 0;
  } catch (err) {
    results.error = (err as Error).message;
  }
  const ok = results.api === 200 && results.webUi && results.ffmpeg && results.dave && results.aesGcm && results.prompts && results.tray && results.music && results.sound && !results.error;
  console.log(`SMOKE ${ok ? 'PASS' : 'FAIL'} ${JSON.stringify(results)}`);
  music.close();
  await bot.shutdown();
  await server?.close();
  app.exit(ok ? 0 : 1);
}

// --- Startup ------------------------------------------------------------------------------------
if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openWindow());
  app.on('window-all-closed', () => {
    /* stay in the menu bar */
  });
  app.on('activate', () => openWindow());

  void app.whenReady().then(async () => {
    app.dock?.hide();
    secretStore = new SecretStore(join(userData, 'secrets.bin'), cipher);
    secrets = secretStore.read();
    applyToEnv(secrets);
    registerIpc();

    bot = new BotService({ dataDir, configPath, log });
    music = new MusicBrowser({
      capturePage: join(app.getAppPath(), 'dist-electron', 'capture.html'),
      capturePreload: join(app.getAppPath(), 'dist-electron', 'capture.cjs'),
      onPcm: (pcm) => {
        if (SMOKE) measure(pcm);
        try {
          bot.music.write(pcm);
        } catch (err) {
          log(`music: ${(err as Error).message}`);
        }
      },
      onSilence: () => bot.music.stop(),
      inChannel: () => !!bot.status().recording,
      log,
      spotify: { name: 'Scrying Eye', dir: join(userData, 'spotify') },
    });
    await music.start();
    try {
      server = await startServer({ password: () => secrets.password, port: PORT, host: '0.0.0.0', dataDir, configPath, webDist, bot, music, log });
    } catch (err) {
      const busy = (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
      await dialog.showMessageBox({
        type: 'error',
        message: busy ? `Port ${PORT} is already in use` : 'Scrying Eye could not start',
        detail: busy ? 'Is another copy of Scrying Eye (or `npm run app`) running? Quit it and try again.' : (err as Error).message,
      });
      app.exit(1);
      return;
    }
    log(`web app on ${server.url}`);

    tray = new Tray(icon('trayTemplate'));
    // Status events are frequent (speaking indicators): coalesce menu rebuilds to at most 1/s.
    let pending: NodeJS.Timeout | undefined;
    const soon = () => (pending ??= setTimeout(() => ((pending = undefined), refreshTray()), 1000));
    bot.on('status', soon);
    let wasInChannel = false;
    bot.on('status', (s) => {
      if (!!s.recording !== wasInChannel) ((wasInChannel = !!s.recording), music.changed());
    });
    server.jobs.on('job', (j) => (j.status === 'done' || j.status === 'failed' ? soon() : undefined));
    setInterval(refreshTitle, 1000).unref();
    setInterval(() => bot.status().recording && refreshTray(), 15_000).unref(); // keep the dropdown's timer fresh
    refreshTray();

    if (SMOKE) return void smokeTest();

    // Tell an update in progress that this version started, and say if the last one didn't.
    writeFileSync(launchedMarker, app.getVersion());
    if (process.argv.includes('--update-failed')) {
      void dialog.showMessageBox({ type: 'warning', message: 'The update didn’t start, so Scrying Eye went back to this version.', detail: 'Try again from the menu, or install it by hand from the release page.' });
    }

    await startBot();
    update = await checkForUpdate(app.getVersion()).catch(() => null);
    setInterval(async () => (update = await checkForUpdate(app.getVersion()).catch(() => update)), 6 * 3600_000).unref();
    if (missingKeys().length) openWindow('settings/keys'); // first run: go straight to setup
  });
}
