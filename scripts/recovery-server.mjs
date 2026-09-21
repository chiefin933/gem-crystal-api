#!/usr/bin/env node
// A separate, local-only PostgreSQL recovery cluster. Never uses the app's data directory.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'backups');
const data = path.join(directory, 'recovery-postgres');
const bin = process.env.PG_BIN_DIR || '/usr/lib/postgresql/16/bin';
process.umask(0o077);
async function run(name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(bin, name), args, { stdio: ['ignore', 'ignore', 'ignore'] });
    child.once('error', () => reject(new Error(`${name} could not start`)));
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${name} failed; check recovery-postgres.log (source database unaffected)`)));
  });
}
async function main() {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const command = process.argv[2] || 'start';
  if (command === 'stop') { await run('pg_ctl', ['-D', data, 'stop', '-m', 'fast']); console.log('Recovery server stopped; backup database retained on disk.'); return; }
  if (command !== 'start') throw new Error('Use start or stop');
  let initialized = false;
  try { await access(path.join(data, 'PG_VERSION')); initialized = true; } catch { /* first setup */ }
  if (!initialized) {
    const password = randomBytes(32).toString('hex');
    const passwordFile = path.join(directory, 'recovery.password');
    await writeFile(passwordFile, password + '\n', { mode: 0o600, flag: 'wx' });
    await run('initdb', ['-D', data, '-U', 'gem_recovery', '--encoding=UTF8', '--no-locale', '--auth-local=scram-sha-256', '--auth-host=scram-sha-256', `--pwfile=${passwordFile}`]);
    await writeFile(path.join(directory, 'recovery.env'), `DATABASE_URL=postgresql://gem_recovery:${password}@127.0.0.1:55441/postgres\n`, { mode: 0o600, flag: 'wx' });
  }
  try { await run('pg_ctl', ['-D', data, 'status']); console.log('Recovery server is already running on localhost:55441.'); return; } catch { /* stopped */ }
  await run('pg_ctl', ['-D', data, '-l', path.join(directory, 'recovery-postgres.log'), '-o', '-p 55441 -h 127.0.0.1 -k /tmp', 'start']);
  console.log('Recovery server running on localhost:55441. Credentials are in the private backups/recovery.env file.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
