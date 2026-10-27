// The lobby keeper scripts: valid bash, and log rotation keeps N copies and truncates in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scripts = ['lobby-common.sh', 'lobby-supervise.sh', 'lobby-watchdog.sh', 'lobby-ensure.sh'];

test('keeper scripts parse', () => {
  for (const s of scripts) execFileSync('bash', ['-n', join('tools', s)]);
});

test('rotate: copy-truncate, keeps LOBBY_ROTATE_KEEP old copies, newest in .1', () => {
  const d = mkdtempSync(join(tmpdir(), 'rot-'));
  try {
    execFileSync('bash', ['-c', 'source tools/lobby-common.sh; f=$log_dir/x.log; for i in 1 2 3 4 5; do printf "%0200d" $i >> $f; rotate $f; done'], {
      env: { ...process.env, LOBBY_LOG_DIR: d, LOBBY_DATA: join(d, 'data'), LOBBY_ROTATE_BYTES: '100', LOBBY_ROTATE_KEEP: '3' },
    });
    const files = readdirSync(d).filter((f) => f.startsWith('x.log')).sort();
    assert.deepEqual(files, ['x.log', 'x.log.1', 'x.log.2', 'x.log.3']);
    assert.equal(readFileSync(join(d, 'x.log'), 'utf8'), '');
    assert.match(readFileSync(join(d, 'x.log.1'), 'utf8'), /5$/);
    assert.match(readFileSync(join(d, 'x.log.3'), 'utf8'), /3$/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
