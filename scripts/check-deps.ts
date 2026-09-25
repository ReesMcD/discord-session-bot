/** Fails if the voice stack's native pieces (DAVE, AES-GCM) can't load on this machine. */
import { generateDependencyReport } from '@discordjs/voice';

const report = generateDependencyReport();
console.log(report);
const problems: string[] = [];
if (!/@snazzah\/davey: \d/.test(report)) problems.push('DAVE library (@snazzah/davey) did not load');
if (!/native crypto support for aes-256-gcm: yes/.test(report)) problems.push('no native aes-256-gcm');
if (problems.length) {
  console.error(`\nVoice dependencies not usable:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('Voice dependencies OK');
