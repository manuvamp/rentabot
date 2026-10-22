# PayPal sandbox run (2026-10-19)

The real server ran against the real PayPal sandbox (app "Rent-A-Bot", platform business `sb-jx6wj25311300@...`,
buyer `orano-buyer@...`), port 8791, `DEMO_MODE=1`, `DEMO_TIME_SCALE=30`, house bots on, seller payout email
`glob-payouts@...` (set with `SEED_PAYOUT_EMAIL`, see `.env.example`). No public webhook URL, so every state
below was committed from PayPal's synchronous answer and the reconciler path, not from webhooks.

Every amount in the ledger (`get_escrow`) was compared with direct PayPal reads (`GET /v2/payments/authorizations/{id}`,
`/v2/payments/captures/{id}`, `/v2/checkout/orders/{id}`, `/v3/vault/payment-tokens/{id}`). All matched.
`/v1/reporting/transactions` returned 0 items (its index was hours behind in the sandbox), so it was not usable as a cross-check.

## Results per flow

| flow | result |
|---|---|
| Approval-link funding (no mandate) | PASS. `fund_job` -> `AWAITING_APPROVAL` + `checkoutnow` URL; buyer logged in and approved in Brave; the return URL authorized the order; job `IN_PROGRESS`. |
| Accept: one final capture + void remainder | PASS. Final capture of the verified $24.00 (`final_capture=true`), remaining $6.00 released; PayPal shows authorization `CAPTURED`, capture `COMPLETED`. |
| Vault mandate (setup token -> approve -> payment token) | PASS after a fix (see below). Mandate went `active`, payment token stored. |
| Mandate funding with no human click | PASS. Order with `vault_id` + `stored_credential` is `COMPLETED` with an authorization `CREATED` in the same response. |
| Dispute settled by agreement (split) | PASS. Buyer countered $21/$9, seller accepted: capture $21.00 + remainder $9.00 released. |
| Dispute settled by agreement (redo) | PASS (partial capture, then void). $20.00 captured with `final_capture=false`, $10.00 held for 4 units; the seller redelivered the same 16 units, so the held $10.00 was voided; PayPal authorization `VOIDED`. The "held amount captured after redo" branch was not reached (the bot did not deliver the 4 extra units). |
| Duplicate `fund_job` with the same idempotency key | PASS. One order, one authorization at PayPal and in the ledger; a different key on a funded job is `invalid_state`. At rail level, replaying `POST /v2/checkout/orders` with the same `PayPal-Request-Id` returned the same order and the same authorization. |
| `reauthorize` | Refused by PayPal inside the honor period: 422 `REAUTHORIZATION_TOO_SOON`, "only allowed once from Day 4 to Day 29 since the date of the original authorization". The success path cannot be tested in a sandbox run shorter than 3 days. |
| Refund | Partial refund of a $1.00 capture ($0.40) at rail level: 201, `COMPLETED`, capture then `PARTIALLY_REFUNDED`; over-refund is 422 `REFUND_AMOUNT_EXCEEDED`. A job-level capture-and-hold run was not reachable (needs a job that outlives the 29-day authorization, and deadlines are set by the platform). |
| Seller payout (Payouts API) | **BLOCKED on the old India app. RESOLVED on the US app: see "US sandbox app on production (2026-10-19/20)" at the end.** |

## Blocker (RESOLVED 2026-10-19 with the "Rent-A-Bot US" app): Payouts are refused for the platform sandbox account

Resolved: production now runs on a US sandbox business account (`sb-bma5u50160933@business.example.com`, app "Rent-A-Bot US").
Seller payouts reach `SUCCESS` with a real `payout_item_fee` of $0.25; the evidence is in the last section. The text below
is what the India account answered and is kept as history.

`POST /v1/payments/payouts` answered 403 `PAYOUT_NOT_AVAILABLE`: "You live in a country that is not allowed to send this payout."
The default sandbox business account the app is linked to was created in India (the developer account's country), and
PayPal does not let Indian accounts send Payouts (as already predicted in `ESCROW_PAYPAL.md`). The request shape passed
PayPal's validation (no `INVALID_REQUEST`), but nothing past that check could be verified: payout success, the
`payout_item_fee` actually charged, `GET /v1/payments/payouts/{batch_id}` and the reconciler's SUCCESS path.

To fix (needs a login I did not have): in developer.paypal.com > Sandbox > Accounts create a **US** Business account, make
it the platform account of a REST app, put that app's client id/secret in `.env.paypal`, and rerun a job. The password saved
for the developer account (hello@oranoai.com) was rejected by PayPal, so I stopped after one attempt.

All seller payouts in the five jobs therefore stayed `payout_failed` in the ledger and are retried by the scheduler
(`paid_out` = 0.00); the captured money is intact. Jobs: see the table below, owed payouts $20.40, $20.40, $17.85, $17.00, $20.40.

## PayPal ids and amounts

All amounts USD. Ledger = `get_escrow`; PayPal = direct read. Commission = Rent-A-Bot 15%, floor $3.00.

| job | order | authorization | capture | authorized | captured | released (void) | PayPal fee (actual) | net to platform | commission | seller owed |
|---|---|---|---|---|---|---|---|---|---|---|
| J1 approval link | `2JE572787N379154F` | `0XJ7579338987900P` | `40V62466RS7358430` (final) | 30.00 | 24.00 | 6.00 | 1.46 | 22.54 | 3.60 | 20.40 |
| J2 mandate | `37W895973K3218408` | `200544217T969633J` | `6WL53362JB802994X` (final) | 30.00 | 24.00 | 6.00 | 1.46 | 22.54 | 3.60 | 20.40 |
| J3 split by agreement | `9YG7275591804260V` | `0NY19342LG672501X` | `40D98436TM648853D` (final) | 30.00 | 21.00 | 9.00 | 1.32 | 19.68 | 3.15 | 17.85 |
| J4 redo by agreement | `3XN95163M46222937` | `858387263V036471V` | `65U325533H543622D` (`final_capture=false`) | 30.00 | 20.00 | 10.00 (void) | 1.27 | 18.73 | 3.00 | 17.00 |
| J5 duplicate fund_job | `59J82633NF833902U` | `85671821UU353491T` | `90Y42286KR9741916` (final) | 30.00 | 24.00 | 6.00 | 1.46 | 22.54 | 3.60 | 20.40 |

Vault: setup token `2PD32765563386942` (approval at `.../agreements/approve?approval_session_id=...`), payment token `84u012580l311302c`,
payer `orano-buyer@...`. Jobs J1 to J5: `job_mvf7wskr1CD26bFvnKS43Y`, `job_mvf872joG231X1A3Wxx4nJ`, `job_mvf88efqT8JyMTdsDZhWV2`,
`job_mvf8ai87GdJwRkasn9HSRG`, `job_mvf8e1wvDf7vwnr3x52b6H`.

Rail-level probe (a $2.00 mandate order, 2 captures, 1 refund; a $3.00 order voided): orders `8W69101996099953N`,
`18328088JS9198142`; authorizations `68H765627W255101E` (captured $1.00 non-final + $0.60 final, remainder released),
`83Y18663LJ7939742` (voided); captures `5UH39373F32858345` ($1.00, fee 0.40), `4T865551EB096082G` ($0.60, fee 0.38);
refund `8P866808FB8214405` ($0.40). Void twice: 422 `PREVIOUSLY_VOIDED`; capture after void: `AUTHORIZATION_VOIDED`; capture after a
final capture: `AUTHORIZATION_ALREADY_CAPTURED`; void after capture: `PREVIOUSLY_CAPTURED`.

## Actual fees vs the estimate

Estimate in `fees.ts`: 3.49% + $0.49 per capture, $0.25 per payout.

| capture | estimate | actual |
|---|---|---|
| $24.00 | 1.33 | 1.46 |
| $21.00 | 1.22 | 1.32 |
| $20.00 | 1.19 | 1.27 |
| $1.00 | 0.52 | 0.40 |
| $0.60 | 0.51 | 0.38 |

The sandbox charges about 4.7% + $0.34 (fit through these five points), so its per-capture fee is higher than the estimate above roughly $10 and lower
below it. The sandbox fee follows the (Indian) merchant account, so treat it as a sanity check, not as the production price. With the
actuals, platform net on a $24.00 settlement is $3.60 - $1.46 - $0.25 (payout fee, estimated, unverified) = $1.89, above the $1.00 minimum margin.
Fees are recorded from `seller_receivable_breakdown.paypal_fee` in the capture response itself (no extra call) and the ledger note shows them.
The actual `payout_item_fee` is still unknown (blocked above).

## What was fixed

1. `server/src/rails/paypal.ts`: **vault setup token request** was rejected (422 `MUTUALLY_EXCLUSIVE_FIELDS_PROVIDED` on
   `/payment_source/paypal/experience_context`): `user_action` and `vault_instruction` cannot be sent together. Now only `user_action: CONTINUE`.
   Without this fix no mandate could ever be created on PayPal.
2. Same file: the `[unverified]` marker on `stored_credential` is removed (verified: vaulted order authorizes without a click and PayPal echoes it).
   Added hints for the real issue names `REAUTHORIZATION_TOO_SOON` (the old key `REAUTHORIZE_TOO_EARLY` never matched) and `PAYOUT_NOT_AVAILABLE`.
3. `server/src/core/escrow.ts` + `server/src/core/index.ts`: a failed payout was retried **every scheduler tick (3 s)** and wrote one ledger
   event per attempt (37 events and 37 PayPal calls in two minutes). Now retries are at most every 30 s and an identical repeated failure
   refreshes the existing `payout_failed` event instead of adding another.
4. Tests: `server/test/core/rails-paypal.test.ts` (7 new tests with real response shapes, ids and emails faked: setup token, the rejected
   shape, vaulted order, final capture with fee, reauthorize refused, payout refused, state-change errors), `server/test/core/flows.test.ts`
   (payout back-off and de-duplication). `npx vitest run` in `server/`: 329 passed, 2 skipped. (`tsc` reports one pre-existing error in
   `test/adapters/stub-core.ts`, `units_verified` missing, unrelated.)

## Still unverified

(Updated 2026-10-19/20: payouts end to end and webhook delivery are now verified on production, see the last section.)

- ~~Payouts end to end: `POST /v1/payments/payouts` success body, `GET /v1/payments/payouts/{batch_id}` item shape and `sender_item_id`
  lookup, `payout_item_fee`, payout `SUCCESS` through the reconciler (blocked, see above).~~ Verified on the US app.
- ~~Webhooks: `verify-webhook-signature` and every webhook-driven path (no public URL, `PAYPAL_WEBHOOK_ID` unset).~~ Verified on production for
  `VAULT.PAYMENT-TOKEN.CREATED`, `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` and `PAYMENT.PAYOUTSBATCH.SUCCESS` (ignored by design).
- Reconciler for captures: captures completed synchronously, so the pending-capture branch only has `GET /v2/payments/captures/{id}`
  verified at rail level (returns the same fields as the capture response).
- `reauthorize` success (needs day 4+), a held redo amount captured after the seller delivers, capture-and-hold mode at job level,
  Disputes API, Invoicing, PENDING captures, `refundCapture` through the escrow service.
- The approval-link page for vault setup (`/agreements/approve`) rendered only "Loading" in a background Brave tab on the first two
  loads and worked on the third; a human opening the link should not be affected.

## US sandbox app on production (2026-10-19/20)

Run against https://rentabot.tech (release of commit `8d475a2`, later `a15cbf8`): PayPal sandbox app "Rent-A-Bot US" with a US business
platform account (`sb-bma5u50160933@business.example.com`, Payouts and Vault on), GCE VM, PayPal calls through the egress Worker,
`DEMO_MODE=1`, `DEMO_TIME_SCALE=60`, house bots on, seller payouts to the sandbox personal account `glob-payouts@personal.example.com`.
Buyer agent: ORANO Growth Agent. The PayPal webhook is registered for `https://rentabot.tech/api/paypal/webhook`.

Every id and amount below was read straight from PayPal (from a PC with IPv4, with the app's own credentials: `GET /v2/checkout/orders/{id}`,
`/v2/payments/authorizations/{id}`, `/v2/payments/captures/{id}`, `/v1/payments/payouts/{batch}` and `/v1/payments/payouts-item/{id}`)
and compared with the production ledger (`get_escrow`). All matched. All money is sandbox money.

### Results per flow

| flow | result |
|---|---|
| Vault mandate (`request_mandate`, ORANO agent: $200/month, $70 per job, `real_world_action` + `reach`) | PASS. PayPal approval page opened in Brave, logged in as `orano-buyer@...`, "Save and Continue"; the return URL put the mandate in `active` on production (`mdt_mvfiikqgysCNZK4HHP58hd`, setup approval session `1XN63533F7431560R`). The `VAULT.PAYMENT-TOKEN.CREATED` webhook arrived and was verified. |
| Job 1: Directory Blaster, funded by the mandate, one cure round, accept | PASS. `fund_job` -> `IN_PROGRESS` with no click, authorization `CREATED` in the same response. 16 of 20 listings passed, final capture $24.00, remainder $6.00 released, seller payout `SUCCESS`. |
| Job 2: same job, then a dispute settled by agreement through the mediator | PASS. Mediator proposal `prp_e8b013fe2859aa90` (split: release $24.00, refund $6.00); the house seller bot accepted, the buyer accepted, the proposal executed: one final capture, void, payout `SUCCESS`. |
| Job 3: Agent-Readiness Auditor ($9.00, class `code`, outside the mandate) funded by approval link | PASS for funding: `fund_job` -> `AWAITING_APPROVAL` + `checkoutnow` URL; approved in Brave as `human-buyer@...`; the return URL (`/jobs/<id>?paypal=approved`) authorized the order and the job went `IN_PROGRESS`. The job then paid nothing because of a bug in the bot (see "Bugs found and fixed"): authorization voided, `VOIDED` at PayPal, no capture, no payout. |
| Job 4: the same audit re-run after the fix | NOT COMPLETED. The fix is deployed and the job reached `AWAITING_APPROVAL`, but the Playwright extension in Brave dropped its connection to the broker and did not come back, so nobody approved the $9.00 authorization. See "Open items". |
| Webhooks on production | PASS. Delivered and signature-verified: `VAULT.PAYMENT-TOKEN.CREATED`, `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`, `PAYMENT.PAYOUTSBATCH.SUCCESS` (ignored by design). The reconciler had already confirmed the payout 1 to 2 s after it was sent, so the webhook found it applied and did not double count (`paid_out` stayed $20.40). |
| Live Log in with PayPal | PASS on 2026-10-20 after the PayPal app settings were saved: first sign-in, second sign-in (same account) and cancel. See "Log in with PayPal". |

### PayPal ids and amounts (USD)

| | job 1 (mandate) | job 2 (split by agreement) | job 3 (approval link, voided) |
|---|---|---|---|
| job | `job_mvfinas5s0EMVGdkbqtJAA` | `job_mvfirb82f2jfW7stQpDGHQ` | `job_mvfj0cljYeg5hbTf2wba0W` |
| order | `8VE49848ST682903G` | `23W08401US483860U` | `1CV35613W8696382T` (payer `human-buyer@...`) |
| authorization | `5M7484925C181390X` $30.00, `CAPTURED` | `20864954PX097150X` $30.00, `CAPTURED` | `6C763484V55776206` $9.00, `VOIDED` |
| capture | `2LA45707YP5043115` $24.00, `final_capture=true` | `0VW3975536792884Y` $24.00, `final_capture=true` | none |
| voided (released to buyer) | 6.00 | 6.00 | 9.00 |
| PayPal fee on the capture (`seller_receivable_breakdown.paypal_fee`) | 1.33 (net 22.67) | 1.33 (net 22.67) | n/a |
| commission (15%, $3 floor) | 3.60 | 3.60 | n/a |
| payout batch | `7C23RD5WWA75C` | `2TG9S9UL5HRWC` | none |
| payout item (txn) | `4ZC6NZKTKSCP2` (`5Y769545LX753945E`) | `UZUS96SFQZJUS` (`3E490371K76182326`) | none |
| payout to `glob-payouts@...` | 20.40, item `SUCCESS`, batch `SUCCESS` | 20.40, item `SUCCESS`, batch `SUCCESS` | n/a |
| **`payout_item_fee` (actual)** | **0.25** | **0.25** | n/a |
| platform net (commission - capture fee - payout fee) | 3.60 - 1.33 - 0.25 = **2.02** | **2.02** | 0.00 |

Platform net check at the account level: capture net $22.67 in, $20.40 payout plus $0.25 payout fee out, $2.02 left, as computed.
`/v1/reporting/balances` answers 403 for this app, so the account balance itself could not be read.

### Payouts: resolved

On the US platform account `POST /v1/payments/payouts` is accepted (the India account was refused with `PAYOUT_NOT_AVAILABLE`). The batch was
`PROCESSING` at the first read and `SUCCESS` seconds later; the item carries `payout_item_fee` $0.25, `sender_item_id` `<job>-p1` and
`sender_batch_id` `<job>:payout:1`. The reconciler (`GET payout batch`) moved both ledger payouts to `payout_succeeded`.

### Actual fees vs the estimate

Estimate in `fees.ts`: 3.49% + $0.49 per capture, $0.25 per payout.

| | estimate | actual |
|---|---|---|
| capture of $24.00 | 1.33 | 1.33 |
| payout item | 0.25 | 0.25 |

Both match to the cent on the US account (the earlier India-account run saw 1.46 on the same capture, so that account's fee schedule was
the outlier). Platform net on a $24.00 settlement is $2.02, above the $1.00 minimum margin. The $3.00 commission floor
(a job whose 15% is below $3.00, for example a $9.00 capture: fee about 0.80, payout fee 0.25, net about 1.95) was not reached by a completed job,
because job 3 paid nothing and job 4 is not completed; it is covered by the unit tests only.

### Log in with PayPal

**Fixed 2026-10-20.** "Log in with PayPal" is now enabled on the "Rent-A-Bot US" sandbox app with the Return URL
`https://rentabot.tech/api/auth/paypal/callback`, the profile items Full name, Email and Account verification status, and the privacy and
user agreement links. The old Return URL was PayPal's default `nativexo://paypalpay`, which explains every `invalid_redirect_uri` below.
The token endpoint now answers `invalid_authz_code` for a bogus code with our callback (it passes the redirect check) and still
`invalid_redirect_uri` for any other URI. Live run in Brave as `human-buyer@personal.example.com`, default scopes
(`openid profile email https://uri.paypal.com/services/paypalattributes`):

| Test | Result |
| --- | --- |
| First sign-in | PASS. PayPal sandbox login, consent page listing full name, email and account verification status, "Agree and Connect", back on `/account?welcome=1`: "Human Buyer", the buyer's email, badges "PayPal verified" and "email confirmed", payout email pre-filled, agent `agt_mvftsjmb3YT1TPdWmb3HER`, "Welcome! Your agent is ready." |
| Second sign-in after Sign out | PASS. PayPal's remembered-account page (Continue, no password, no consent page), back on `/account`: the same account and the same agent id, no duplicate, no welcome banner. |
| Cancel | PASS. The close link on PayPal's page returns to the callback with `action=cancel`; `/account?login_error=denied` says "You cancelled on PayPal. Nothing was shared." and shows the signed-out state. |

The diagnosis from before the fix (2026-10-19) follows.

Result: the live sign-in cannot start. PayPal's page for `https://rentabot.tech/api/auth/paypal/start?return_to=/account` shows
"Sorry about that ... (invalid client_id or redirect_uri)". Nothing was typed on PayPal, so the success path ("PayPal verified" and "email confirmed" badges,
no duplicate account on the second sign-in) is untested live; the unit tests in `server/test/adapters/accounts.test.ts` cover it against a fake PayPal.

Diagnosis (the dashboard was not touched):

- The client id in the URL is the production one. The scope is not the cause: `openid profile email` alone on `/signin/authorize` gives the same page.
- PayPal's token endpoint says the same thing from the API side. `POST /v1/oauth2/token` with `grant_type=authorization_code` and
  `redirect_uri=https://rentabot.tech/api/auth/paypal/callback` answers 401 `invalid_redirect_uri` ("Redirect uri does not match"), and so does every other
  `rentabot.tech` or localhost URI tried (callback with a trailing slash, `www`, `/`, `/account`, ports 8790 and 8791). So no Return URL is saved on
  "Rent-A-Bot US", or "Log in with PayPal" is not enabled on it. Sent exactly as the server sends it (no `redirect_uri`), a bogus code gets
  `invalid_authz_code`, so the app credentials themselves are accepted for the code exchange.
- Our side works up to PayPal. Replaying the callback on production: a bogus code goes server -> egress Worker -> PayPal and comes back as
  `/account?login_error=paypal` (server log: `PayPal token exchange failed: HTTP 401 invalid_authz_code`, no token in the log); the egress Worker also passes
  `GET /v1/identity/oauth2/userinfo?schema=paypalv1.1` (401 `invalid_token` from PayPal for a bogus bearer); `PAYPAL_LOGIN_SCOPES` is not overridden on the VM.
- Cancel: simulating PayPal's cancel redirect (`error=access_denied` with the real state and cookie of the Brave tab) lands on
  `/account?login_error=denied` and the page says "You cancelled on PayPal. Nothing was shared."

To fix, in developer.paypal.com > Apps & Credentials > Sandbox > "Rent-A-Bot US" > Features: tick "Log in with PayPal", open its advanced settings, set
the Return URL to `https://rentabot.tech/api/auth/paypal/callback` (exact), add the privacy policy URL `https://rentabot.tech/privacy` and the user
agreement URL `https://rentabot.tech/terms`, tick the profile items for full name and email (and the account status item that grants
`https://uri.paypal.com/services/paypalattributes`), and press Save. Then open the start URL again as `human-buyer@personal.example.com`.
If PayPal then rejects the scope, set `PAYPAL_LOGIN_SCOPES="openid profile email"` with `deploy/gce/write-env.sh PAYPAL_LOGIN_SCOPES=... --restart`.

### Bugs found and fixed

1. **Agent-Readiness Auditor accepted a report spec it could not meet** (commit `1ad9e6e`, deployed). The spec copilot, given the goal "audit ... (llms.txt, agent.json,
   mcp.json, OpenAPI)", asked for the report headings `Summary, llms.txt, agent.json, mcp.json, OpenAPI, Recommendations`. The bot's report only had
   `Summary, Score, Findings, Fixes`, so `report_sections_present` failed ("missing section(s): llms.txt, agent.json, mcp.json, OpenAPI, Recommendations"),
   the deliverable earned $0.00 and the buyer's $9.00 authorization was voided with nothing paid to the seller. Now the report carries a section for every
   name the bot can write from its own findings or fix list (a topic the audit did not assess says so and why), and a spec that names a section it cannot
   write (for example "Competitor pricing analysis") is declined when offered instead of failing at review. Tests: `bots/test/live-bots.test.ts`
   (3 new; the first two fail without the fix, and they run the platform's own acceptance checks).
2. `server/test/adapters/discovery.test.ts` (commit `a15cbf8`): the mcp.json test opens four MCP sessions and takes 6 to 7 s here, over vitest's 5 s default, so
   `npm test -w server` failed on a loaded machine. Its timeout is now 30 s. Server tests on the exported commit: 409 passed, 2 skipped; `npm run typecheck`: clean.

No bug was found in payout handling, the webhook, the reconciler or the egress Worker.

Noise, not fixed: after a delivery the Directory Blaster sometimes sends progress messages once the job is already `DELIVERED`; the server refuses them
(`invalid_state: progress messages are for work in progress`) and logs a warning. No money or state is affected.

### Open items for the owner

- ~~Save the "Log in with PayPal" settings on the "Rent-A-Bot US" app~~: done 2026-10-20, live sign-in, second sign-in and cancel pass (see "Log in with PayPal").
- Job 4 (`job_mvfjgqtu7NZba1VR6Zqqpk`) waits for a PayPal approval of $9.00 until about 18:03 UTC on 2026-10-19; approving it as any sandbox buyer completes the
  post-fix audit run and shows the $3.00 commission floor with real fees. If it has expired, create the audit again (`agent_readiness_audit`, any bot outside the mandate's classes).

## Example jobs on production (2026-10-20)

One real, small job for every listed house bot on https://rentabot.tech, run through the PayPal sandbox app "Rent-A-Bot US" (releases
`00bb02c`, then `40bd169`, then `ab98bcb`), plus one mediated dispute and one open job with competing bids. Buyer: ORANO Growth Agent over REST
(`/api/ops/*`, the same operations as MCP). Seller payouts go to `glob-payouts@personal.example.com`. All money is sandbox money.

Funding: a new mandate `mdt_mvflsvmntKnJDt0DfMhpSe` ($400/month, $70/job, `real_world_action` + `reach` + `code`, 30 days) was requested and
approved once on PayPal as `orano-buyer@...` (headless Chromium with a throwaway profile; the Brave extension was not connected). It replaced
`mdt_mvfiikqgysCNZK4HHP58hd`. Every job in those classes was funded by `fund_job` with no click. The two Agent Red Team jobs (`security`, never
covered by a mandate) went to `AWAITING_APPROVAL` and were approved on the PayPal checkout page as `human-buyer@...`.

Cross-checks: every order, authorization, capture and payout below was read from PayPal from this PC (`GET /v2/checkout/orders/{id}`,
`/v2/payments/authorizations/{id}`, `/v2/payments/captures/{id}`, `/v1/payments/payouts/{batch}`, `/v1/payments/payouts-item/{id}`) with the app's
own credentials and compared with `get_escrow`. Authorized, captured and paid-out amounts match on all 15 jobs, every capture is
`final_capture=true`, every unspent remainder is voided (authorization `CAPTURED` with the remainder released, or `VOIDED` when nothing was paid),
and every payout item and batch is `SUCCESS` with `payout_item_fee` $0.25.

### Per bot (USD)

PayPal fee = `seller_receivable_breakdown.paypal_fee` on the capture. Platform net = commission - PayPal fee - payout fee.

| bot | job | authorized | captured | voided | PayPal fee | commission | payout | platform net | result |
|---|---|---|---|---|---|---|---|---|---|
| Directory Blaster | `job_mvfmj14kNWFj05Yev3wJCp` | 30.00 | 24.00 | 6.00 | 1.33 | 3.60 | 20.40 | 2.02 | 16/20 listings verified on Sandbox Web directories, accepted. 5 handed-over logins released at the capture; the 2 for unpaid listings were shredded unopened. |
| Investor Outreach Bot | `job_mvfmj1x44EGWEA8zXSV11g` | 20.00 | 6.00 | 14.00 | 0.70 | 3.00 | 3.00 | 2.05 | 3/10 emails sent from the buyer's own Sandbox mailbox (only 3 of 25 investors fit). **The mediated dispute**, see below. |
| Lead Verifier | `job_mvfnunhhzTgKCgD9aKjmhg` | 6.00 | 5.40 | 0.60 | 0.68 | 3.00 | 2.40 | 2.07 | 54/60 leads pass (34 verified, 20 honest "not on the page" for guessed role addresses), 6 inconclusive (source page timed out). Third attempt, see the voids below. |
| Budget Lead Verifier | `job_mvfnqkzad6jy8vg99ETbbA` | 5.60 | 5.53 | 0.07 | 0.68 | 3.00 | 2.53 | 2.07 | **The open job**: 79/80 leads verified, accepted. |
| Agent-Readiness Auditor | `job_mvfmj24am5TNb0pwqp1EQb` | 9.00 | 9.00 | 0.00 | 0.80 | 3.00 | 6.00 | 1.95 | Audit of https://rentabot.tech; the report passed `report_sections_present` and `http_claim_holds`. First completed job at the $3.00 commission floor. |
| Cold Email Writer | `job_mvfmj5au3M7rGe0cAedjxC` | 5.00 | 5.00 | 0.00 | 0.66 | 3.00 | 2.00 | 2.09 | 10/10 partnership emails passed `email_lint` (written only, nothing sent). |
| Agent Red Team | `job_mvfn5a78FZsAxX89TCT6js` | 5.00 | 5.00 | 0.00 | 0.66 | 3.00 | 2.00 | 2.09 | Re-run after fix 1: 2/2 findings confirmed by the practice agent's own log. Ownership token claimed and bound to the job (`/sandbox/redteam/claim`, `/scope`) before funding; approval link paid by `human-buyer@...`. |
| Landing Page Bot | `job_mvfn4qxysvs4adF8sc1jJ0` | 6.00 | 6.00 | 0.00 | 0.70 | 3.00 | 3.00 | 2.05 | Re-run after fix 1: page live at `/sandbox/pages/pg000150ea`, `url_live` and `page_mentions` pass. |
| Account Setup Bot | `job_mvfmj7efgewV9GzX4Y1fw3` | 5.00 | 5.00 | 0.00 | 0.66 | 3.00 | 2.00 | 2.09 | 4/4 accounts created, verified through the buyer's mailbox (app password in the locker) and profiled. The 4 logins were released at the capture and opened by the buyer afterwards. |
| Application Filler | `job_mvfmja8h9KQTSQJ12bZGMB` | 8.00 | 8.00 | 0.00 | 0.77 | 3.00 | 5.00 | 1.98 | 2 applications (Northstar, Summit Seed) previewed in the room with the two assumptions named; the buyer approved with `approved_applications: "all"`, the bot submitted, 2/2 confirmed. |

Jobs that paid nothing (correct voids; the money was never charged):

| bot | job | authorized | voided | why |
|---|---|---|---|---|
| Landing Page Bot | `job_mvfmg6lnvJJNE27BRcTr6d` | 6.00 | 6.00 | Bug, fixed in `40bd169` (fix 1). |
| Agent Red Team | `job_mvfmo77mSf28JmBScRZ3Aj` | 5.00 | 5.00 | Bug, fixed in `40bd169` (fix 1). Authorization `VOIDED` at PayPal. |
| Lead Verifier | `job_mvfmj33ee6eq0fmxEktYT4` | 5.00 | 5.00 | 25/50 verified ($2.50) is below the $5.00 minimum settlement; the other 25 source pages were unreachable from the VM (IPv4-only hosts, see open items). |
| Budget Lead Verifier | `job_mvfmj59dvZAM2RMFMmTGSR` | 5.60 | 5.60 | 42/80 verified ($2.94), same cause. |
| Lead Verifier | `job_mvfn4q0eewXSC1eTzbt1g7` | 5.00 | 5.00 | 49/50 verified ($4.90) with IPv6-reachable leads; one source page (zomato.com) timed out, also after a cure round the buyer asked for. Below $5.00, so voided. |

Totals over the 15 jobs: authorized 126.20, captured 78.93, voided 47.27, PayPal capture fees 7.64, commission 30.60, payouts 48.33,
payout fees 2.50, platform net 20.46. No bot reported an AI error; AI spend stayed far below the server cap.

### The mediated dispute

Job `job_mvfmj1x44EGWEA8zXSV11g` (Investor Outreach Bot): the contract asked for 10 emails and the bot sent 3. It did so honestly: it emails only
investors whose thesis fits, and only 3 of the 25 Sandbox investors fit AI / consumer apps / productivity. The buyer opened a dispute with two
claims (3 of 10 delivered; the shortfall was not flagged at quote time). The mediator re-ran the checks, assessed the verified value at $6.00 (fair
range 6.00-6.00, jury led by `claude-opus-5-5`, no integrity flags) and posted a split `prp_f801a7135a2962e7` (release $6.00, refund $14.00) and a
cancel with the same money. The house seller accepted both within seconds; the buyer accepted the split, and it executed at once: capture
`83U99193S52179425` $6.00 (final), $14.00 voided, payout batch `TTXLU7TFTJUSL`, item `VBQCZBXWKN9PC` $3.00 `SUCCESS`. From dispute to settlement
took under a minute. The leaderboard and the bot card show it as 1 dispute, 1 settled by agreement.

### The open job

`post_open_job` `opn_mvfnpqfySSmq9rAWcafAK6`: verify 80 security contacts, budget cap $8.00, bid window 10 minutes, manual award. Both bots with the
`verify_leads` skill bid within a second:

| bid | bot | price | turnaround | track record at bid time |
|---|---|---|---|---|
| `bid_mvfnpqinsYGQS47m5AP2Fw` | Lead Verifier | 8.00 | PT2H | 74/100 verified, pass rate 0.74 (recommended: best record) |
| `bid_mvfnpqjih1CKj9C1WcZdNf` | Budget Lead Verifier | 5.60 | PT10H | 42/80 verified, pass rate 0.525 (recommended: lowest price) |

Both apply the same rule, and the earlier pass-rate gap came from unreachable source pages rather than the bot, so the buyer awarded the cheaper
bid. `award_bid` created `job_mvfnqkzad6jy8vg99ETbbA` with the bid's requirements and quote, declined the other bid and closed the open job. The
job ran to settlement as in the table (79/80, $5.53 captured, $0.07 voided, payout `Y45LHSHCQTDA4` $2.53 `SUCCESS`).

### Locker handovers

For the Directory Blaster and the Account Setup Bot the buyer called `list_locker_items` and `open_locker_item` after settlement. The released
handovers open (sealed by Rent-A-Bot, `kind: login` with a password). The audit shows `put` by the seller during the work, `released` by the
platform only at the capture, then the buyer's `open`. Handovers for units that were not paid (2 Directory Blaster listings) were shredded at
settlement and answer `invalid_state` ("the job ended (SETTLED) and this unit was not paid"). The buyer's own access items (mailbox app passwords)
were opened by the seller only after funding and were shredded at settlement.

### Bugs found and fixed

1. `40bd169` (deployed): house bots did not meet the contracts the spec copilot writes.
   - Landing Page Bot: the copilot put `page_mentions` strings from the job spec's context ("key takeaways", "searchable", "iOS", "Android", the
     tagline) into the contract. The bot counted only its inputs as facts, so it published the page but refused to deliver it ("text that is not in
     your facts") and the $6.00 was voided. Now spec.context counts as buyer facts, and the page quotes the context sentences that carry those
     strings in an "About" section. Test: `bots/test/newbots.test.ts` (runs the platform's own checks on the published page).
   - Agent Red Team: the copilot asked `report_sections_present` for `Category, Severity, What the agent did, Suggested fix`. The report had them
     only as bullet labels, so both confirmed findings failed and $5.00 was voided. Each finding field is now a heading, and a contract that names a
     section the report never has is declined at quote time. Test: `bots/test/newbots.test.ts`.
   - `fit()` (shared by the form-filling and email bots) now ends on a whole clause before falling back to a word boundary: the Summit Seed form's
     one-liner had been cut to "... clear next steps, and makes". Test: `bots/test/actions-bots.test.ts`.
2. `ab98bcb` (deployed): Sandbox Web lost state on every restart. After the `40bd169` deploy the page host's counter restarted, so the next landing
   page got the id and URL of a page an earlier job had delivered (`pg000150ea`). The red-team practice agent also forgot every ownership claim and
   finding: a token claimed before the deploy stopped binding, and a dispute re-running `finding_reproduced` would have failed. Pages, the page
   counter, claims, bound jobs and the finding log are now kept in the sandbox snapshot. Test: `server/test/sandbox/newbots.test.ts` (a restart on
   the same DATA_DIR; it fails without the fix). After this deploy the delivered landing page was republished, so its URL serves the delivered
   HTML again. The red-team finding log of the jobs before `ab98bcb` is gone; both of those jobs are settled.

Checks before each deploy: `npm run typecheck` clean, `npm test -w server` 435 passed / 2 skipped, `npm test -w bots` 136 passed. Commits were
made through a private git index. The QA agent's uncommitted web changes were not in either deploy, which ships a clean `git archive` of the commit.

### Live views after the run

- `/api/public/stats` (the landing page counters): 10 bots listed, 20 jobs, 18 settled, 321 units verified, $126.93 released to sellers, $68.27
  voided, 2 disputes, median dispute 0.6 minutes, nothing held. The landing page shows the same numbers.
- `/api/public/feed` (the live feed): escrow authorized, units verified, captured, voided and dispute events for every job above, newest first.
- Leaderboard: all 10 bots have settled jobs. Directory Blaster and Investor Outreach Bot show 1 dispute settled by agreement each. Released:
  Directory Blaster $72.00 (3 jobs over two runs), Auditor $9.00, Application Filler $8.00, Investor Outreach $6.00, Landing Page $6.00, Budget
  Lead Verifier $5.53, Lead Verifier $5.40, and $5.00 each for Cold Email Writer, Account Setup Bot and Agent Red Team.
- Bot cards (`get_bot` reputation): every bot has `jobs_completed` of at least 1 and `on_time_rate` 1. The lower `avg_fulfilment` on Agent Red
  Team (0.5) and Landing Page Bot (0.5) comes from their voided first jobs (the bugs above); on the Auditor (0.75) it comes from the 2026-10-19 bug,
  and on the lead verifiers from the unreachable source pages.

### Open items for the owner

- **Live bots cannot read IPv4-only sites from the VM.** The VM has external IPv6 only (by design, see `deploy/gce/README.md`). The lead verifiers,
  the auditor and the platform's own checks time out on any host without an AAAA record: github.com, shopify.com, atlassian.com, vercel.com, and
  65 of the 148 security.txt hosts tried here. The bots report this honestly and nothing is paid, but most real targets are IPv4-only. Options:
  route the checks' and live bots' fetches through an egress proxy like the PayPal Worker (this needs an SSRF-safe design), or give the VM IPv4
  egress (this costs money, and the README rules it out today).
- **Lead Verifier pricing sits exactly on the $5.00 minimum settlement** ($0.10 x a minimum of 50 leads). One lead short and the whole job is
  voided, which happened twice here (49/50 = $4.90). The Budget Lead Verifier ($0.07 x 80 = $5.60) has a little headroom. Consider a higher
  minimum quantity (for example 60) or price on the Lead Verifier card.
- The Investor Outreach Bot accepts a quantity it may not be able to fill, because it scores fit only after funding. A warning at quote time
  would avoid disputes like the one above.

## End-to-end run on production (2026-10-20)

Every user journey run once more on https://rentabot.tech (release `d433f2d`, PayPal sandbox app "Rent-A-Bot US", `DEMO_TIME_SCALE=60`,
house bots on, real AI). Fresh jobs only, titles starting "E2E 10-20". No data was reset. All money is sandbox money. PayPal ids were read
back from PayPal from this PC with the app's own credentials and compared with `get_escrow` (journey F).

### A. Human buyer in the browser (Brave)

| step | result | evidence |
|---|---|---|
| Landing page | PASS | Counters match `/api/public/stats` (321 units verified, $126.93 released, 10 bots, $68.27 voided); no console errors. |
| Bot list, Compare, bot page | PASS | 10 bots; Compare table (model, connections, own accounts, actions, unlocks, verified); the Cold Email Writer page shows It needs / It does / You get, the passport, `email_lint`, $0.50 per email, minimum 10. |
| Log in with PayPal | PASS | `human-buyer@...` on www.sandbox.paypal.com, consent already given, back signed in; `/account` shows "PayPal verified", agent `agt_mvftsjmb3YT1TPdWmb3HER`. |
| Spec copilot | PASS | 10 partnership emails, estimate $5.00, `email_lint` with ORANO allowed in caps, policy `standard`. Job `job_mvfuwqupmnepxC1XPJzwkw`. |
| Negotiation and contract | PASS | The seller asked for `facts_kit` and recipients and quoted 10 x $0.50 = $5.00; both signed the same hash; `AGREED`. |
| Fund (PayPal approval page) | PASS | Order `8MY74843F2454862F`, checkout as `human-buyer@...`, back on `?paypal=approved`; authorization `1HJ05339LU587115U` $5.00; `IN_PROGRESS`. |
| Work, checks, release, receipt | PASS | 10/10 emails pass `email_lint`; accepted; capture `2M594006P93437230` $5.00 (PayPal fee $0.66), commission $3.00, payout $2.00 (batch `YLSVCYTAS7C2A`, item `TYNZPXAVN4DLA`, `SUCCESS`). |
| `/account` history | PASS (gap) | The job is listed as Settled, without amounts (see open items). |

### B. Dispute and mediation

| step | result | evidence |
|---|---|---|
| Hire Directory Blaster, 20 listings, mandate funding | PASS | `job_mvfuml4hkNaTAJY7VsS6Xc`, order `5SL686223R469731F`, authorization `05V62870FH131272D` $30.00, no click. |
| Delivery | PASS | 16/20 listings verified (2 rejected in moderation, 2 live with the name rewritten), 4 not delivered. |
| Buyer opens a dispute | PASS | Two claims (4 missing; the delivery note is silent). Assessment: verified $24.00, fair range $24.00-$24.00, three-model jury (Opus, Sonnet, Haiku 5.5) all at 0.8, a seller fault noted, no integrity flags. The jury also found the buyer's second claim inaccurate (the note did explain the shortfall). |
| Round 1: split $24.00 / $6.00 | PASS | `prp_492280f14e7b2721`, accepted by the house seller within a minute. |
| Buyer counter (redo: 4 substitute listings, $6.00 held) | **FAIL, fixed** | The counter `prp_de0cee4d5c601e43` was valid and inside the fair range, but it answered the round's last open proposal, so the mediator started round 2 at once and marked the counter `superseded` before the seller could answer. Bug 1 below. |
| Round 2 split accepted by both | PASS | `prp_e12db129dcf7caca`: capture `20P20312HG140183D` $24.00 (final), $6.00 voided, commission $3.60, payout $20.40 `SUCCESS`. The money matches the agreed proposal to the cent. |

### C. Open job with bids

| step | result | evidence |
|---|---|---|
| Post an open job (80 security contacts, cap $8.00, manual award) | PASS | `opn_mvfuqvb6FN8hGKZykQjcKq`. Lead list built from public `security.txt` files: 23 real contacts plus 57 guessed role addresses that must come back as honest rejections. |
| Bids | PASS | Lead Verifier $8.00 PT2H (`bid_mvfuqvcwxTK6QeC5tVPjKv`), Budget Lead Verifier $5.60 PT10H (`bid_mvfuqvdyzZHa2ApfegwyvG`), within a second. |
| Award, inputs, fund | PASS | Awarded the Lead Verifier: `job_mvfutaz3N6Eg17A9WN1YVK`; mandate funding, order `9159047691260992X`, authorization `6G967208TW480153A` $8.00. |
| Delivery and release | PASS | 80/80 units pass `lead_verified` (verified, or an honest rejection the platform confirms); capture `1MC2847511226310S` $8.00, commission $3.00, payout $5.00 `SUCCESS`. |

### D. Locker (Account Setup Bot)

| step | result | evidence |
|---|---|---|
| Buyer key and access | PASS | The buyer registered its own P-256 key (`register_encryption_key`). A new Sandbox Mail mailbox `e2e-1020@orano-e2e.test` and its app password went into the locker as the answer to access request A1 (sealed). |
| Consent in the contract | PASS | create_account, fill_form and browse, at most 15 actions, only on `saas.sandbox`, until the deadline; usage at the end 12/15. |
| Work | PASS | `job_mvfumqquMM15SNzpCnnJns`: 4/4 accounts (PulseMetrics, Inkletter, Chirpbook, StatusBeacon) created, verified through the mailbox and profiled; 4 handovers put `end-to-end`, `locked` until paid. |
| Release and handover | PASS | Accept: capture `7UY57032MF161383B` $5.00, payout $2.00 `SUCCESS`. All 4 handovers `released`; opened as the buyer and decrypted locally with the buyer's private key (kind `login`, unique 24-character passwords). The buyer's access item was `shredded` at settlement (opening it now answers `invalid_state`). |
| Audit trail | PASS | `put` (buyer, sealed) -> `open` (seller, after funding) -> one `action` entry per create_account / browse / fill_form with its target -> `put` per handover -> release at the capture. |
| Consent caps enforced (third-party seller of journey E) | PASS | A grant capped at 2 `analyze` actions: actions 1 and 2 logged, the 3rd answered `policy_blocked` ("over the limit of 2"); `send_email`, which the grant does not cover, also `policy_blocked`. |

### E. Agent journey over MCP, and a third-party seller

| step | result | evidence |
|---|---|---|
| Self-signup over MCP | PASS | No key: `initialize` lists 53 tools; `register_agent` gives agent `agt_mvfuwipv7FM8bjMpE6nyh7` and a claim link; the session upgrades at once. |
| The owner claims it with Log in with PayPal (headless Chromium, throwaway profile) | PASS | `orano-buyer@...`: login, "Agree and Connect", back on `/account?welcome=1` (new user `usr_mvfux57uZR4WVTqycbB0wA`, "PayPal verified"), then `POST /api/account/claim`: claimed, payout email taken from PayPal. About 30 s. |
| Mandate | PASS | `request_mandate` $40/month, $15/job, reach + code + real_world_action -> PayPal vault page -> "Save and Continue" -> `/account?mandate=active`; `mdt_mvfuxev4W4M7gfRNkcPbFc` `active`. Sign-up to an active mandate took about 70 s. |
| Search and compare (passports) | PASS | `search_bots` and `get_bot` return the passport (models, runs_on, tools, data handling) for Cold Email Writer, Investor Outreach Bot and the third-party bot. |
| Hire, fund, deliver, release | PASS | Cold Email Writer `job_mvfuzt8q9TeTWxZTc0Dhjs`: spec copilot, inputs, contract, `fund_job` with no click (order `6C286494AN947505K`), 10/10 pass, released: capture `5L999531AN096973J` $5.00, payout $2.00 `SUCCESS`. |
| A third-party seller registers a bot | PASS | Agent `agt_mvfuyt5t1E7NRx2CNpCr6N` (payout email `third-party-seller@personal.example.com`), bot `bot_mvfuyzx5AnSFkPX0eGCXd0` "E2E Tagline Pack" passed the policy gate (`standard`). |
| Open job with `bid_window` PT5M | **FAIL, fixed** | `opn_mvfv013tQqW91rBYDXV7rb` expired "with no bids" before the seller's first call: on the 60x demo clock the 5-minute window lasted 5 seconds. Bug 2 below. Re-posted with P1D (24 minutes on the demo clock): `opn_mvfv1rcbJE6H7hC2J0SgpZ`. |
| Bid, award, fund, deliver, release, payout | PASS | Bid `bid_mvfv1sqrHX9SBWEdAhF0D0`, award -> `job_mvfv24r7kmX5T6dx0caHjb`, mandate funding (order `78900271NK318680D`), 5/5 units pass `json_schema_valid`, capture `6MJ4553393107930W` $5.00, payout $2.00 to `third-party-seller@personal.example.com` `SUCCESS` (batch `7EXTBN8BYSVDQ`). |

### F. Money integrity (ledger vs PayPal)

| job | order | authorization | capture | authorized | captured | voided | PayPal fee | commission | payout (receiver) | payout fee | platform net |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A `job_mvfuwqupmnepxC1XPJzwkw` | `8MY74843F2454862F` | `1HJ05339LU587115U` CAPTURED | `2M594006P93437230` | 5.00 | 5.00 | 0.00 | 0.66 | 3.00 | 2.00 (glob-payouts) | 0.25 | 2.09 |
| B `job_mvfuml4hkNaTAJY7VsS6Xc` | `5SL686223R469731F` | `05V62870FH131272D` CAPTURED | `20P20312HG140183D` | 30.00 | 24.00 | 6.00 | 1.33 | 3.60 | 20.40 (glob-payouts) | 0.25 | 2.02 |
| C `job_mvfutaz3N6Eg17A9WN1YVK` | `9159047691260992X` | `6G967208TW480153A` CAPTURED | `1MC2847511226310S` | 8.00 | 8.00 | 0.00 | 0.77 | 3.00 | 5.00 (glob-payouts) | 0.25 | 1.98 |
| D `job_mvfumqquMM15SNzpCnnJns` | `73Y176175M404330V` | `2E020416CF944204W` CAPTURED | `7UY57032MF161383B` | 5.00 | 5.00 | 0.00 | 0.66 | 3.00 | 2.00 (glob-payouts) | 0.25 | 2.09 |
| E `job_mvfuzt8q9TeTWxZTc0Dhjs` | `6C286494AN947505K` | `2CU28095NA6275442` CAPTURED | `5L999531AN096973J` | 5.00 | 5.00 | 0.00 | 0.66 | 3.00 | 2.00 (glob-payouts) | 0.25 | 2.09 |
| E `job_mvfv24r7kmX5T6dx0caHjb` | `78900271NK318680D` | `247788469K527383J` CAPTURED | `6MJ4553393107930W` | 5.00 | 5.00 | 0.00 | 0.66 | 3.00 | 2.00 (third-party-seller) | 0.25 | 2.09 |

Authorized, captured, voided and paid-out amounts match PayPal on every job: **0 mismatches**. Every order is `COMPLETED`, every capture
`COMPLETED` with `final_capture=true`, and every payout item is `SUCCESS` to the right receiver. Webhooks: 26 deliveries to `/api/paypal/webhook`
between 22:50 and 23:10 UTC, all answered 200; the ledger shows `PAYMENT.AUTHORIZATION.CREATED` and `PAYMENT.CAPTURE.COMPLETED` on every job.
Payout success was confirmed by the reconciler first (1-2 s after sending), as in earlier runs. The server log has no warning or error lines
for the run.

### G. Site quality (headless Chromium, 1440 and 390 px)

Pages: `/`, `/bots`, Compare, a bot page, a Job Room (signed out and signed in), `/made`, `/account`, `/privacy`, `/terms`. No console errors,
no page errors, no broken images and no broken same-origin links. One real overflow: the Job Room's mediation assessment row ("Verified value /
Claimed value") was 402 px wide on a 390 px screen (bug 5). The Compare table scrolls inside its own box on phones (the page itself does not
overflow). Several labels render at 9-10.5 px (the hero receipt mock, the "demo" badge, Job Room labels).

### Bugs found and fixed

1. **A counter was superseded before the other side could answer it** (`563f3a8`). `roundComplete` looked only at the mediator's proposals,
   so a counter that answered the round's last open proposal completed the round; the mediator posted round 2 at once and marked the counter
   `superseded` (journey B). The round now also waits for the other side's answer to an open counter (or the round deadline). Test:
   `server/test/core/mediation.test.ts` ("a counter that answers the last open proposal ...", fails without the fix).
2. **Open-job bid windows lasted seconds on the demo clock** (`563f3a8`). `bid_until` used the scaled duration, so with `DEMO_TIME_SCALE=60`
   a PT5M window was 5 seconds: only in-process house bots could bid, and a third-party seller's bid was refused as `expired` (journey E).
   The window is still scaled but never shorter than the 5-minute minimum in real time. Test: `server/test/core/open-jobs.test.ts`.
3. **The spec copilot silently raised the quantity** (`563f3a8`). Asked for 10 listings from a bot with `min_units: 20`, it drafted
   `quantity: 20` while the description, out-of-scope list and its own warning still said 10. It now warns ("You asked for 10 ...
   at least 20 ...") and tells the model the real quantity. Test: `server/test/intelligence/checks.test.ts`.
4. **A settled job showed an old "Next deadline"** on `/jobs` (journey A: "10m" on a settled job) (`563f3a8`). `list_jobs` returns
   `next_deadline: null` for finished jobs. Test: `server/test/core/flows.test.ts`.
5. **Job Room mediation row overflowed a phone screen** (journey G, 402 px on 390 px) (`563f3a8`): one column below `sm`. Checked on
   production after the deploy: that job page now measures 390 px.
6. **Transient fetch errors failed web checks for good** (`0097c04`, asked for by the coordinator after a live 429 from github.com through the
   egress Worker). `url_live` and `page_mentions` now retry 408/429/502/503/504/52x, timeouts and dropped connections inside the check's own
   timeout (2 retries, Retry-After honoured up to 3 s), then answer `pending` with a "transient: ..." detail instead of `fail`. Pending
   results are re-run at the review/verify window end, and a unit still pending at the final settlement is not paid while the job settles
   (test added). 404s, missing text, SSRF refusals and unknown hosts stay final. Tests: `server/test/intelligence/transient-checks.test.ts`
   (fails without the fix), `server/test/core/flows.test.ts`.
7. **Receipt rows with a long label pushed the amount off a phone screen** (`18f3428`, found in the post-deploy check: the Job Room of the
   journey B job measured 480 px at 390 px, from proposal-card rows such as "Secured now, paid with the final settlement"). `ReceiptRow`
   kept the label at `shrink-0`; label and amount may now wrap. Applying the same classes to the live page brought it to 390 px.
   Committed after the deploy; not on production yet.

Also fixed: `eba2362` restores a test line (`bots_listed` 10) that `563f3a8` had swept in from another agent's uncommitted work.

### Open items (not fixed in this run)

- Fixed after the run (`8bb8a8e`, not deployed yet): `/account` history now shows authorized, captured, returned and paid out per job
  (`list_jobs` gained an optional `money` field). The Job Room ledger says "Payout sending..." while a payout is unconfirmed instead of
  "$0.00"; `payout_sent` is now stamped by the webhook or the reconciler (it is keyed by the payout batch, the confirmation by the item, so
  it never matched and kept "awaiting webhook"). Compare lets you pick the bots. The hire flow has an editable job title. The buyer panel
  uses plain titles and sentences, with ids, retry keys and contract hashes under "Details" (agents and the API are unchanged). The landing
  counters print the real number in a hidden tab (they waited for IntersectionObserver and animation frames). The hire page stalling on
  "Drafting..." in a background tab was not reproduced with animation frames and observers disabled: the draft request completed and the
  spec step appeared, so it is the Spec Copilot's call time, not a bug.
- `docs/MCP.md` says 45 tools; `tools/list` returns 53.
- Every browser that opens a Job Room as the same owner registers a new client encryption key (3 were added by the headless site check);
  handovers are then wrapped for keys whose private half is gone. Harmless for opening (the buyer's other keys still work), but the key list grows.
- One open job of this run (`opn_mvfwez6ye1C7H14htgtHV3`, the post-deploy bid check) was not awarded on purpose and expires by itself.

### After the fixes: deploy and live re-check

The clean export of `0097c04` passed typecheck, bots (145 tests), agents (16) and the web build; the server suite had one failure: a test line that
another agent had changed in the working tree (`bots_listed` 10 -> 11 for its new house bot) and that `563f3a8` swept in. `eba2362` restores it,
and the test passes on the export with that line restored. `0097c04` was deployed, then the approved `a67d1cf` (adds the coordinator's landing
change and docs), whose clean export passed everything: typecheck, server 467 passed and 2 skipped, bots 145, agents 16, web build.
`/api/health` was ok after both deploys.

| check on production (after the deploy) | result | evidence |
|---|---|---|
| The open-job window is 5 real minutes | PASS | `opn_mvfwez6ye1C7H14htgtHV3` (verify_leads, PT5M, not awarded): `bid_until` 297 s after posting; Lead Verifier and Budget Lead Verifier bid within 3 s. |
| A third-party seller can bid | PASS | `opn_mvfwevmzK7v0eXQWDTsZkV` (PT5M): the third-party bid `bid_mvfwgl2sfcAZ9cmKxCawgT` was accepted 80 s after posting (before the fix the window closed after 5 s). |
| Copilot quantity note | PASS | Directory Blaster asked for 10: `quantity: 20`, first warning "You asked for 10 verified_listings, but this bot takes at least 20 per job, so the spec is for 20. ...", and the description says 20. |
| A counter that is the round's last answer stays open | PASS | `job_mvfwgx4vSxC7XhaTqM4BaC` (third-party bot, 8 taglines, 6 pass, verified $7.50 of $10.00): the buyer accepted the split and rejected the redo; the seller rejected the redo and countered the split at $8.00 (`prp_0b6f9291cdd70993`, flagged `outside_fair_range_high`). The round stayed at 1 with the counter open; the buyer accepted it: capture `12551615379982707` $8.00 (final), $2.00 voided, commission $3.00, payout $5.00 to `third-party-seller@personal.example.com` `SUCCESS` (batch `2KLQ27U8BXKWW`). |
| Settled jobs have no next deadline | PASS | `list_jobs` returns `next_deadline: null` for settled jobs. |
| Job Room mediation row at 390 px | PASS | The job page that overflowed before now measures 390 px (the receipt-row overflow on another job is bug 7, fixed after this deploy). |

Ledger vs PayPal over all 7 jobs of this run (the 6 above plus `job_mvfwgx4vSxC7XhaTqM4BaC`, order `6HN14049YV6441356`, authorization
`6R465036Y04623124`): **0 mismatches**. Totals: authorized 68.00, captured 60.00, voided 8.00, PayPal capture fees 5.51, commission 21.60,
seller payouts 38.40, payout fees 1.75, platform net 14.34.

Test listing: the third-party bot `bot_mvfuyzx5AnSFkPX0eGCXd0` ("E2E Tagline Pack", seller agent `agt_mvfuyt5t1E7NRx2CNpCr6N`) was set to
`paused` by its own seller agent (`update_bot`) after the checks; `search_bots` lists only the 10 house bots again. The fresh buyer agent
`agt_mvfuwipv7FM8bjMpE6nyh7` keeps its mandate `mdt_mvfuxev4W4M7gfRNkcPbFc` ($20.00 of $40.00 spent). The encryption keys this run added to the
ORANO agent (its own test key and the throwaway keys that headless page checks registered) were revoked.

Not tested in this run: reauthorization after day 4, refunds through the escrow service, capture-and-hold mode, a dispute that ends in a ruling
and an appeal to a human, the Brave flow on a phone-sized window, and accessibility (contrast, keyboard).

## New house bots on production (2026-10-20)

One real paid job on each of the three house bots that went live with release `3bb4851` (code of `dab135e`, `d2b373b`, `739088b`) on
https://rentabot.tech, PayPal sandbox app "Rent-A-Bot US", `DEMO_TIME_SCALE=60`, real AI. Buyer: ORANO Growth Agent over REST (`/api/ops/*`,
the same operations as MCP), funded by its mandate `mdt_mvflsvmntKnJDt0DfMhpSe` with no click (spent this month $110.93 before, $131.43 after).
Seller payouts went to `glob-payouts@personal.example.com`. No data was reset, nothing was deployed, all money is sandbox money. Every order,
authorization, capture and payout below was read back from PayPal from this PC with the app's own credentials and compared with the ledger
(`get_job` -> `escrow`).

### Results

| bot | job | units | money | result |
|---|---|---|---|---|
| Deliverability Doctor | `job_mvfznwktANhVBt4W1XPNCZ` | 6/6 domains pass, 0 failed | $7.50 captured | PASS |
| Broken Link Hunter (D1 + D2) | `job_mvfzo66oQCF5F604BB927H` | D1 8 verified of 24 asked (nothing delivered for the other 16), D2 report passes | $7.00 captured, $4.00 released | PASS, with 2 wrongly paid links (bug 1, fixed in `52d1a94`, not deployed) |
| Web Data Extractor | `job_mvfzojziCeankDntM8VWfP` | 30/30 pages pass, 0 failed | $6.00 captured | PASS, with 27 free-form values dropped by the bot (bug 2, fixed in `52d1a94`, not deployed) |

No unit failed a platform check in any of the three jobs, so there was no failed unit to judge. The platform's checks did decide the pay: the
amounts below are exactly the per-unit earnings the checks reported (`earned`). The Broken Link Hunter checks are also the ones that let two
links through (bug 1). All three jobs went from funding to `DELIVERED` in under a minute (demo clock) and I accepted them at once.

### Deliverability Doctor (`bot_mvfzfmg7qQMwMQejT2kdhH`)

- Spec drafted from a plain goal ("audit the email deliverability of six of our domains ... and give me the DNS records to add or fix for SPF, DKIM
  and DMARC", quantity 6): D1 six domains, checks `dns_claims_hold` and `artifact_attached` (`text/`), $7.50 cap. Domains: oranoai.com, rentabot.tech,
  github.com, paypal.com, cloudflare.com, wikipedia.org. Policy class **restricted** ("four of six domains are not shown to be buyer-owned"; the
  gate is model-judged and cannot know that). The restricted job was created, quoted ($1.25 x 6 = $7.50), signed and funded by the mandate with
  no block; the class only shows on the job.
- Work and checks: 6/6 units pass `dns_claims_hold` and `artifact_attached` (one report per domain). The seller's progress was "5/6 domains audited", then
  the delivery with 23 findings in total. Spot check against independent DNS (dns.google and cloudflare-dns.com from this PC): oranoai.com SPF
  `include:_spf.google.com ~all`, DMARC `p=none; rua=mailto:hello@oranoai.com` and MX `1 smtp.google.com` match the facts; rentabot.tech has no MX, SPF
  or `_dmarc` record (NXDOMAIN), reported as `mx_missing` (high), `spf_missing`, `dmarc_missing`; the paypal.com and wikipedia.org DMARC `p=reject` match.
  The `dkim_key_weak` findings for github.com (`cm`, `k1`, `selector1`), paypal.com (`s2`) and cloudflare.com (`k1`, `mandrill`) are real: the keys
  behind those selectors are 1024-bit RSA (162-byte DER public key).
- Money vs PayPal: order `0SE8983665636171K` (payer `orano-buyer@...`), authorization `17N52978D1629354W` $7.50 `CAPTURED`, capture
  `2JF37485VS7862141` $7.50 `final_capture=true` (PayPal fee 0.75, net 6.75), commission 3.00 (the floor; 15% is 1.125), payout batch
  `2BRYE26V6Y2XJ`, item `QC6E9969XL2HQ` $4.50 `SUCCESS` to `glob-payouts@...`, `payout_item_fee` 0.25. Platform net 3.00 - 0.75 - 0.25 = **2.00**.

### Broken Link Hunter (`bot_mvfzfmgqFdCh23zwjMWqnB`)

- Spec drafted the normal way: goal "Find the broken links on our docs site https://rentabot.tech/sandbox/site/ and tell me which page each one is on, so
  we can fix them." (no mention of a report, no quantity). **The Spec Copilot added the D2 crawl report by itself.** It drafted D1 (24 broken links,
  `broken_link_confirmed`) and D2 (the crawl report, 1 unit, `report_sections_present` with Summary and Findings) and warned that D1 needs 20 confirmed
  links to settle alone and that D2 is the flat-fee report. Two more drafts with other plain goals ("... has dead links somewhere. Find them for
  me.", "Check ... for broken links.") also had D1 + D2: 3 of 3. This is the model's reading of the skill description, not a rule in code.
  **Problem: the copilot's estimate and `budget_cap` were $6.00** (24 x $0.25), without D2's $5.00. The bot's quote then fit the cap honestly:
  D2 $5.00 plus only 4 paid links ($1.00), with the note "Budget cap $6.00: only the first 4 of 24 broken links can be paid. Add $0.25 per link to pay
  for more." (job `job_mvfzlz6jacj0Md4nn4mQjT`, declined, nothing charged). I edited the spec: `budget_cap` $11.00 (24 x 0.25 + 5.00) and the context
  "crawl at most 30 pages". See the open items.
- Job: input `site_url` https://rentabot.tech/sandbox/site/, `max_pages` 30. Quote D1 24 x $0.25 = $6.00 plus D2 $5.00 flat = $11.00.
- **The production VM can crawl the demo site through its own public URL.** The bot read robots.txt and crawled 17 pages (31 requests, at most 2 a
  second, the 30-page cap was not reached) and checked 2 further link targets. It works from the IPv6-only VM.
- Work and checks: D1 delivered 8 broken links and all 8 pass `broken_link_confirmed`. D2 `crawl-report` passes `report_sections_present`. Against the
  answer key (`KNOWN_BROKEN`): all 6 known broken links were found (404 `/pricing-v1` via its 301, 404 `/team`, 404 `/docs/old-guide` on two pages, 410
  `/blog/launch-2019`, 500 `/status/500`, which the check confirmed as "the platform also gets HTTP 500, as the unit says"), and none of the decoys
  (`/flaky`, the PDF whose HEAD is refused, mailto and tel). **Two more were reported and confirmed that are not broken links** (bug 1).
- Money vs PayPal: authorized 11.00, earned 8 x 0.25 + 5.00 = 7.00. Order `4L362111561315516`, authorization `438716773L153021C` $11.00 `CAPTURED`,
  capture `0HM222339T3628041` $7.00 `final_capture=true` (fee 0.73, net 6.27), $4.00 released (the authorization's remainder, ledger `voided`
  4.00), commission 3.00, payout batch `EFLWNCT6TS3S4`, item `3H2W69HP73Q9E` $4.00 `SUCCESS`, fee 0.25. Platform net 3.00 - 0.73 - 0.25 = **2.02**.
  $0.50 of the $7.00 was paid for the two wrongly confirmed links; the job is settled and was not reopened.

### Web Data Extractor (`bot_mvfzfmgwHWvZNQ0JJk2X7s`)

- Spec drafted from "Read 30 Wikipedia biography pages of scientists and give me, for each page, the title, the meta description, the h1 and the first
  sentence of the article lead as "first_sentence", each with a source quote." (quantity 30): D1 30 pages, check `page_extraction_verified`, $6.00 cap,
  policy `standard`. Inputs: 36 en.wikipedia.org URLs of scientists (the robots.txt of wikipedia.org allows article pages) and the fields `title`,
  `description`, `h1`, `first_sentence: the first sentence of the article lead paragraph`.
- Work and checks: the bot read the first 30 URLs (the other 6 were spare) and 30/30 rows pass `page_extraction_verified`. Every row has `title` and `h1`
  (rule-read, the quotes are the page's own title and h1). `description` is null on all 30 (correct: these pages have neither a meta nor an og
  description), so each row fills 2 of 4 fields, exactly the "at least half" the check needs. `first_sentence` (the free-form field, read by the
  AI) was kept on only 3 pages (Darwin, Turing, Leonardo da Vinci); the delivery says "27 AI-read value(s) were dropped because their quote was not on
  the page". That is the rule working (an unverifiable value is dropped, not paid on a guess), but the cause was a bug in the page-text reader
  (bug 2).
- Money vs PayPal: order `8FE07099GX5773103`, authorization `3HV71812SS088245R` $6.00 `CAPTURED`, capture `2RG553260S429451E` $6.00
  `final_capture=true` (fee 0.70, net 5.30), commission 3.00, payout batch `QG424KPDQRXSJ`, item `EXQR4ZU9HZ44W` $3.00 `SUCCESS`, fee 0.25. Platform
  net 3.00 - 0.70 - 0.25 = **2.05**.

### Ledger vs PayPal

| job | authorized | captured | voided | PayPal fee | commission | payout | payout fee | platform net |
|---|---|---|---|---|---|---|---|---|
| Deliverability Doctor | 7.50 | 7.50 | 0.00 | 0.75 | 3.00 | 4.50 | 0.25 | 2.00 |
| Broken Link Hunter | 11.00 | 7.00 | 4.00 | 0.73 | 3.00 | 4.00 | 0.25 | 2.02 |
| Web Data Extractor | 6.00 | 6.00 | 0.00 | 0.70 | 3.00 | 3.00 | 0.25 | 2.05 |
| total | 24.50 | 20.50 | 4.00 | 2.18 | 9.00 | 11.50 | 0.75 | 6.07 |

**0 mismatches.** On all three jobs the order is `COMPLETED` (intent `AUTHORIZE`), the capture `COMPLETED` with `final_capture=true`, the
authorization `CAPTURED` and the payout item `SUCCESS` to the right receiver; captured amounts equal the sum of the units the checks paid, and
the ledger events are `order_created`, `authorized`, `captured`, (`voided`), `payout_sent`, `payout_succeeded`. The server log from the first
funding to the last payout (01:08 to 01:20 UTC) has no warning or error line, and 12 webhook deliveries arrived. The unused $4.00 of the Broken Link
Hunter authorization was released with the final capture (PayPal shows the authorization as `CAPTURED`).

### Bugs found and fixed

All three are in commit `52d1a94` (not deployed). Tests: `server/test/housebots/links.test.ts` and `extract.test.ts` (3 new tests that fail on the
previous code). Clean `git archive` export of `52d1a94`: `npm ci`, `npm run typecheck` clean, `npm test -w server` 535 passed / 2 skipped, `-w bots` 194 passed, `-w agents` 16 passed, `npm run build -w web` ok. The fixes are not live yet, so the production jobs above still show the old behaviour.

1. **Broken Link Hunter was paid for two links that are not broken.** Cloudflare rewrites every `mailto:` on the Sandbox Web site into
   `/cdn-cgi/l/email-protection#<hash>` (a script restores the address in a browser). A plain GET of that path is a 404, so the bot reported "Email us" on `/`
   and the e-mail link on `/contact`, and the platform's `broken_link_confirmed` confirmed both, because the bot and the check share one rule set
   (`link-logic.ts`). `extractLinks` now ignores `/cdn-cgi/` (the CDN's reserved path).
2. **The Web Data Extractor lost most free-form values on Wikipedia.** The tag stripper ended a tag at the first `>` even inside a quoted attribute, and the
   early comment stripper cut from a `<!--` inside an attribute to the next `-->`. Wikipedia puts JSON that contains both in `data-mw` attributes, so
   the page text of an article started with template wikitext ("{{IPA|de|...}}") and lost passages, and the AI's quote of the lead sentence was not a
   contiguous passage of that text. `htmlToText` and `pageFacts` now walk the markup like a browser (quoted attribute values, comments, and
   script/style/noscript/template). On the saved Albert Einstein page the lead sentence is now one clean passage at offset 8,243 (inside the AI's
   12,000 characters). This changes the text of every HTML page the platform's checks read (`page_mentions`, `url_live`, `page_extraction_verified`):
   only pages with `>` or `<!--` inside attributes read differently.
3. **Bot page, Broken Link Hunter, 1440 px: the "It does" limit chip was clipped** ("robots.txt obeyed, 2 requests a sec"; `whitespace-nowrap` in a
   300 px note). It wraps now. Checked on the live page by swapping the classes in the DOM: the chip ends 20 px inside the note.

### Open items (not fixed)

- **FIXED in code, not deployed (skills declare `pricing.extras`; the copilot adds D2 and counts its $5.00 in the estimate and cap).** **The Spec Copilot's estimate and budget cap leave out a flat-priced second deliverable.** For Broken Link Hunter it drafts D2 by itself (3 of 3
  drafts) but sets the estimate and `budget_cap` to 24 x $0.25 = $6.00, and warns "Only D1 is priced per unit; other deliverables are included in
  that price", which is wrong for D2 ($5.00 flat on top). A buyer who funds the unedited draft gets the report plus 4 paid links instead of all of
  them (the quote says so). A real fix needs the skill to publish its flat extras (an optional field next to `pricing`), which is a protocol change.
- The policy gate marks a deliverability audit of well-known third-party domains as `restricted`. The job was not blocked, but the class is
  visible on the job. A buyer's own domains would probably be `standard`; this run did not test that.
- Not tested: a unit that fails its check (none failed), a dispute on these bots, an AI-off Web Data Extractor run, and sites that block the VM's
  address range.

### UI check (headless Chromium, 1440 px and 390 px)

Bot pages `/bots/<id>` of the three bots plus `/bots` and Compare, headless Playwright with a throwaway profile (not the owner's Brave); screenshots were read.

| item | Deliverability Doctor | Broken Link Hunter | Web Data Extractor |
|---|---|---|---|
| photo or tile | PASS: `deliverability-doctor.webp` loads (1024 px wide, HTTP 200) | PASS: no photo, a yellow "B" tile on the hero card, no broken-image icon | PASS: `web-data-extractor.webp` loads |
| It needs / It does / You get | PASS | FAIL at 1440 px (chip clipped, bug 3, fixed), PASS at 390 px | PASS |
| passport (model, runs on, data, tools) | PASS | PASS ("No AI model. Plain code, same result every run.") | PASS |
| horizontal overflow (scrollWidth vs innerWidth) | none (1440/1440, 390/390) | none | none |
| console errors, page errors, 4xx/5xx, broken images | 0 | 0 | 0 |

`/bots` at both widths: the three new bots appear with their photo or tile, no overflow, no console error; Compare opens with all three. Low
severity, not fixed: the preview tiles on the hero cards and list cards use 8.5 to 9.5 px text and the hero card shows a truncated path
("/blog/20..."); the hero card animates, so its sample numbers differ between loads.

## Mandate renewal for judging (2026-10-20)

The ORANO Growth Agent's mandate `mdt_mvflsvmntKnJDt0DfMhpSe` would have expired on 2026-11-18, before judging ends on Dec 15. A new one,
`mdt_mvgk849qwfE3pQnek5QQt7` (same caps and categories: $400/month, $70/job, `real_world_action` + `reach` + `code`, `expires_in_days: 75`),
was requested over REST as the agent and approved once on PayPal as `orano-buyer@...` (headless Chromium, throwaway profile, "Save and
Continue", returned to `/account?mandate=active`). `get_mandate` shows it `active` until 2027-01-03; approving it revoked the old one, as
`mandateApproved` does. `spent_this_month` is counted per mandate, so it starts at $0.00.

## Hunter.io find_leads on production (2026-10-20)

One real paid `find_leads` job on the Lead Verifier (`bot_mvficifj3c0vWFFsYdt5v5`) on https://rentabot.tech, release `6905fdb`, PayPal sandbox app
"Rent-A-Bot US", `DEMO_TIME_SCALE=60`. Buyer: ORANO Growth Agent over REST (`/api/ops/*`), funded by its mandate `mdt_mvgk849qwfE3pQnek5QQt7` with no
click (`spent_this_month` $0.00 before, $8.75 after). Seller payout went to `glob-payouts@...`. No retry was needed, no data was reset, nothing was
deployed, all money is sandbox money. The order, authorization, capture and payout were read back from PayPal from this PC with the app's credentials.

### Job `job_mvgm1t51sbfGwFRfJx2W61` (SETTLED)

- Spec: `draft_job_spec` from a plain goal ("generic role email addresses (info@, admissions@, press@ style, not named people) at mit.edu,
  stanford.edu, berkeley.edu, ox.ac.uk and cam.ac.uk", quantity 25). The draft named `find_leads`, the five domains and 25 units (D1,
  `lead_verified`, $8.75 cap) with a rubric against named people, but **`type: generic` and the domain list are not part of the spec** (the skill's `needs`
  has no `type`, and spec inputs do not exist; inputs come later). I added both to `spec.context`. The bot's requirements asked for `domains` (and the
  optional `department`, `seniority`, `type`); `provide_inputs` gave `domains` (the five) and `type: "generic"`.
- Quote 25 x $0.35 = $8.75, both signed the same hash, `fund_job` by mandate, `IN_PROGRESS`, `DELIVERED` about 30 s after funding (demo clock),
  accepted by me at once after reading the delivery.
- Delivery: "Searched 5 domains on Hunter.io (50 addresses listed). Delivered 25 verified leads of the 25 asked for ... 1 listed address not delivered and
  not paid (no longer on its source page or without MX records). Filters: generic addresses. 29 page/DNS-over-HTTPS requests". 5 leads per domain.
- Checks: `lead_verified` ran 25 times (one per delivered unit, 25 distinct `unit_ref`s, all `pass`, `attempt` 1, each with its own evidence id) in the
  same second as the delivery; the fulfilment shows 25 expected, 25 passed, 0 failed, earned $8.75. No unit was unpaid, so there was nothing to
  withhold; the one address the bot dropped itself was neither delivered nor paid. Independent spot check from this PC: for 23 of the 25 source pages
  the address (or Cloudflare's email-protection marker) is on the page; the other 2 (ox.ac.uk) did not load from this PC (TLS handshake, timeout).

### Amounts

| authorized | captured | voided | commission | PayPal fee | payout | payout fee | platform net |
|---|---|---|---|---|---|---|---|
| 8.75 | 8.75 | 0.00 | 3.00 | 0.80 | 5.75 | 0.25 | 1.95 |

PayPal ids: order `5NT81606EX570852E` (`COMPLETED`, intent `AUTHORIZE`, payer `orano-buyer@...`), authorization `2HF95231XF166492K` $8.75 `CAPTURED`,
capture `7HJ99750CT8201209` $8.75 `final_capture=true` (fee 0.80, net 7.95), payout batch `ZHZENT2VSNZYQ`, item `8FWZCVJ64XMRQ` $5.75 `SUCCESS`
to `glob-payouts@...` (fee 0.25). `get_escrow` (authorized 8.75, captured 8.75, voided 0.00, fees 3.00, paid out 5.75) matches PayPal to the cent: **0
mismatches**. Ledger events: `order_created`, `authorized` (webhook `PAYMENT.AUTHORIZATION.CREATED`), `captured` (`PAYMENT.CAPTURE.COMPLETED`),
`payout_sent`, `payout_succeeded` (reconciler).

### Hunter.io

Account `GET https://api.hunter.io/v2/account` (key read inside a script): searches used 0 before, **5 after, 45 left of 50** (resets 2026-11-20).
Exactly one search per domain, as the skill promises. The Hunter key does not appear in `get_job`, `get_messages` (the whole job room, the delivery
and its 25 check records) or `get_escrow` (checked with a script that reads the key from `.secrets/hunter.json`; no match for the key or its first
8 characters, no mention of `api_key` or `X-API-KEY`); the job has no artifacts.

### Findings (not fixed)

1. **Hunter's `type: generic` does not give role addresses, and nothing downstream notices.** Of the 25 delivered addresses, about 8 are role or desk
   mailboxes (`undergraduate.admissions@ox.ac.uk`, `enquiries@ox.ac.uk`, `archive@ox.ac.uk`, `researchdata@ox.ac.uk` and a few short desk
   addresses at mit.edu and berkeley.edu) and about 15 are personal user IDs taken from staff, faculty or people pages (initials plus digits,
   surnames, Cambridge CRSid-style IDs; not repeated here), plus a placeholder, `abcd1234@ox.ac.uk`, from a MATLAB install page). All 25 pass
   `lead_verified`, which only checks "address on its source page and the domain has MX", so the buyer's "not named people" rule lives only in the rubric. Because the
   deliverable is public in the demo, these named staff addresses are now visible there. A fix would be a local-part rule in the bot (and a warning
   in the quote) when the buyer asks for generic addresses, or dropping `type: generic` from the offer. Several source pages are also third-party
   sites, not the university (`atma.om`, `macaulay2.com`, `thepathfindr.com`, `kar.kent.ac.uk`); the shared rule allows that.
2. **The policy class differs between the draft and the job.** `draft_job_spec` returned `standard`; after I added the context line, `create_job`
   returned `restricted` ("bulk harvesting of institutional contact emails ... needs human review"). The mandate still funded it with no click, so the
   class had no effect on payment here, but the Spec Copilot's class is not what the job gets.
3. The Spec Copilot cannot carry `type: generic` or the domains in the spec (see above); they reach the bot only through `provide_inputs`.

Fixed and deployed the same day (release `64ac002`): with `type: "generic"`, `find_leads` keeps only addresses whose local part
reads as a role mailbox (`isRoleAddress`: role words, qualifiers, the institution's own name, trailing digits; IDs, names and
placeholders are left out and counted in the note, never delivered or paid), and it tries source pages on the searched domain
first (a lead verified elsewhere carries `third_party_source`). A job the policy gate marks `restricted` is no longer funded by a
spending mandate: `fund_job` returns the PayPal approval link with the reason, so the buyer's owner approves it (security jobs keep
their scope proof instead).

Follow-up on 2026-10-21 (release `2801876`): the 21 delivered addresses that the role-address rule now rejects (the personal IDs,
the placeholder and four short desk addresses it cannot read as roles) were removed from this job on production with
`scripts/redact-job.ts`, at the owner's request: from the job record, the delivery message (#14) and 21 check evidence records,
together with the pages that carried them. The 4 role mailboxes stay. Units, checks, amounts and PayPal records are unchanged
(authorized = captured = $8.75). Message #14 is marked `redacted`, so the Job Room shows "Chain valid: 19 messages hash-linked,
1 with personal data removed" and a note on the message; a scan of every text column found 0 copies left. The temporary backup
taken before the change was deleted after the check. The same release lets `find_leads` read the domains and a request for role
addresses straight from the request, so a job like this one needs no separate `provide_inputs`.
