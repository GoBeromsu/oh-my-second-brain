import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('collect-verification-artifacts script', () => {
  it('copies OMSB artifacts and plugin data into a review directory with a manifest', () => {
    const vault = makeTempDir('omsb-verify-vault-');
    const out = makeTempDir('omsb-verify-out-');

    fs.mkdirSync(path.join(vault, '.omsb'), { recursive: true });
    fs.mkdirSync(path.join(vault, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(vault, '.obsidian', 'plugins', 'calendar'), { recursive: true });

    fs.writeFileSync(path.join(vault, 'omsb.config.json'), '{"version":1}\n', 'utf-8');
    fs.writeFileSync(path.join(vault, '.omsb', 'rules.json'), '{"version":1,"rules":[]}\n', 'utf-8');
    fs.writeFileSync(path.join(vault, '.omsb', 'CLAUDE.md'), '# omsb\n', 'utf-8');
    fs.writeFileSync(path.join(vault, '.claude', 'CLAUDE.md'), '@file .omsb/CLAUDE.md\n', 'utf-8');
    fs.writeFileSync(path.join(vault, '.obsidian', 'plugins', 'calendar', 'data.json'), '{"enabled":true}\n', 'utf-8');

    const script = path.join(process.cwd(), 'scripts', 'collect-verification-artifacts.mjs');
    const result = spawnSync(process.execPath, [script, vault, out], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Collected 5 artifact/);
    assert.ok(fs.existsSync(path.join(out, 'omsb.config.json')));
    assert.ok(fs.existsSync(path.join(out, '.omsb', 'rules.json')));
    assert.ok(fs.existsSync(path.join(out, '.omsb', 'CLAUDE.md')));
    assert.ok(fs.existsSync(path.join(out, '.claude', 'CLAUDE.md')));
    assert.ok(fs.existsSync(path.join(out, '.obsidian', 'plugins', 'calendar', 'data.json')));

    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf-8')) as { copied: string[] };
    assert.deepEqual(manifest.copied, [
      '.claude/CLAUDE.md',
      '.obsidian/plugins/calendar/data.json',
      '.omsb/CLAUDE.md',
      '.omsb/rules.json',
      'omsb.config.json',
    ]);
  });
});
