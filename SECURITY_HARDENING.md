# Gem & Crystal Fashion Hub — Security & Operations Reference

This document is the authoritative reference for security controls, deployment
procedures, and operational practices. Keep it up to date as the system evolves.

---

## Authentication & authorisation

- JWT signed with `JWT_SECRET` (required at startup — server refuses to start without it).
- Tokens include `issuer: gem-crystal-api` and `audience: gem-crystal-admin` claims;
  tokens issued by other services are rejected.
- Token lifetime: 12 hours. Logout via `POST /api/admin/logout` instructs the client
  to discard the token. Full server-side revocation via session records is a Phase 5 item.
- Admin login validates email format and password length with Zod before hitting the DB.
- bcrypt constant-time comparison prevents timing-based account enumeration.
- Login rate-limited: 10 requests / 15 min per IP.

## POS session security

- Cashier PIN verified with bcrypt (minimum 4 digits, digits-only enforced by Zod).
- PIN auth rate-limited: 5 failed attempts / 5 min per IP.
- POS login requires owner real-time approval via `POST /api/pos/approve-request`.
- Session token derived with HMAC-SHA256 and stored only as SHA-256 hash — never plaintext.
- One active session per cashier; approving a new login ends the previous session.
- Explicit logout via `POST /api/pos/logout` immediately ends the session in the database.
- Default `pinCode` is an empty string — a PIN must be explicitly set for every new account.

## Inventory integrity

- POS stock deduction uses `UPDATE ... WHERE stockQuantity >= qty RETURNING stockQuantity`
  — atomic, prevents overselling under concurrent load, returns verified new stock.
- Manual stock adjustments also use atomic SQL with the same guard.
- Negative adjustments that would take stock below zero return HTTP 400 — never silently clamped.
- Every stock change creates an `InventoryMovement` record using DB-verified values (not stale reads).
- Every manual adjustment creates an `AuditLog` record with actor, IP, before/after quantities, and reason.

## Payment safety

- Server calculates all prices, discounts, and totals — browser-supplied amounts are ignored.
- CARD payments rejected before any transaction until a card gateway is integrated.
- M-PESA configuration checked before any transaction — no stock deducted if M-PESA is unavailable.
- M-PESA idempotency key written to DB before calling Safaricom (optimistic correlation).
- Network timeout leaves payment as `PENDING_CORRELATION` — callback can still arrive and match.
- Definitive Safaricom rejection atomically marks payment FAILED and restores stock.
- Duplicate M-PESA callbacks are safely ignored (idempotent payment confirmation).
- All monetary fields stored as `DECIMAL(10,2)` — no floating-point drift.

## M-PESA callback security

- Callback URL secret verified with `crypto.timingSafeEqual` before processing any payload.
- Zod schema validates callback structure.
- CheckoutRequestID, MerchantRequestID, amount (±0.01), and phone number all verified.
- Mismatched payments left PENDING for owner review (not silently failed).

## API security

- `helmet()` sets secure HTTP headers.
- `cors()` whitelists only configured origins (`STOREFRONT_URL`, `ADMIN_URL`, `POS_URL`).
- `express-rate-limit` on login, checkout, and AI endpoints.
- `trust proxy: 1` in production so rate limiters read real client IPs via X-Forwarded-For.
- Request body size limited to 5 MB JSON, 16 KB URL-encoded.
- Server timeouts configured (30 s request, 35 s headers, 5 s keep-alive).
- `x-powered-by` disabled.

## Domain events

- All `eventBus.emit()` calls are outside `prisma.$transaction()` closures.
- Event listeners are wrapped in `try/catch` — a failed listener can never roll back a payment.
- Phase 1: structured logging. Phase 2: WhatsApp / receipt dispatch.

---

## Development setup

```bash
# Install dependencies
npm install

# Generate Prisma client
npx prisma generate

# Apply schema to a local PostgreSQL database
npm run db:migrate:deploy    # production-safe migration deploy
# OR for first-time dev setup:
npm run db:push              # schema push (dev only, not for production)

# Seed development data (REFUSED in NODE_ENV=production)
npm run db:seed:dev

# Start dev server
npm run dev
```

## Production deployment

```bash
# After pulling new code:
npx prisma migrate deploy    # applies committed migrations safely
npm run build                # compile TypeScript
npm start                    # start production server
```

**Never run `npm run db:seed:dev` or `npx prisma db push` against a production database.**

---

## Environment variables

All secrets live in `.env` (never committed to Git).

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `JWT_SECRET` | ✅ | Long random string for JWT signing |
| `POS_SESSION_SECRET` | ✅ | Long random string for POS token derivation |
| `PORT` | optional | API port (default 4000) |
| `NODE_ENV` | optional | `production` or `development` |
| `STOREFRONT_URL` | production | CORS origin for storefront |
| `ADMIN_URL` | production | CORS origin for admin panel |
| `POS_URL` | production | CORS origin for POS terminal |
| `MPESA_ENV` | optional | `sandbox` or `production` |
| `MPESA_CONSUMER_KEY` | M-PESA | Daraja API consumer key |
| `MPESA_CONSUMER_SECRET` | M-PESA | Daraja API consumer secret |
| `MPESA_SHORTCODE` | M-PESA | Daraja business short code |
| `MPESA_PASSKEY` | M-PESA | Daraja STK push passkey |
| `MPESA_CALLBACK_URL` | M-PESA | Public HTTPS URL for Daraja callbacks |
| `MPESA_CALLBACK_SECRET` | M-PESA | High-entropy secret bound to this installation |
| `AI_PROVIDER` | AI chat | `openrouter` or `openai` |
| `AI_API_KEY` | AI chat | API key (backend only — never in frontend) |
| `AI_MODEL` | AI chat | Model ID (e.g. `minimax/minimax-m3:free`) |
| `CLOUDINARY_CLOUD_NAME` | uploads | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | uploads | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | uploads | Cloudinary API secret |

Copy `.env.example` and fill in real values. Never commit `.env` to Git.

---

## Health endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /api/health` | Liveness — server is running |
| `GET /api/health/ready` | Readiness — server + database connected |

Use `/api/health/ready` for deployment health checks and container probes.

---

## Credentials policy

- No default passwords or PINs in production. The seed script refuses to run with `NODE_ENV=production`.
- Rotate `JWT_SECRET` and `POS_SESSION_SECRET` when staff leave.
- Rotate M-PESA keys if `MPESA_CALLBACK_SECRET` is ever exposed.
- AI API key lives only in server `.env` — never in frontend environment variables.
- `.env`, `.env.local`, and `.env.production` are listed in `.gitignore`.

---

## Audit trail

Every sensitive operation creates an `AuditLog` record:

```
LOGIN, LOGOUT, POS_LOGIN_REQUESTED, POS_LOGIN_APPROVED, POS_LOGIN_DENIED,
INVENTORY_ADJUSTED, SALE_CREATED, PAYMENT_CONFIRMED, PAYMENT_FAILED,
PAYMENT_PENDING, ORDER_STATUS_UPDATED, POS_LOGOUT
```

Owner can query audit logs via `GET /api/pos/audit-logs` (OWNER role required).
