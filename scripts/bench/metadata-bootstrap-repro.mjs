// Small synthetic correctness proof, not the measured 20k workload.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LiveLexicalSession } from '../../dist/kernel/engine/embed/live-lexical.js';
import { assembleLiveLexicalEngine } from '../../dist/kernel/engine/assemble.js';

const root = await mkdtemp(path.join(tmpdir(), 'oms-metadata-proof-'));
const vault = path.join(root, 'vault'); const dbPath = path.join(root, 'absent.sqlite');
await mkdir(vault);
for (let index = 0; index < 8; index++) await writeFile(path.join(vault, `note-${index}.md`),
  `---\nsubject: ${index % 2 ? 'science' : 'history'}\n---\n# Anonymous note\nmarker ${index}\n`);
const session = new LiveLexicalSession({ vault, dbPath });
const engine = assembleLiveLexicalEngine({ vault, dbPath, modelEnv: {}, installedModelsReceipt: { version: 1, models: [] } }, session);
try {
  const metadata = await engine.adapter.semanticQuery({ limit: 0, observed: { discover: { key: 'subject' } } });
  assert.equal(metadata.available, true); assert.equal(metadata.totalCount, 8);
  assert.equal(session.retainedStorage().bytes, 0, 'Observed-only bootstrap initialized lexical pages');
  const facet = metadata.observed.discovery.values.find(value => value.value === 'science');
  const selected = await engine.adapter.semanticQuery({ observed: { field: { subject: facet.selection } } });
  assert.equal(selected.totalCount, facet.count); assert.equal(facet.count, 4);
  const filename = path.join(vault, 'note-0.md');
  const replacement = '---\nsubject: science\n---\nfreshmarker\n';
  await writeFile(filename, replacement);
  const edited = await engine.adapter.semanticQuery({ observed: { field: { subject: facet.selection } } });
  assert.equal(edited.totalCount, 5); assert.equal(session.retainedStorage().bytes, 0);
  const lexical = await engine.adapter.semanticQuery({ query: 'freshmarker' });
  assert.equal(lexical.available, true); assert.deepEqual(lexical.hits.map(hit => hit.path), ['note-0.md']);
  assert(session.retainedStorage().bytes > 0);
  assert.equal(await readFile(filename, 'utf8'), replacement); assert.equal(existsSync(dbPath), false);
  console.log(JSON.stringify({ metadataWithoutLexicalPages: true, exactFacetCount: 4, editedCount: 5,
    laterLexicalUpgrade: true, persistentIndexAbsent: true }, null, 2));
} finally { await engine.dispose(); await session.dispose(); await rm(root, { recursive: true, force: true }); }
