/**
 * CI (mac-app.yml): installs the small update the way the app does — a copy of the built app with
 * its Resources replaced from the app zip, re-signed — and checks the result still starts.
 *
 *   npx tsx scripts/check-update.ts "<built .app>" "<…-app.zip>" <version>
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageCommands } from '../electron/updates.js';

const [builtApp, zip, version] = process.argv.slice(2);
if (!builtApp || !zip || !version) throw new Error('usage: check-update.ts <app> <app.zip> <version>');
const staging = join(mkdtempSync(join(tmpdir(), 'update-')), 'staging');
for (const [cmd, ...args] of stageCommands({ kind: 'app', zip, currentApp: builtApp, staging, version })) {
  const r = spawnSync(cmd!, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
}
const staged = join(staging, 'Session Bot.app');
const verify = spawnSync('/usr/bin/codesign', ['--verify', '--deep', staged], { encoding: 'utf8' });
if (verify.status !== 0) throw new Error(`The updated app's signature doesn't verify: ${verify.stderr}`);
const run = spawnSync(join(staged, 'Contents', 'MacOS', 'Session Bot'), ['--smoke-test'], { encoding: 'utf8', timeout: 120_000 });
const out = `${run.stdout}\n${run.stderr}`;
console.log(out.split('\n').filter((l) => /^SMOKE/.test(l)).join('\n'));
if (!/^SMOKE PASS/m.test(out)) throw new Error('The app built from the small update did not pass the smoke test');
console.log('UPDATE CHECK PASS');
