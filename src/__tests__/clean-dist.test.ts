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

describe('clean-dist script', () => {
  it('removes the dist directory when present', () => {
    const repoLike = makeTempDir('omsb-clean-dist-');
    const distDir = path.join(repoLike, 'dist', 'nested');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'stale.txt'), 'stale', 'utf-8');

    const script = path.join(process.cwd(), 'scripts', 'clean-dist.mjs');
    const result = spawnSync(process.execPath, [script], {
      cwd: repoLike,
      encoding: 'utf-8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(repoLike, 'dist')), false);
  });

  it('succeeds when dist does not exist', () => {
    const repoLike = makeTempDir('omsb-clean-dist-empty-');
    const script = path.join(process.cwd(), 'scripts', 'clean-dist.mjs');
    const result = spawnSync(process.execPath, [script], {
      cwd: repoLike,
      encoding: 'utf-8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(repoLike, 'dist')), false);
  });
});
