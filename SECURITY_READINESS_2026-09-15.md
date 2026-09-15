# Gem & Crystal production security readiness review

Reviewed: 2026-09-15

## Executive summary

The codebase already has a solid first application-layer baseline: strict request schemas for critical flows, server-side role checks, restricted CORS, HTTPS enforcement for production M-PESA callbacks, rate limits, request-size limits, Helmet, safe error responses, hashed POS-session tokens, and transactional stock/payment handling. Production dependency audits report no known vulnerabilities in the installed production dependency trees.

It is **not ready for an unattended public launch** until the high-priority identity, hosting, operations, and live-payment items below are completed and tested. This report intentionally separates code findings from controls that can only be configured in the chosen hosting platform.

## High priority

### SEC-001 — Owner bearer tokens cannot currently be revoked server-side

**Status: fixed in the current API change; deploy the migration before relying on it.**

- Rule ID: REACT-AUTH-001 / EXPRESS-SESS-002
- Severity: High
- Location: `src/middleware/auth.ts:85-90`; `src/routes/admin.ts:176-185`
- Evidence: owner JWTs are issued for 12 hours, while `/api/admin/logout` only returns an instruction for the browser to discard the token.
- Impact: a copied owner token remains usable until expiry even after logout, password reset, or a suspected stolen device.
- Fix: add a server-side token-version (or session) field to the owner identity; include it in issued JWTs; reject mismatches; increment it at logout and when the owner forces sign-out. This is the first focused code fix.
- Mitigation: use a separate owner device and change the owner password immediately if a device is lost until the fix is deployed.

### SEC-002 — POS bearer token is persisted in browser local storage

**Correction after tracing the live POS entry point:** the active terminal (`src/components/pos/PosTerminal.tsx`) keeps its cashier session only in React memory. The cited local-storage code belongs to an unused legacy dashboard path, so it is not an active terminal exposure; it should still be removed before launch to prevent accidental reuse. The active POS now auto-locks after ten minutes of user inactivity (POS commit `229e39a`).

- Rule ID: REACT-AUTH-001 / JS-STORAGE-001
- Severity: High
- Location: `../gem-crystal-pos/src/context/AuthContext.tsx:21-54`; `../gem-crystal-pos/src/api/adminApi.ts:4-6`
- Evidence: `gc_admin_token` is persisted in `localStorage` and reused after browser restart.
- Impact: any JavaScript execution on the POS origin, or physical access to an unlocked terminal profile, can reuse the token until its server expiry.
- Fix: launch the POS on a dedicated managed tablet/PWA, set a short inactivity lock, and move sensitive identity state away from persistent browser storage. The robust version uses server-managed, HttpOnly sessions with CSRF protection; it must be introduced with a dedicated POS sign-in/lock-screen test so cashiers are not interrupted mid-sale.
- Mitigation: use a separate browser/device profile for POS, OS screen lock, individual cashier accounts, and a short POS session policy.

### SEC-003 — MFA and emergency owner-device revocation are not implemented

- Rule ID: EXPRESS-AUTH-001
- Severity: High
- Location: `src/routes/admin.ts:118-174`; `prisma/schema.prisma:168-176`
- Evidence: the owner login is password-only. There is no MFA enrolment, recovery process, trusted-device list, or emergency global sign-out.
- Impact: a phished or reused owner password could give a criminal full control of stock, prices, refunds, order overrides, and financial reports.
- Fix: add app-based MFA (TOTP), recovery codes, individual accounts, and a force-sign-out control. Do not share the owner account with staff.

## Medium priority

### SEC-004 — Security headers for the Admin and POS static apps depend on hosting configuration

- Rule ID: REACT-HEADERS-001 / REACT-CSP-001
- Severity: Medium
- Location: `../gem-crystal-admin/index.html:1-16`; `../gem-crystal-pos/index.html:1-16`
- Evidence: both are static Vite SPAs. No deploy/edge configuration is present in the repositories to set a production CSP, anti-framing policy, referrer policy, or source-map policy.
- Impact: the browser apps will rely solely on the hosting platform’s defaults unless configured during deployment.
- Fix: deploy each app behind HTTPS with response headers at the edge: CSP, `X-Content-Type-Options: nosniff`, `frame-ancestors 'none'` / `X-Frame-Options: DENY`, a conservative referrer policy, and a permissions policy. Test the headers on the live URLs before launch.
- False-positive note: the API already uses Helmet in `src/index.ts:22-32`; the static app hosts still need their own equivalent headers.

### SEC-005 — Production proxy trust must match the selected host

- Rule ID: EXPRESS-PROXY-001
- Severity: Medium
- Location: `src/index.ts:24-28`
- Evidence: production sets `trust proxy` to one hop.
- Impact: if the final hosting chain has more/fewer proxies or does not overwrite forwarded headers, client-IP rate limits may be incorrect.
- Fix: confirm the chosen hosting provider’s proxy topology and set the trust value exactly once during deployment. Do not make it `true`.

### SEC-006 — Live M-PESA callback URL and secrets are production operations, not a completed code check

- Rule ID: EXPRESS-INPUT-001 / EXPRESS-ERROR-001
- Severity: Medium
- Location: `src/services/mpesa.ts:18-35`; `src/services/mpesaC2B.ts:106-133`; `src/routes/orders.ts:425-545`
- Evidence: the code validates the configured callback secret and HTTPS in production, but no permanent deployed API URL, live Daraja credentials, or live callback registration is present in version control (correctly).
- Impact: a temporary tunnel cannot be treated as production payment infrastructure.
- Fix: use a permanent HTTPS API domain, secrets manager, live Daraja credentials, rotation of previously exposed sandbox credentials, callback registration, then controlled real Till verification with reconciled logs.

## Launch operations (not visible in application code)

1. Separate HTTPS domains: `shop`, `api`, `admin`, and `pos`.
2. Managed PostgreSQL with automated backups, retention, and a tested restore.
3. Uptime/error alerts for API readiness, database, failed callbacks, unmatched payments, and outstanding orders.
4. A secure scheduled call to expire stale pending POS sales.
5. CI deployment using `npm ci`, build checks, and a production migration step. Do not seed demo data in production.
6. Password manager + unique owner password; individual cashier accounts; OS lock on POS tablet.

## Verified during this review

- Production dependency audits were clean for API, storefront, Admin, and POS (`npm audit --omit=dev`).
- The API disables `X-Powered-By`, uses Helmet, sets explicit CORS allow-listing, request-size limits, timeouts, error handling, and rate limits (`src/index.ts:22-120`).
- Protected admin actions are enforced on the API with `requireAdmin` and role checks, not merely hidden in the user interface (`src/middleware/auth.ts:31-82`).
- POS sessions are stored hashed server-side and payment notifications are scoped to the active cashier session (`src/routes/pos.ts:203-321`).

## Installable apps

Admin and POS are currently Vite browser applications, not installable apps. They should launch as **installable PWAs** on their own HTTPS origins:

- Admin: owner’s phone/desktop app with online-only operational data.
- POS: dedicated shop tablet/desktop app; cache only static files, never sales, payment notifications, customer data, or authenticated API responses.

This gives app-like installation, full-screen use, controlled updates, printer/scanner browser integration, and one shared codebase. Native Android APK/iOS-store packaging is not required for the initial shop launch and should not be used as a substitute for backend security.
