# Database backup and recovery

## What is enabled

Daily local PostgreSQL backups run through the user-level systemd timer `gem-crystal-backup.timer`, independently of Codex. The schedule is 03:00–03:15 in the computer's local timezone (currently Europe/Moscow). A missed run is caught up when the user scheduler next starts. The machine must be on and the user session available; this is not an always-on cloud backup service. No logout-persistence setting was changed.

A backup service run was tested successfully on 17 September 2026. Failure triggers a critical desktop notification when the desktop notification service is available. Logs are available with:

```bash
systemctl --user list-timers gem-crystal-backup.timer
systemctl --user status gem-crystal-backup.service
journalctl --user -u gem-crystal-backup.service --since yesterday
```

The installed units are in `~/.config/systemd/user/`. Their reviewable source files are in `scripts/systemd/`. If the repository moves, update the units' working directory and executable path, then reload systemd.

## Storage and protection

Backups are stored in `gem-crystal-api/backups/`, excluded from Git. The directory has mode 0700 and archives, manifests and recovery credentials have mode 0600. Archives contain private customer/business data. They are access-restricted but **not encrypted at rest by this tool**. Use full-disk encryption and encrypted off-device storage for disaster protection.

Each successful run creates a unique custom-format `.dump` archive plus a `.dump.json` SHA-256 manifest. Interrupted `.partial` files are not completed backups. A new run never replaces an older backup. No retention deletion is enabled; monitor disk capacity and retain backups according to business needs before adding an explicit retention policy.

A same-computer archive or recovery database protects against accidental application/database changes, but not disk loss, theft or computer failure. An off-device destination remains to be selected. Do not treat this as disaster recovery until an encrypted off-device copy is also maintained and restore-tested.

## Manual backup and health check

From the API repository:

```bash
npm run db:backup
npm run db:backup:status
```

The backup reads the configured `DATABASE_URL` without changing the application database. PostgreSQL credentials are passed in the child-process environment, never command-line arguments. `PG_BIN_DIR` can select compatible PostgreSQL client tools; by default the newest installed Linux client is selected. `BACKUP_DIR` can select another backup directory.

The status command verifies the newest archive checksum and fails if it is more than 36 hours old. A zero exit code confirms archive integrity and freshness, not the health of off-device storage. Back up before database migrations and deployments as well as on the daily schedule.

## Verified recovery database

The current application database was dumped on 17 September 2026 and restored successfully into a separate local PostgreSQL 16 recovery cluster:

- Recovery database: `gem_backup_20260917_4e128b67`
- Recovery server: localhost port `55441`
- Cluster data: `backups/recovery-postgres/`
- Connection credentials: `backups/recovery.env` (private; never commit or send)
- Snapshot contents: 18 tables, 5 products, 11 variants, 4 orders, 31 POS sales
- Default transaction mode: read-only, to reduce accidental edits

The live application's PostgreSQL 14 account does not have CREATE DATABASE privilege. Its permissions were preserved; the recovery cluster is independent. The recovery database is a point-in-time snapshot, not a continuously synchronized replica. Later daily dumps are newer recovery points.

Start the recovery server only when needed:

```bash
npm run db:recovery:start
BACKUP_RESTORE_ENV_FILE=backups/recovery.env npm run db:backup:verify -- backups/ARCHIVE.dump
npm run db:recovery:stop
```

Replace `ARCHIVE.dump` with an actual completed archive. Verification checks the archive checksum, creates a **new** `gem_backup_*` database, restores in a single transaction, verifies business tables/counts and enables read-only defaults. It refuses existing database names and never drops or cleans a database. Each verified restore leaves a recovery database and a report beside the archive. Keep enough disk space for the database copies.

If a restore fails, retain the original archive and inspect the recovery service log. Do not retry against the source database, delete live data, or grant the application database-administration privileges to make a restore work.

Restoring service after an incident is a separate, deliberate operation: stop writes, choose and verify a recovery point, reconcile payments received since that snapshot with the merchant, and switch the application only after review. Do not simply point the app at the read-only verification database during active trading.

## Migration rehearsal

A second restored database, `gem_backup_staging_20260917`, was used to rehearse deployment. The two pending migrations (admin token revocation and checkout tracking) applied successfully, and Prisma reported no schema difference. That copy was returned to read-only mode. The untouched recovery database and live application database were not migrated.

## Scope

Database backups include schema and records; they do not back up source code, deployment secrets or external image/media files. Maintain protected copies of those separately. Meta WhatsApp credentials/templates and M-Pesa provider records require their own account recovery and reconciliation arrangements.

Automated deletion, replication and off-device upload are not enabled. Backups do not eliminate the need for live payment acceptance testing or post-restore payment reconciliation.
