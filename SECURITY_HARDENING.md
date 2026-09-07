# Gem & Crystal POS/RBAC Hardening

## Changes
- JWT authentication now includes and server-validates OWNER/CASHIER role.
- Owner-only routes enforce OWNER role on admin stats, catalog mutations, orders administration, coupons, uploads, settings, POS approvals, POS sales, and audit logs.
- POS login requests are persisted in PostgreSQL through `PosLoginRequest` instead of process memory.
- POS login requests expire after 2 minutes.
- Cashier PINs are verified with bcrypt; a one-time legacy plaintext-to-bcrypt migration is supported.
- POS approval requires an authenticated OWNER.
- POS sessions use an opaque server-derived token and are stored only as SHA-256 hashes.
- POS checkout requires an active, unexpired POS session.
- POS checkout stock deduction uses an atomic PostgreSQL `UPDATE ... WHERE stockQuantity >= quantity` query against the actual `Variant` table.
- The POS UI no longer pretends that fingerprint hardware is connected; fingerprint authentication remains pending hardware integration.

## Database update
From `gem-crystal-api` after dependencies are installed:

```bash
npx prisma generate
npx prisma db push
```

For a production migration workflow, use your normal Prisma migration process instead of `db push`, e.g. create and review a named migration before applying it to production.

## Seed/demo cashier
The seed creates a demo cashier unless overridden by environment variables:

- Email: `CASHIER_EMAIL` or `cashier@gemandcrystal.co.ke`
- Name: `CASHIER_NAME` or `Cashier Grace (Roysambu)`
- PIN: `CASHIER_PIN` or `1234`

Change these values before any real deployment. Do not commit `.env` files or real credentials.

## Validation performed in this environment
- Backend TypeScript compilation: passed with `tsc --noEmit`.
- Admin TypeScript compilation: passed with `tsc --noEmit`.
- Prisma schema/client generation could not be run in this environment because the bundled Prisma engine attempted to reach `binaries.prisma.sh` and external network access was unavailable. Run `npx prisma generate` and the database update locally/CI before deployment.
