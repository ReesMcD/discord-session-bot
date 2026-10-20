import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendToSection, sectionsOf, splitHeader } from '../web/src/recap.js';

const MD = '# Recap: x\n\n- **Date:** today\n\n---\n\n## NPCs\n\n- **Strahd**: a vampire\n\n## Combat\n\n- vs. wolves\n- **Kill count:** Thorin 1\n';

test('splits the generated header from the body, and lists sections', () => {
  const { header, body } = splitHeader(MD);
  assert.equal(header, '# Recap: x\n\n- **Date:** today\n\n---');
  assert.ok(body.startsWith('## NPCs'));
  assert.deepEqual(sectionsOf(MD), ['NPCs', 'Combat']);
  assert.deepEqual(splitHeader('## NPCs\n'), { header: '', body: '## NPCs\n' });
});

test('adds a note at the end of a section, or creates the section', () => {
  assert.equal(
    appendToSection(MD, 'NPCs', 'Ireena: Strahd wants her'),
    MD.replace('- **Strahd**: a vampire\n', '- **Strahd**: a vampire\n- Ireena: Strahd wants her\n'),
  );
  assert.equal(appendToSection(MD, 'Combat', '- Thorin was knocked out'), `${MD}- Thorin was knocked out\n`);
  assert.equal(appendToSection(MD, 'Loot', 'Two potions\nand a map'), `${MD}\n## Loot\n\n- Two potions\n  and a map\n`);
  assert.equal(appendToSection(MD, 'NPCs', '   '), MD);
});
