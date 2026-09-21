# Sandbox callback investigation — 22 September 2026

## Confirmed application state

Three successful POS payments on 21 September at 17:09:04, 17:10:08 and 17:19:38 UTC have payment audit records and acknowledged notifications. Later pending sales have neither confirmation records nor new unmatched-payment records. Historical callback arrival logs were not available, so the exact cause of those earlier missing callbacks remains unproven.

The configured public tunnel reaches the API. A side-effect-free POST through that tunnel to the validation route returned HTTP 200 / ResultCode 0 using the configured callback secret. Both callback URLs were re-registered directly from the backend configuration, with Daraja returning success.

## Controlled provider tests

- C2B v2 Buy Goods, shortcode 600986, amount 1, empty BillRefNumber: HTTP 500, error 500.003.1001, “The element AccountReference is invalid.” Request ID: 4426-4a98-a19b-8547d21fdadc7786.
- Same Buy Goods test with diagnostic reference DIAG-BUYGOODS: same error. Request ID: e7ff-4172-9bbe-7c6927a3b9db37648.
- PayBill v2 control, diagnostic reference DIAG922: HTTP 403, Incapsula security page. Incident ID: 1780000750033586630-41334546330030841.
- No provider callback arrival appeared in the new diagnostic log during these tests. Only the deliberate validation probe appeared.

These errors are external responses, not POS rendering errors. They do not prove that every earlier accepted simulation failed for the same reason. API request acceptance alone is not evidence of callback delivery. Do not bypass provider security controls or mark a sale paid manually to force a popup.

## Diagnostic logging

src/middleware/callbackDiagnostics.ts records request arrival and completion, request correlation, HTTP status, and handler outcome. It runs before CORS and JSON parsing. Query strings, secrets, customer phone numbers and payloads are excluded. Output goes to the API console and ignored logs/mpesa-callbacks.ndjson. This local diagnostic file needs normal operational rotation/retention before production deployment.

Build and diagnostic redaction test passed. Payment settlement rules are unchanged by this diagnostic patch.

## Next decisive test / provider escalation

Use the Daraja portal with the application's assigned Buy Goods sandbox shortcode and command. Confirm with Safaricom that shortcode 600986 supports CustomerBuyGoodsOnline and what reference format its simulator requires. Supply the above request/incident IDs if the error persists; never supply consumer secrets or callback tokens. Keep the current tunnel running. Correlate the exact simulation time with logs/mpesa-callbacks.ndjson before making another configuration change.

A valid callback that reaches the app will now show whether it was rejected for a secret, payload, shortcode, middleware, or processing error. A provider-accepted request with no arrival requires investigation of provider delivery/registered routing, rather than changes to the popup.

## Buy Goods launch requirement

A real customer-initiated Buy Goods payment does not carry a cashier-entered POS sale reference. The current app sends reference-free payments to owner reconciliation, and creates the POS popup after assignment. That is separate from callback delivery. Before launch, agree and test a cashier workflow for selecting and confirming the actual incoming payment, with server-side one-time assignment and protection against two same-amount sales. Do not restore blind amount-only automatic matching.

Launch acceptance: real delivery on a stable registered HTTPS address; multiple consecutive Buy Goods tests; same-amount competing sales; duplicate callbacks; delayed callbacks/expired sales; terminal reconnect; no double stock deduction or receipt reuse. Live verification still requires the business's enabled production Till/C2B configuration.
