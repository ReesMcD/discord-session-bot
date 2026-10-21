// Bundles the Mac app's main process (ESM) and preloads (CommonJS) into dist-electron/.
import { copyFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', target: 'node22', sourcemap: true, logLevel: 'info', packages: 'external' };
await build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.mjs', format: 'esm' });
await build({ ...common, entryPoints: ['electron/preload.cts'], outfile: 'dist-electron/preload.cjs', format: 'cjs' });
// The music capture window runs sandboxed: its preload gets everything bundled in.
await build({ ...common, packages: undefined, external: ['electron'], entryPoints: ['electron/music/capture.cts'], outfile: 'dist-electron/capture.cjs', format: 'cjs' });
mkdirSync('dist-electron', { recursive: true });
copyFileSync('electron/music/capture.html', 'dist-electron/capture.html');
