import { spawn } from 'node:child_process';
import { mkdir, rm, cp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const fixture = path.join(root, 'test/fixtures/vault');
const sandbox = path.join(root, 'artifacts/red-team/vault');
await rm(sandbox, { recursive: true, force: true });
await mkdir(sandbox, { recursive: true });
await cp(fixture, sandbox, { recursive: true });

async function session(label, cwd, args) {
  const child = spawn(process.execPath, [path.join(root, 'dist/cli/oms.js'), 'mcp', ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HOME: path.join(root, 'artifacts/red-team/empty-home') } });
  const replies = new Map(); let next = 1; let buffer = ''; let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  child.stdout.on('data', (data) => {
    buffer += data;
    for (;;) { const end = buffer.indexOf('\n'); if (end < 0) break; const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1); if (!line) continue; try { const msg = JSON.parse(line); if (msg.id !== undefined) replies.set(msg.id, msg); } catch {} }
  });
  const call = async (method, params) => {
    const id = next++; child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    for (let i = 0; i < 100; i++) { await new Promise((r) => setTimeout(r, 20)); if (replies.has(id)) return replies.get(id); }
    return { timeout: true };
  };
  const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'red-team', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const results = { initialize: init, list: await call('tools/list', {}) };
  for (const [name, arguments_] of Object.entries(args.cases)) results[`${name}`] = await call('tools/call', { name: arguments_.name, arguments: arguments_.arguments });
  child.kill();
  return { label, cwd, results, stderr };
}

const cases = {
  old_direct: { name: 'oms_graph_build', arguments: {} },
  invalid_op: { name: 'oms_doctor', arguments: { op: 'nope' } },
  missing_op: { name: 'oms_doctor', arguments: {} },
  cross_op: { name: 'oms_doctor', arguments: { op: 'semantic-query', query: 'x' } },
  status: { name: 'oms_status', arguments: {} },
  doctor_audit: { name: 'oms_doctor', arguments: { op: 'audit' } },
  doctor_build: { name: 'oms_doctor', arguments: { op: 'build-graph' } },
  doctor_cleanup: { name: 'oms_doctor', arguments: { op: 'semantic-cleanup' } },
  doctor_sync: { name: 'oms_doctor', arguments: { op: 'sync-embeddings' } },
  write: { name: 'oms_write', arguments: { mode: 'create', notePath: 'notes/red-team.md', body: 'should not write' } },
  vector_missing_provider: { name: 'oms_search', arguments: { op: 'semantic-query', query: 'test', searches: undefined } },
};
const clean = Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, { ...v, arguments: Object.fromEntries(Object.entries(v.arguments).filter(([, x]) => x !== undefined)) }]));
const out = [await session('cwd-fixture', sandbox, Object.assign([], { cases: clean })), await session('explicit-missing', root, Object.assign(['--vault', path.join(root, 'artifacts/red-team/no-such-vault')], { cases: clean }))];
const existence = {};
for (const name of ['notes/red-team.md', '.oms/graph-cache.json', '.oms/engine-store.sqlite']) { try { await readFile(path.join(sandbox, name)); existence[name] = true; } catch { existence[name] = false; } }
await writeFile(path.join(root, 'artifacts/red-team/mcp-probe.json'), JSON.stringify({ kind: 'api-black-box-test-report', schemaVersion: 1, source: 'stdio MCP protocol', replaySafe: true, cases: clean, sessions: out, cwdWriteArtifactsExist: existence }, null, 2) + '\n');
