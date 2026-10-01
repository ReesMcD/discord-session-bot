// Bundles the Mac app's main process (ESM) and preload (CommonJS) into dist-electron/.
import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', target: 'node22', sourcemap: true, logLevel: 'info', packages: 'external' };
await build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.mjs', format: 'esm' });
await build({ ...common, entryPoints: ['electron/preload.cts'], outfile: 'dist-electron/preload.cjs', format: 'cjs' });
