# Security hardening and release handoff  2026-10-01

## Scope

This pass covers the production code on the `main` branches of:

- storefront: `Gem & Crystal Fashion Hub`
- API: `gem-crystal-api`
- owner admin: `gem-crystal-admin`
- point of sale: `gem-crystal-pos`

The experimental `codex/editorial-storefront` design branch was not merged or modified.

## Controls implemented

### Owner authentication

- Production owner access now requires TOTP multi-factor authentication and cannot be disabled with an environment flag.
- Initial enrollment is allowed only after a correct owner email/password through a restricted ten-minute setup token.
- The setup token cannot call owner APIs.
- TOTP secrets are encrypted at rest with AES-256-GCM using a dedicated 32-byte key.
- Recovery codes are generated once, shown once, stored only as keyed SHA-256 hashes, and consumed once.
- A TOTP time step cannot be replayed.
- Completing enrollment increments `tokenVersion`, invalidating older owner JWTs.
- Admin logout calls the API and increments `tokenVersion`, revoking all outstanding owner tokens.
- The admin browser keeps its owner token in memory only.

### API and network boundary

- Production startup fails when JWT and POS secrets are weak, shared, or placeholders.
- Storefront, admin, and POS must use three distinct HTTPS origins.
- Reverse-proxy trust uses an explicit hop count from `TRUST_PROXY_HOPS`; inventory audit IPs use Express's trusted `req.ip`.
- API responses are marked `Cache-Control: no-store`.
- Browser CORS access is restricted to the three configured origins.
- Existing Helmet protections remain enabled.
- Login, MFA setup, checkout, polling, catalogue, coupon, upload, and AI endpoints have purpose-specific rate limits.

### Payment safeguards

- Live M-Pesa mode refuses to start without the consumer credentials, numeric shortcode/Till, HTTPS C2B callback URL, and a strong callback secret.
- Callback secrets use timing-safe comparisons.
- Provider payloads remain stored for server-side audit but are excluded from admin browser responses.
- Existing settlement invariants were reverified: exact cent matching, unique receipts, atomic coupon use, no overselling, idempotent completion, private tracking tokens, and no owner payment override.

### Product, upload, and browser input

- Product create/update payloads are strict and bounded.
- Product images must use HTTPS URLs.
- Stock adjustments are strict, bounded, trimmed, and audited.
- Image uploads accept at most four JPEG/PNG/WEBP files, at most 5 MB each, validate magic bytes, and bound multipart fields/parts.
- The storefront validates cart and wishlist data before trusting localStorage.
- POS validates cached catalogue and queued offline cash sales before rendering or syncing them.
- Offline POS cash records cannot retain customer phone numbers.

### Frontend isolation and headers

- Unreachable legacy admin/dashboard code was removed from the POS bundle, including the old localStorage owner-token client.
- Storefront, admin, and POS now publish CSP, frame, MIME-sniffing, referrer, permissions, and cache policies through `public/_headers`, with a CSP meta fallback in `index.html`.
- These headers must still be verified on the selected host because not every static host reads a Netlify/Cloudflare-style `_headers` file.

### Automation

Each repository now has CI that installs from the lockfile, audits production dependencies, builds, and runs its automated tests. The storefront CI also runs lint.

## Verification completed

All checks below passed locally on 2026-10-01:

| Project | Verification |
| --- | --- |
| API | TypeScript build; 16 unit/security tests; 3 backup tests; 14 isolated PostgreSQL integration tests; full dependency audit with 0 vulnerabilities |
| Storefront | Production build; clean lint; 6 tests; full dependency audit with 0 vulnerabilities |
| Admin | Production build; 4 MFA/auth tests; full dependency audit with 0 vulnerabilities |
| POS | Production build; 6 API/offline validation tests; full dependency audit with 0 vulnerabilities |

The integration tests used a separate localhost PostgreSQL database named `gem_tests_codex_20261001` on the recovery cluster. They did not use the live boutique database.

The latest backup status checked during this pass was checksum-valid.

Browser smoke testing confirmed that the storefront, admin login, and POS authentication screens render and that storefront department navigation works. The storefront preview had no local API behind its Vite proxy, while the local POS preview was correctly rejected by production CORS. The later Render logs confirmed that the hosted API connected to PostgreSQL and started successfully.

## Detailed deployment and hosting sequence

Do these steps in order. A deployment is not considered complete until the smoke checks at the end pass.

### 1. Choose four HTTPS origins

Use separate origins, for example:

- storefront: `https://www.your-domain.example`
- admin: `https://admin.your-domain.example`
- POS: `https://pos.your-domain.example`
- API: `https://api.your-domain.example`

The admin and POS origins should not be publicized. Separate origins limit credential and browser-policy exposure.

### 2. Provision production infrastructure

Provision:

- one managed PostgreSQL database with encrypted storage, automatic backups, and restricted network access;
- one Node.js API service;
- three static frontend sites;
- one private secret store supplied by the hosting platform.

Do not place secrets in Git, frontend environment variables, build logs, or `VITE_*` variables.

For the API service use:

- build command: `npm ci && npx prisma generate && npm run build`
- migration/release command: `npx prisma migrate deploy`
- start command: `npm start`
- health check: `/api/health/ready`
- supported Node version: 22

Run migrations once per release before switching traffic to the new API version.

### 3. Generate independent secrets

Generate and store independent values for:

- `JWT_SECRET`: at least 32 random characters;
- `POS_SESSION_SECRET`: different from the JWT secret;
- `MFA_ENCRYPTION_KEY`: exactly 32 random bytes encoded as base64;
- `MPESA_C2B_CALLBACK_SECRET`: at least 32 random characters;
- `MPESA_STK_CALLBACK_SECRET`, if STK Push is enabled: a different secret.

Back up `MFA_ENCRYPTION_KEY` securely. Losing or changing it makes enrolled authenticator secrets and recovery-code hashes unusable. Never reuse it for JWTs or payment callbacks.

### 4. Configure the API

Set at minimum:

```dotenv
NODE_ENV=production
DATABASE_URL=postgresql://...
JWT_SECRET=...
POS_SESSION_SECRET=...
TRUST_PROXY_HOPS=1
MFA_ENCRYPTION_KEY=...
STOREFRONT_URL=https://www.your-domain.example
ADMIN_URL=https://admin.your-domain.example
POS_URL=https://pos.your-domain.example
```

Set `TRUST_PROXY_HOPS` to the exact number of trusted proxies between the internet and Express. Use `0` only if Express receives connections directly. An incorrect value can break rate limiting and audit attribution.

Configure Cloudinary server-side if owner product-image uploads are required.

Configure the M-Pesa values from `.env.example`. Set `MPESA_ENV=production` only when the live Daraja credentials and HTTPS callback are ready; the API will fail startup if the live C2B configuration is incomplete.

### 5. Deploy the API and migrate

1. Take and verify a database backup.
2. Deploy the new API artifact.
3. Run `npx prisma migrate deploy`.
4. Confirm migration `20261001000000_owner_mfa` was applied.
5. Check `GET /api/health`.
6. Check `GET /api/health/ready` returns HTTP 200 with `db: connected`.
7. Inspect startup logs for configuration errors without printing secret values.

Do not seed demo data in production.

### 6. Enroll the owner in MFA

On the first production admin login:

1. Enter the correct owner email and password.
2. The admin app will show an authenticator enrollment secret.
3. Add it to a TOTP authenticator.
4. Enter the current six-digit code.
5. Save the recovery codes offline in a protected password manager or secure physical location.
6. Acknowledge the recovery-code screen before entering the dashboard.
7. Log out and verify that password plus TOTP is required again.
8. Test exactly one recovery code and confirm the same code cannot be reused.

Never screenshot recovery codes into shared chat, email, or tickets.

### 7. Build and deploy each frontend

For storefront, admin, and POS set only:

```dotenv
VITE_API_URL=https://api.your-domain.example/api
```

Then run:

```sh
npm ci
npm run build
npm test
```

For the storefront also run `npm run lint`.

Publish each project's `dist/` directory to its own origin. Configure SPA fallback to `index.html`, but do not rewrite `/assets/*` or service-worker files to HTML.

If the host does not support `public/_headers`, copy those policies into that host's header configuration. Preserve `Cache-Control: no-store` for `index.html` and `no-cache` for the POS service worker.

### 8. Register and verify M-Pesa callbacks

Use the final API origin:

- STK callback, if used: `https://api.your-domain.example/api/orders/mpesa-callback`
- C2B confirmation: `https://api.your-domain.example/api/orders/c2b-callback`
- C2B validation: `https://api.your-domain.example/api/orders/c2b-callback/validation`

Register C2B through the authenticated owner operation only after DNS and TLS are live. Then perform the user's planned live M-Pesa tests with small controlled amounts and verify receipts, exact amounts, duplicate callbacks, unmatched-payment handling, and reconciliation.

### 9. Production smoke checks

Verify from a clean browser profile:

- storefront can load catalogue and create a checkout;
- an order cannot be tracked without its private tracking token;
- admin cannot enter without password plus MFA;
- logout makes the prior owner token unusable;
- POS approval produces only a short-lived POS session;
- offline POS permits cash only and revalidates stock/price on reconnect;
- unpaid M-Pesa sales cannot complete;
- product image upload rejects wrong type, wrong magic bytes, more than four files, and files over 5 MB;
- all four origins use valid TLS;
- static responses include CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and `Permissions-Policy`;
- API responses include Helmet headers and `Cache-Control: no-store`;
- readiness monitoring alerts when the database is unreachable.

### 10. Rollback

Keep the prior API and frontend artifacts available. If rollout fails:

1. stop new traffic to the failed API release;
2. redeploy the prior application artifact;
3. do not manually delete the MFA columns or migration record;
4. restore the database only for confirmed data corruption, using a verified backup and a rehearsed recovery process;
5. rotate any secret suspected of exposure and invalidate owner tokens.

## Current platform configuration: Render API + Cloudflare Pages storefront

### Render backend settings

Use the existing `gem-crystal-api` Render Web Service connected to the API repository's `main` branch.

Configure:

- runtime: Node;
- Node version: 22;
- build command: `npm ci && npx prisma generate && npm run build`;
- pre-deploy command: `npx prisma migrate deploy`;
- start command: `npm start`;
- HTTP health-check path: `/api/health/ready`;
- auto-deploy: only after the linked commit's CI checks pass.

Do not manually set `PORT`; Render supplies it. The API explicitly binds that port on `0.0.0.0`.

In Render's Environment page, add every production value documented in `.env.example`. In particular, the hardened release will refuse to start unless:

- `NODE_ENV=production`;
- JWT and POS session secrets are strong and different;
- `TRUST_PROXY_HOPS=1` for the normal single Render proxy boundary;
- storefront, admin, and POS origins are separate HTTPS origins;
- `MFA_ENCRYPTION_KEY` decodes to exactly 32 bytes;
- live M-Pesa C2B configuration is complete when `MPESA_ENV=production`.

The supplied Render logs confirm that the current deployed revision connected to PostgreSQL and started successfully. They also show only eight migrations; the hardened revision contains nine, including `20261001000000_owner_mfa`. After committing and pushing this work, inspect the Render deployment in this order:

1. verify the service is not suspended and inspect its latest Events/Deploy status;
2. inspect deploy logs for build, migration, missing-environment, or Prisma errors;
3. inspect runtime logs for database connection or startup failure;
4. trigger a manual deploy of the reviewed `main` commit;
5. confirm `/api/health` returns 200;
6. confirm `/api/health/ready` returns 200 and `db: connected`;
7. set the Render HTTP health check to `/api/health/ready`.

Free Render web services can spin down after inactivity and need a cold start on the next request. A service that still times out or never becomes ready must be resolved in the Render logs before storefront acceptance testing.

### Cloudflare Pages storefront settings

Use the existing Cloudflare Pages project connected to the storefront repository's `main` branch.

Configure:

- framework preset: Vite;
- production branch: `main`;
- build command: `npm ci && npm run build`;
- build output directory: `dist`;
- Node version: 22;
- `VITE_API_URL=https://gem-crystal-api-1.onrender.com/api` until a custom API domain replaces it;
- `VITE_ENABLE_DEMO_FALLBACK=false`.

The API URL is public configuration, not a secret. Never add JWT, Cloudinary, Daraja, database, MFA, or AI secrets to Cloudflare Pages variables.

Cloudflare Pages copies `public/_headers` into the deployment and applies those rules to static responses. The project has no top-level `404.html`, so Cloudflare Pages supplies its normal SPA fallback. After deploying, verify the actual response headers on the `pages.dev` URL and custom domain.

Cloudflare preview deployments use different origins. Do not weaken production CORS with a wildcard merely to make previews work. If an authenticated preview is needed, add one exact preview origin temporarily and remove it after testing.

When the storefront gets a custom domain, keep its exact origin in Render's `STOREFRONT_URL`, redeploy the API, and confirm CORS from the final Cloudflare domain.

Admin and POS still need explicit hosting decisions. If Cloudflare Pages is used for them, create separate Pages projects and separate HTTPS origins, set each project's `VITE_API_URL`, and update `ADMIN_URL` and `POS_URL` on Render.

## Remaining human-only gates

Coding and automated verification are complete for this pass. These gates require the owner or production environment:

1. Review and commit the changes in each repository.
2. Deploy the reviewed hardened API revision and verify that Render applies all nine migrations, including owner MFA.
3. Choose hosting and final HTTPS origins for the admin and POS applications.
4. Supply production secrets through the hosting secret manager.
5. Deploy and complete first-login owner MFA enrollment.
6. Run the planned live Daraja/M-Pesa payment tests.
7. Run browser-based acceptance testing of storefront, admin, and POS.
8. Later, test the physical barcode scanner, receipt printer, tablet/browser kiosk behavior, and network-loss recovery.
