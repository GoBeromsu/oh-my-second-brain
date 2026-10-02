import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const digest = data => createHash('sha256').update(data).digest('hex');
export function notePath(index) { return `b${Math.floor(index / 10) % 5}/f${index % 10}/note-${String(index).padStart(5, '0')}.md`; }
export function description(index, count) {
  const fm = index % 10; const body = Math.floor(index / 10) % 5; const subject = `subject${index % 7}`;
  let fields = '';
  if (fm === 1) fields = 'title: Invalid fixture\nbroken: [missing\n';
  else if (fm === 2) fields = 'title: Unclosed fixture\nsubject: hidden\n';
  else if (fm !== 0) {
    const n = ({ 3: 4, 4: 12, 5: 28, 6: 60, 7: 12, 8: 28, 9: 4 })[fm];
    fields = `title: Synthetic note ${index}\nsubject: ${fm === 4 ? `[${subject}, shared]` : subject}\nscore: ${index % 101}\n`;
    if (fm === 5) fields += 'plainDate: 2026-01-02\nquotedDate: "2026-01-02"\n';
    if (fm === 8) fields += 'date: !!timestamp 2026-01-02\nquotedDate: "2026-01-02"\n';
    if (fm === 7) fields += 'alias: &group [alpha, beta]\naliasCopy: *group\nobject: {level: 3, enabled: true}\n';
    if (fm === 9) fields += '주제: [공개, 실험]\n';
    let k = fields.trim().split('\n').length;
    for (; k < n; k++) fields += `field${k}: ${k % 3 === 0 ? `[value${index % 17}, shared, extra]` : k % 3 === 1 ? `value${index % 31}` : index % 1000}\n`;
  }
  const prefix = fm === 0 ? '' : `---\n${fields}${fm === 2 ? '' : '---\n'}`;
  const markers = `corpusprobe unique${index} ${index % 97 === 0 ? 'cohortprobe' : ''} ${[0, Math.floor(count / 2), count - 1].includes(index) ? 'coldneedle' : ''}`;
  const heading = `# Synthetic anonymous document ${index}\n${markers}\n`;
  const vocabulary = ['analysis', 'system', 'garden', 'river', 'project', 'measurement', 'retrieval', 'design', 'pattern', 'sample', 'observation', 'window'];
  const seed = Array.from({ length: 15 }, (_, j) => vocabulary[(index * 7 + j * 5) % vocabulary.length]).join(' ') + '. ';
  const width = [36, 110, 700, 3000, 80][body];
  const line = body === 4 ? '공개 합성 자료 과학 자연 기록 검색 테스트 사례 '.repeat(4).slice(0, width) : seed.repeat(Math.ceil(width / seed.length)).slice(0, width);
  return { fm, body, subject: fm >= 3 ? subject : null, prefix: prefix + heading, line, sizeFactor: [0.3, 0.7, 1.1, 1.9][Math.floor(index / 50) % 4] };
}
export async function createFixture(vault, notes, targetBytes) {
  await fs.mkdir(vault, { recursive: true });
  const metadata = { kind: 'anonymous synthetic; representative of scale and structural variety, not a measured real-vault distribution', notes, targetBytes, inputBytes: 0, sha256ByPath: {}, subjects: {}, groups: {}, bodyWidths: [36, 110, 700, 3000, 80], frontmatterKinds: ['none', 'malformed YAML', 'unclosed fence', '4 keys', '12 keys/lists', '28 keys/date strings', '60 keys', '12 keys/aliases/nested object', '28 keys/explicit timestamp', '4 keys/Unicode'] };
  for (let b = 0; b < 5; b++) for (let f = 0; f < 10; f++) await fs.mkdir(path.join(vault, `b${b}/f${f}`), { recursive: true });
  for (let offset = 0; offset < notes; offset += 32) await Promise.all(Array.from({ length: Math.min(32, notes - offset) }, async (_, j) => {
    const index = offset + j; const d = description(index, notes);
    const size = Math.max(Buffer.byteLength(d.prefix) + 100, Math.round(targetBytes / notes * d.sizeFactor));
    const line = d.line + '\n'; const remaining = size - Buffer.byteLength(d.prefix);
    const repetitions = Math.floor(remaining / Buffer.byteLength(line));
    const content = d.prefix + line.repeat(repetitions) + 'x'.repeat(remaining - repetitions * Buffer.byteLength(line));
    const relative = notePath(index);
    metadata.inputBytes += Buffer.byteLength(content); metadata.sha256ByPath[relative] = digest(content);
    if (d.subject) metadata.subjects[d.subject] = (metadata.subjects[d.subject] ?? 0) + 1;
    if (d.fm === 4) metadata.subjects.shared = (metadata.subjects.shared ?? 0) + 1;
    const g = metadata.groups[`${d.body}:${d.fm}`] ??= { documents: 0, bytes: 0, lines: 0 };
    g.documents++; g.bytes += Buffer.byteLength(content); g.lines += content.split('\n').length;
    await fs.writeFile(path.join(vault, relative), content);
  }));
  return metadata;
}
export async function image(directory) {
  const result = {};
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name); const rel = path.relative(directory, filename);
      if (entry.isDirectory()) { result[`${rel}/`] = 'directory'; await visit(filename); }
      else result[rel] = digest(await fs.readFile(filename));
    }
  }
  await visit(directory); return result;
}

// Standalone anonymous reproduction. Build the selected checkout first.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const options = { notes: 20000, bytes: 199229440, work: tmpdir(), checkout: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), output: undefined };
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]?.slice(2); const value = process.argv[index + 1];
  assert(key && Object.hasOwn(options, key) && value !== undefined, 'Use --notes N --bytes N --work DIR --checkout DIR --output FILE');
  options[key] = key === 'notes' || key === 'bytes' ? Number(value) : path.resolve(value);
}
assert(Number.isSafeInteger(options.notes) && options.notes >= 200 && options.notes <= 100000, 'notes must be 200..100000');
assert(Number.isSafeInteger(options.bytes) && options.bytes >= options.notes * 100 && options.bytes <= 1024 ** 3, 'bytes must be notes*100..1GiB');
await fs.mkdir(options.work, { recursive: true });
const root = await fs.realpath(await fs.mkdtemp(path.join(options.work, 'oms-cold-repro-')));
const vault = path.join(root, 'vault'); const home = path.join(root, 'home'); const cache = path.join(root, 'cache'); const temp = path.join(root, 'temp');
try {
  for (const directory of [home, cache, temp]) await fs.mkdir(directory);
  const manifest = await createFixture(vault, options.notes, options.bytes);
  const before = await Promise.all([vault, home, cache].map(image));
  const resources = path.join(root, 'resources.json'); const preload = path.join(root, 'resources.mjs');
  await fs.writeFile(preload, `import {writeFileSync} from 'node:fs';\nprocess.on('exit',()=>writeFileSync(process.env.OMS_BENCH_RESOURCE,JSON.stringify({node:process.version,...process.resourceUsage()})));\n`);
  const stdout = []; const stderr = [];
  const start = performance.now();
  const child = spawn(process.execPath, ['--import', preload, path.join(options.checkout, 'dist/cli/oms.js'), 'search', 'coldneedle', '--vault', vault, '--limit', '10'], {
    cwd: vault, stdio: ['ignore', 'pipe', 'pipe'],
    env: { HOME: home, TMPDIR: temp, XDG_CACHE_HOME: cache, PATH: process.env.PATH ?? '', OMS_UPDATE_NOTICE: '0', OMS_BENCH_RESOURCE: resources },
  });
  child.stdout.on('data', value => stdout.push(value)); child.stderr.on('data', value => stderr.push(value));
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const elapsedMs = performance.now() - start;
  assert.equal(code, 0, Buffer.concat(stderr).toString());
  const result = JSON.parse(Buffer.concat(stdout).toString());
  assert.equal(result.available, true); assert.equal(result.totalCount, 3);
  assert.deepEqual(result.receipt.usedChannels, ['lex']); assert.equal(result.receipt.indexDrift, false);
  assert.deepEqual(await Promise.all([vault, home, cache].map(image)), before, 'Read-only query changed source or persistent state');
  assert.deepEqual(await fs.readdir(temp), [], 'Session temporary storage was not cleaned');
  const usage = JSON.parse(await fs.readFile(resources, 'utf8'));
  const report = {
    fixture: manifest.kind, notes: manifest.notes, inputBytes: manifest.inputBytes, elapsedMs,
    runtime: usage.node, maxRssBytes: usage.maxRSS * 1024, userCpuMs: usage.userCPUTime / 1000, systemCpuMs: usage.systemCPUTime / 1000,
    scope: 'Fresh CLI, no persistent index/session cache; filesystem page caches are not dropped; fixture creation and byte verification excluded',
    noSourceOrPersistentStateChanges: true, temporaryCleaned: true, result,
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (options.output) await fs.writeFile(options.output, json);
  process.stdout.write(json);
} finally { await fs.rm(root, { recursive: true, force: true }); }
