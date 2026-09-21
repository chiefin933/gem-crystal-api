#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, chmod, mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function databaseEnvironment(rawUrl, inherited = process.env) {
  const url = new URL(rawUrl);
  if (!['postgresql:', 'postgres:'].includes(url.protocol)) throw new Error('PostgreSQL DATABASE_URL required');
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!database || !url.hostname || !url.username) throw new Error('DATABASE_URL must specify host, user and database');
  const env = { ...inherited };
  for (const key of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE', 'PGOPTIONS']) delete env[key];
  Object.assign(env, {
    PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: database,
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGCONNECT_TIMEOUT: '15', PGAPPNAME: 'gem-crystal-backup',
  });
  for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) {
    if (url.searchParams.has(key)) env[`PG${key.toUpperCase()}`] = url.searchParams.get(key);
  }
  return env;
}

export function validBackupDatabase(name, source) {
  if (!/^gem_backup_[a-z0-9_]{1,48}$/.test(name) || name === source) throw new Error('Restore target must be a new gem_backup_* database, never the source');
  return name;
}

async function executable(name) {
  const dir = process.env.PG_BIN_DIR;
  if (dir) return path.join(dir, name);
  // Use the newest installed client; pg_dump must not be older than the server.
  for (const version of [18, 17, 16, 15, 14]) {
    const candidate = `/usr/lib/postgresql/${version}/bin/${name}`;
    try { await access(candidate); return candidate; } catch { /* try the next installed version */ }
  }
  return name;
}

async function run(command, args, env, timeout = 600_000) {
  const bin = await executable(command);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errorCode;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    // Do not print PostgreSQL stderr: provider diagnostics can contain credentials or row data.
    child.stderr.resume();
    const timer = setTimeout(() => { errorCode = 'timed out'; child.kill('SIGTERM'); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(new Error(`${command} could not start (${error.code ?? 'unknown error'})`)); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${command} ${errorCode || `failed with exit code ${code}`}. Check connectivity, client/server versions and database permissions. No existing database was overwritten.`));
      else resolve(output.trim());
    });
  });
}

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyArchive(file) {
  const manifest = JSON.parse(await readFile(`${file}.json`, 'utf8'));
  if (manifest.format !== 'gem-postgresql-backup-v1' || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error('Invalid backup manifest');
  if ((await stat(file)).size !== manifest.bytes || await sha256(file) !== manifest.sha256) throw new Error('Backup checksum mismatch; restore refused');
  return manifest;
}

export async function backupDatabase(env, directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(directory, `gem-${stamp}-${randomBytes(4).toString('hex')}.dump`);
  const partial = `${file}.partial`;
  const handle = await open(partial, 'wx', 0o600); await handle.close();
  const serverVersion = await run('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', 'SHOW server_version_num'], env);
  await run('pg_dump', ['--no-password', '--format=custom', '--no-owner', '--no-acl', '--lock-wait-timeout=30000', `--file=${partial}`], env);
  await run('pg_restore', ['--list', partial], env);
  await rename(partial, file);
  await chmod(file, 0o600);
  const manifest = {
    format: 'gem-postgresql-backup-v1', createdAt: new Date().toISOString(), serverVersion,
    databaseFingerprint: createHash('sha256').update(`${env.PGHOST}:${env.PGPORT}/${env.PGDATABASE}`).digest('hex'),
    bytes: (await stat(file)).size, sha256: await sha256(file),
  };
  await writeFile(`${file}.json`, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await verifyArchive(file);
  return { archive: file, manifest: `${file}.json`, bytes: manifest.bytes };
}

export async function restoreBackup(env, file, requestedName) {
  const manifest = await verifyArchive(file);
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const name = validBackupDatabase(requestedName ?? `gem_backup_${stamp}_${randomBytes(4).toString('hex')}`, env.PGDATABASE);
  // createdb refuses an existing database. No DROP, --clean or overwrite is used.
  await run('createdb', ['--no-password', '--template=template0', '--encoding=UTF8', name], env);
  const restoredEnv = { ...env, PGDATABASE: name };
  await run('pg_restore', ['--no-password', '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', `--dbname=${name}`, file], restoredEnv);
  const tables = await run('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"], restoredEnv);
  const counts = await run('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', `SELECT json_build_object('products', (SELECT count(*) FROM "Product"), 'variants', (SELECT count(*) FROM "Variant"), 'orders', (SELECT count(*) FROM "Order"), 'posSales', (SELECT count(*) FROM "PosSale"))`], restoredEnv);
  await run('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', `ALTER DATABASE "${name}" SET default_transaction_read_only = on`], restoredEnv);
  const report = { verifiedAt: new Date().toISOString(), database: name, sourceArchiveSha256: manifest.sha256, tables: Number(tables), counts: JSON.parse(counts), defaultReadOnly: true };
  await writeFile(`${file}.${name}.restore.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return report;
}

async function main() {
  process.umask(0o077);
  dotenv.config({ path: path.join(root, '.env'), quiet: true });
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
  const env = databaseEnvironment(process.env.DATABASE_URL);
  const [command = 'backup', argument, target] = process.argv.slice(2);
  const directory = path.resolve(process.env.BACKUP_DIR || path.join(root, 'backups'));
  if (command === 'status') {
    const files = (await readdir(directory)).filter(name => name.endsWith('.dump.json')).sort();
    if (!files.length) throw new Error('No completed backups found');
    const file = path.join(directory, files.at(-1).slice(0, -5));
    const manifest = await verifyArchive(file);
    const ageHours = (Date.now() - Date.parse(manifest.createdAt)) / 3600000;
    if (!Number.isFinite(ageHours) || ageHours > 36) throw new Error('Latest verified archive is older than 36 hours; run a backup now');
    console.log(JSON.stringify({ archive: file, createdAt: manifest.createdAt, ageHours: Number(ageHours.toFixed(2)), checksumValid: true }, null, 2));
  }
  else if (command === 'backup') console.log(JSON.stringify(await backupDatabase(env, directory), null, 2));
  else if (command === 'verify' && argument) {
    const restoreEnv = process.env.BACKUP_RESTORE_ENV_FILE
      ? databaseEnvironment(dotenv.parse(await readFile(path.resolve(process.env.BACKUP_RESTORE_ENV_FILE), 'utf8')).DATABASE_URL)
      : env;
    console.log(JSON.stringify(await restoreBackup(restoreEnv, path.resolve(argument), target), null, 2));
  }
  else throw new Error('Usage: node scripts/database-backup.mjs backup | status | verify ARCHIVE [new_gem_backup_database]');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Database backup failed: ${error.message}`); process.exitCode = 1; });
}
