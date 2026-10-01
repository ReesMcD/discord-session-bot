/**
 * Session Bot for macOS: a menu bar app that runs the Discord bot, the API and the web UI in one
 * process. Data lives in ~/Library/Application Support/Session Bot/.
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, powerSaveBlocker, safeStorage, shell, Tray, type MenuItemConstructorOptions } from 'electron';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateDependencyReport } from '@discordjs/voice';
import { BotService } from '../src/bot/BotService.js';
import { startServer, type RunningServer } from '../src/app/startServer.js';
import { listSessions } from '../src/app/sessions.js';
import { buildMenu, elapsed, type MenuAction, type MenuItem } from './menuModel.js';
import { checkForUpdate } from './updates.js';
import { applyToEnv, generatePassword, SecretStore, type Cipher } from './secrets.js';

const SMOKE = process.argv.includes('--smoke-test');
const PORT = Number(process.env.SESSION_BOT_PORT ?? 4400);
const require = createRequire(import.meta.url);

// --- Paths ------------------------------------------------------------------------------------
if (SMOKE) app.setPath('userData', mkdtempSync(join(tmpdir(), 'session-bot-smoke-')));
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
let tray: Tray | undefined;
let win: BrowserWindow | undefined;
let update: { version: string; url: string } | null = null;
let sleepBlocker: number | undefined;
let quitting = false;

const log = (m: string) => console.log(`[session-bot] ${m}`);

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
    title: 'Session Bot',
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
  recent = listSessions(dataDir).slice(0, 6);
  const state = {
    bot: status,
    guilds: bot.guilds(),
    recent,
    openAtLogin: app.getLoginItemSettings().openAtLogin,
    update,
    now: Date.now(),
    missingKeys: missingKeys(),
  };
  tray.setContextMenu(Menu.buildFromTemplate(toElectron(buildMenu(state))));
  tray.setImage(icon(rec ? 'trayRecording' : 'trayTemplate'));
  tray.setToolTip(rec ? `Recording #${rec.channelName}` : 'Session Bot');
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
  ipcMain.handle('keys:get', () => ({ discord: !!secrets.discord, groq: !!secrets.groq, anthropic: !!secrets.anthropic, password: true }));
  ipcMain.handle('keys:set', async (_e, patch: { discord?: string; groq?: string; anthropic?: string }) => {
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
}

async function quit(): Promise<void> {
  if (bot.status().recording) {
    const { response } = await dialog.showMessageBox({ type: 'question', buttons: ['Stop & Quit', 'Cancel'], message: 'A recording is in progress. Stop it and quit?' });
    if (response !== 0) return;
  }
  quitting = true;
  await bot.shutdown();
  await server?.close();
  app.exit(0);
}

// --- Smoke test (CI on a real Mac): everything starts and the pieces work -----------------------
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
    results.prompts = Array.isArray((results.prompts as { prompts?: unknown[] }).prompts) && (results.prompts as { prompts: unknown[] }).prompts.length === 3;
    results.tray = !!tray;
  } catch (err) {
    results.error = (err as Error).message;
  }
  const ok = results.api === 200 && results.webUi && results.ffmpeg && results.dave && results.aesGcm && results.prompts && results.tray && !results.error;
  console.log(`SMOKE ${ok ? 'PASS' : 'FAIL'} ${JSON.stringify(results)}`);
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
    try {
      server = await startServer({ password: secrets.password, port: PORT, host: '0.0.0.0', dataDir, configPath, webDist, bot, log });
    } catch (err) {
      const busy = (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
      await dialog.showMessageBox({
        type: 'error',
        message: busy ? `Port ${PORT} is already in use` : 'Session Bot could not start',
        detail: busy ? 'Is another copy of Session Bot (or `npm run app`) running? Quit it and try again.' : (err as Error).message,
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
    server.jobs.on('job', (j) => (j.status === 'done' || j.status === 'failed' ? soon() : undefined));
    setInterval(refreshTitle, 1000).unref();
    setInterval(() => bot.status().recording && refreshTray(), 15_000).unref(); // keep the dropdown's timer fresh
    refreshTray();

    if (SMOKE) return void smokeTest();

    await startBot();
    update = await checkForUpdate(app.getVersion()).catch(() => null);
    setInterval(async () => (update = await checkForUpdate(app.getVersion()).catch(() => update)), 6 * 3600_000).unref();
    if (missingKeys().length) openWindow('settings/keys'); // first run: go straight to setup
  });
}
