# POS payment regression audit

## Scope and evidence

Reviewed the API callback registration, validation, C2B settlement, notification delivery, cashier completion and acknowledgements; the dedicated POS polling and popup; admin registration and unmatched-payment recovery; migrations and relevant history.

The reported references are GCPOSECE8C8 and GCPOSA5E9A6. The local POS uses the hosted Render API. Local database results cannot establish the state of these hosted sales. Supplied Render logs contain startup records only. Neither a verified production callback nor a production notification response has been captured for these references, so the specific live cause remains unproven.

## Relevant history

Commit ea50264 on 22 September removed unique-amount fallback matching. Automatic C2B settlement now requires an exact reference, exact amount, open sale and unexpired payment window. Reference-free Buy Goods payments go to Unmatched Payments for verified owner assignment. This can explain different behaviour compared with earlier tests, but does not explain an exact-reference callback without examining its payload and server outcome. Do not restore amount-only matching.

Cashier-scoped notification delivery remains in place: signing in again as the same cashier can recover unacknowledged alerts. Website order notifications intentionally do not appear on the cashier POS.

## Confirmed defects corrected

- Registration previously treated every HTTP-successful JSON response as provider success. It now checks ResponseCode before returning success or recording MPESA_C2B_REGISTERED.
- POS polling silently discarded HTTP/network errors and malformed responses while its device-online indicator could remain green. It now displays a warning and validates notification responses.
- Interval polling could accumulate stalled requests. Requests now time out after 15 seconds, retry three seconds after completion and cancel when a session changes.

## Verification

API unit suite and TypeScript build passed. POS tests (10) and production build passed. All 16 database integration tests passed against a freshly migrated, isolated PostgreSQL instance, including exact-reference callback delivery, receipt deduplication, cashier isolation, completion and acknowledgement. The initial approval-service interruption was resolved before running these tests. These tests verify the application flow but do not establish whether Daraja delivered the two reported hosted payments.

No shop payment was marked paid or acknowledged as part of this audit. Real Daraja delivery and the two reported sale records still require hosted evidence. Register from Admin > Unmatched Till Payments to use the hosted configuration and URL-encoded secret. Use the same app and shortcode for the sandbox simulation, with a fresh pending sale's exact reference and total. Safaricom instructs sandbox users to register URLs before each simulation: https://developer.safaricom.co.ke/apis/CustomerToBusiness

An isolated headless browser check also passed: mocked HTTP 503 responses display the warning, a recovered empty queue clears it, and a verified test notification renders the customer confirmation popup. All API calls in that browser were intercepted; this was not a real Daraja transaction.

Check [C2B diagnostic] arrival and completion in Render, then PAYMENT_CONFIRMED or PAYMENT_REQUIRES_REVIEW in the owner audit log. A processed diagnostic alone does not distinguish settlement from review or an idempotent replay. Inspect Unmatched Payments if the callback was processed without a popup. POS polling warnings separately identify unavailable notification delivery.
