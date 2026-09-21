import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { databaseEnvironment, validBackupDatabase, sha256, verifyArchive } from '../scripts/database-backup.mjs';

test('database URL credentials go into subprocess environment, not a connection argument', () => {
  const env = databaseEnvironment('postgresql://backup:p%40ss@localhost:5433/shop?schema=public&sslmode=require', { PGHOSTADDR: 'wrong', PGSERVICE: 'wrong' });
  assert.equal(env.PGPASSWORD, 'p@ss');
  assert.equal(env.PGDATABASE, 'shop');
  assert.equal(env.PGPORT, '5433');
  assert.equal(env.PGSSLMODE, 'require');
  assert.equal(env.PGHOSTADDR, undefined);
  assert.equal(env.PGSERVICE, undefined);
  assert.throws(() => databaseEnvironment('https://example.com/database'));
});

test('restore target cannot be the source or contain SQL/shell syntax', () => {
  assert.equal(validBackupDatabase('gem_backup_20260917_test', 'shop'), 'gem_backup_20260917_test');
  for (const name of ['shop', 'postgres', 'gem_backup_x;DROP DATABASE shop', 'gem_backup_source']) {
    assert.throws(() => validBackupDatabase(name, 'gem_backup_source'));
  }
});

test('archive integrity is checked before restore and detects tampering', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gem-backup-unit-'));
  const file = path.join(dir, 'snapshot.dump');
  try {
    await writeFile(file, 'snapshot');
    await writeFile(`${file}.json`, JSON.stringify({ format: 'gem-postgresql-backup-v1', sha256: await sha256(file), bytes: 8 }));
    await verifyArchive(file);
    await writeFile(file, 'tampered');
    await assert.rejects(verifyArchive(file), /checksum mismatch/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
