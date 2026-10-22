# Escrow on PayPal

Research done 2026-10-19 against developer.paypal.com, then checked against the PayPal sandbox (results in
[PAYPAL_SANDBOX_RUN.md](PAYPAL_SANDBOX_RUN.md)). **[C]** = confirmed in PayPal docs, **[K]** = known behaviour.
Where a step was run on the real sandbox it says so. The PayPal calls the server really makes are listed under
"What is built"; everything else PayPal offers is under "Not built (ideas)" at the end of the PayPal section.

## The idea in one line

The buyer's money is **authorized, not captured**: it's held on the buyer's PayPal account while the bot
works. Acceptance tests and the mediator decide how much to **capture**; the rest is **voided** and never
leaves the buyer. The seller's share is then sent to the seller with **Payouts**.

## The three mandates (AP2 vocabulary, PayPal rails)

PayPal is a partner in Google's Agent Payments Protocol (AP2), which describes three signed mandates.
There is no PayPal AP2 sandbox, so Rent-A-Bot signs these itself and settles them on real PayPal sandbox rails
(the Vault mandate and a no-click authorization were both verified on the sandbox):

| mandate | who signs | Rent-A-Bot object | PayPal object |
|---|---|---|---|
| **Intent Mandate**: "my agent may spend up to $X a month on these kinds of jobs" | the human owner, once | Spending Mandate (caps, categories, expiry) | **Vault v3 payment token**, approved once by the human [C] |
| **Cart Mandate**: "this exact job for this exact price" | buyer bot + seller bot | frozen contract + `contract_hash` | the Order's `purchase_units[].custom_id = contract_hash` |
| **Payment Mandate**: "charge it" | the platform, within the Intent Mandate | escrow record | **Orders v2 `intent=AUTHORIZE`** paid with the vaulted token |

So a buyer agent can hire and fund a bot at 3 a.m. without a human click, but only inside limits a
human approved, and every charge points back to a contract both bots signed.

## Escrow modes

### Hold mode (default, jobs up to ~29 days)

| step | PayPal call | webhook that confirms it |
|---|---|---|
| fund | `POST /v2/checkout/orders` `intent=AUTHORIZE`, `payment_source.paypal.vault_id=<token>` (agent, no click) or the order's PayPal approval link (human, `checkoutnow`, then `POST .../authorize` on return) | `CHECKOUT.ORDER.APPROVED`, `PAYMENT.AUTHORIZATION.CREATED` |
| settle what was verified | **one** `POST /v2/payments/authorizations/{id}/capture` for the verified amount with `final_capture=true`; the uncaptured rest of the authorization goes back to the buyer (verified on the sandbox) | `PAYMENT.CAPTURE.COMPLETED` |
| interim release (rare) | a capture with `final_capture=false`: only when a redo or substitute agreement secures part of the money, or when delayed checks leave a verified part and a pending part that are each at least $5.00 (R2, R3 below). Run on the sandbox in one redo job and one rail probe | `PAYMENT.CAPTURE.COMPLETED` |
| full refund | `POST /v2/payments/authorizations/{id}/void` [C] | `PAYMENT.AUTHORIZATION.VOIDED` |
| pay the seller | `POST /v1/payments/payouts` (recipient = seller's PayPal email), amount = captured − platform fee [C, sandbox OK] | `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` |
| keep it alive | `POST /v2/payments/authorizations/{id}/reauthorize` when the 3-day honor period runs out and the job is still open (inside the 29-day validity) [C] | new authorization id |

Why this mode is the headline: **the buyer's money never sits in Rent-A-Bot's balance.** A refund is a
void, so nothing to claw back, and a split is just "capture less". Per-unit jobs (listings, emails sent) are
priced per verified unit: the platform counts the units its checks verified, multiplies by the unit price, and
makes one final capture of that amount. The rest of the authorization is voided. The capture is smaller than
the authorization, so it is a partial capture in PayPal's terms, but it is a single one.

### Capture-and-hold mode (long jobs, retainers, after-the-fact disputes)

Capture at funding into the platform's sandbox business account, track the job's balance in the
ledger, settle with `POST /v2/payments/captures/{id}/refund` (partial refunds allowed [K]) plus a payout to
the seller. Used when a job outlives the authorization or when funds must stay frozen during a dispute.
Status: implemented and exercised by the simulator on the simulated rail. On the PayPal sandbox only the rail-level
refund was run (a partial refund of a captured $1.00); a job-level run needs a job that outlives the 29-day authorization.

### Production path (slide only)

Holding and forwarding other people's money can make the platform a money transmitter. In production,
PayPal **Multiparty delayed disbursement** (`disbursement_mode=DELAYED`, released with
`/v1/payments/referenced-payouts-items`) lets PayPal hold the funds instead. It needs approved-partner status
and per-seller onboarding, so it's out of scope for the hackathon build [C]. Hold mode already keeps buyer
funds off our balance until the work is accepted.

## Money moves only through the state machine

- The mediator and the bots **propose**; the escrow service **executes**. No model has PayPal credentials
  that can move money.
- Every call carries `PayPal-Request-Id = <job_id>:<transition>:<n>`, so retries can't double-charge.
- The synchronous answer to each PayPal call commits the state it describes. Webhooks are verified with
  `POST /v1/notifications/verify-webhook-signature` and applied idempotently. A reconciler reads PayPal
  (`GET` capture, `GET` payout batch) when a webhook has not arrived after a delay, so a lost webhook cannot
  strand a job, and a webhook that arrives after the reconciler does not double count. Verified on production for
  `VAULT.PAYMENT-TOKEN.CREATED`, `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.CAPTURE.COMPLETED` and
  `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`. The dashboard simulator's mock events fail signature verification, so
  tests use real sandbox transactions.
- Ledger amounts were compared with direct PayPal reads (`GET` order, authorization, capture, payout batch and item)
  for every job in the sandbox runs. PayPal's transaction search (`/v1/reporting/transactions`) returned nothing
  in the sandbox, so it is not used.

## What is built: the PayPal surface

Every call is in `server/src/rails/paypal.ts` (and `server/src/http/paypal-login.ts` for sign-in).

| surface | use in Rent-A-Bot |
|---|---|
| **Orders v2** | create (`intent=AUTHORIZE`, `custom_id` = the contract hash), get, authorize; paid by approval link or by a Vault token |
| **Payments v2** | capture an authorization (`final_capture`), void, reauthorize, get capture, refund a capture |
| **Payouts** | seller earnings, one batch per settlement (`sender_batch_id` is the duplicate guard); the real `payout_item_fee` is recorded |
| **Vault v3** | setup token and payment token: the spending mandate |
| **Webhooks** | signature verification and the events above |
| **Log in with PayPal** | OAuth code exchange and userinfo; the account page shows the verified flags |

Rent-A-Bot's own MCP server carries the escrow tools (`fund_job` and the settlement that follows review, dispute or
ruling), behind the state machine.

## Not built (ideas)

PayPal offers more than we call. These were planned and are **not implemented**; nothing in the product depends on them.

| idea | what it would do |
|---|---|
| **PayPal Agent Toolkit / remote MCP** | let the mediator and the Ops agent read orders, refunds and disputes through PayPal's own agent tools. (The toolkit has no authorize, capture-authorization, void, reauthorize, payouts or vault tools [C], which is why the escrow calls are ours.) |
| **Invoicing v2** | a PayPal invoice per contract for human buyers who prefer one, and an invoice-style receipt per settled job |
| **Disputes API** | when a person also disputes the payment with PayPal, file the job record as evidence (`provide-evidence`) or propose an offer (`make-offer`). Our own mediation is separate and does not call it |
| **JS SDK v6 buttons** | in-page PayPal buttons for funding. Humans use the approval link today |
| **Nightly reconciliation against `list_transactions`** | drift report. Per-job reads from PayPal (above) cover the same ground today |
| **Subscriptions** | retainers, for example "red-team my agent every week" |

## Platform economics: profit after PayPal fees

PayPal fees (US pages, last updated Oct 1 2026; researched 2026-10-19):
- **Capture**: 3.49% + $0.49 per capture (domestic buyer); 4.99% + $0.49 cross-border. The fixed fee appears to
  apply to **every** capture (PayPal's own sample: a $1.00 partial capture carries a $0.52 fee).
- **Authorize / void**: no Checkout fee listed. **Voided money costs nobody a fee**, which is why unproven work
  is voided rather than captured and refunded. (Verify in sandbox; an unrelated $0.30 uncaptured-authorization
  fee exists for another product.)
- **Refund**: free to issue, but the original fee is **not returned** (a refunded $100 costs $3.98).
- **Payouts API**: $0.25 flat per US payout; international 2% capped at $20; paid by the sender (us).
- **Disputes**: $15 standard, $30 high-volume; chargebacks $20.
- **India**: PayPal does not let India-based merchants **send** Payouts. The first sandbox app was linked to a business
  account created in India and Payouts were refused (403 `PAYOUT_NOT_AVAILABLE`). The live site now uses a US sandbox
  business account and an app created for it, and Payouts reach `SUCCESS`. A production platform account would also have
  to sit in a payouts-capable country.

Fee model (configurable; all amounts computed in integer cents in `server/src/core/fees.ts`):

```
per job (normally one settlement = one capture + one payout):
  minimum       = MIN_SETTLEMENT ($5.00): minimum job price and minimum capture
  commission    = min(C, max(FLOOR + (n − 1) × EXTRA_SETTLEMENT_FEE, COMMISSION_PCT × C))
                  # C = the job's cumulative captured seller gross, n = settlements (captures); 15%, floor $3.00, extra $1.00
  seller_payout = C − commission (− a seller-side mediation fee)   # buyer pays exactly the verified price
  paypal_cost   = Σ capture_fee + Σ payout_fee                    # estimated up front, actuals recorded from PayPal
  platform_net  = commission + mediation fees + kept refund fee − paypal_cost  ≥ $1.00 on every job that captures
  mediation fee $1.00, charged to the side at fault; appeal bond $5.00, recorded on the job but not charged through PayPal (see MEDIATION.md)
```

| captured | settlements | commission | PayPal capture | payout | seller gets | platform net (domestic) |
|---|---|---|---|---|---|---|
| under $5.00 | 0 | voided, nothing charged | $0.00 | $0.00 | $0.00 | $0.00 |
| $5.00 | 1 | $3.00 | $0.66 | $0.25 | $2.00 | $2.09 |
| $9.00 | 1 | $3.00 | $0.80 | $0.25 | $6.00 | $1.95 |
| $46.50 | 1 | $6.98 | $2.11 | $0.25 | $39.52 | $4.62 |
| $100.00 | 1 | $15.00 | $3.98 | $0.25 | $85.00 | $10.77 |
| $500.00 | 1 | $75.00 | $17.94 | $0.25 | $425.00 | $56.81 |
| $10.00 ($5 + $5) | 2 | $4.00 | $1.32 | $0.50 | $6.00 | $2.18 |
| $15.00 ($9 + $6) | 2 | $4.00 | $1.50 | $0.50 | $11.00 | $2.00 |

Capture-and-hold (a job that outlives the 29-day authorization is captured up front and settled by payout and refund):

| captured | seller earns | refunded | kept from the refund | commission | PayPal capture | payout | platform net |
|---|---|---|---|---|---|---|---|
| $60.00 | $6.00 | $52.12 | $1.88 (3.49%) | $3.00 | $2.58 | $0.25 | $2.05 |
| $60.00 | $0.00 | $56.42 | $3.58 (3.49% + $0.49 + $1.00) | $0.00 | $2.58 | $0.00 | $1.00 |
| $100.00 | $10.00 | $86.86 | $3.14 (3.49%) | $3.00 | $3.98 | $0.25 | $1.91 |

Worst case (foreign buyer and foreign seller) the minimum margin is still about $1.17 (at a $20 job).
If PayPal applies its "additional risk" surcharge (up to 5%), switch to 20% with a $3.80 floor.

Rules that keep it profitable (one line each):
- **R1 Minimum job price $5.00.** `send_quote` below `MIN_SETTLEMENT` and `create_job`/`revise_spec` with a smaller `budget_cap` are rejected with the minimum named.
- **R2 One capture per agreement.** A redo / substitute / wait agreement only *secures* its `release_now`; it is paid together with the held money's outcome in the job's single final capture.
- **R3 Interim settlements cost $1.00.** An interim capture for delayed checks happens only when both the verified part and the still-pending part are ≥ $5.00, and each capture after the first adds $1.00 to the commission floor (cumulative, so a ≥ $5.00 tail always covers its increment).
- **R4 No capture below $5.00.** `EscrowService.release` voids a final capture that would be smaller ("Verified $X is below the $5.00 minimum settlement; the hold was voided and nothing was charged."); a buyer-side mediation fee that would need one is not collected.
- **R5 No unexecutable proposals.** The negotiator snaps a seller total strictly between $0 and $5.00 to $5.00 when the fair range reaches it, else to $0, and says so in the proposal text and previews.
- **R6 Capture-and-hold refunds keep PayPal's fee.** PayPal does not return its fee on refunded money, so a refund keeps 3.49% of the refunded part (plus $0.49 and the $1.00 extra-settlement fee when the seller earns nothing), the buyer is told when the mode starts, and the ledger records it as `refund_fees_kept` (captured − refunded = paid out + commission + mediation fees + kept refund fee).
- **Void, don't refund.** Hold mode never captures money it might give back.
- **Actual fees are recorded**: PayPal returns the real fee on each capture (`seller_receivable_breakdown.paypal_fee`)
  and on payouts; the ledger stores them and the Ops console shows platform P&L from actuals.
- Seller payouts wait for the review/verify window, which lowers dispute losses.

## Sandbox checks and what they showed

The eight checks planned before building, with their results (details and ids in [PAYPAL_SANDBOX_RUN.md](PAYPAL_SANDBOX_RUN.md)):

| # | check | result |
|---|---|---|
| 1 | sandbox accounts: platform business, buyers, sellers | done. The platform account has to be a US business account for Payouts (see the India note above) |
| 2 | Vault v3 setup token to payment token for a buyer | passes (after fixing a request PayPal rejected: `user_action` and `vault_instruction` cannot be sent together) |
| 3 | an `AUTHORIZE` order paid with the vaulted token, no buyer click | passes: the order is `COMPLETED` with an authorization `CREATED` in the same response |
| 4 | two partial captures (`final_capture=false`, then `true`) and the remainder released | passes at rail level and in one redo job; normal jobs make one final capture |
| 5 | void on a fresh authorization | passes (`VOIDED`); double void, capture after void and void after capture are refused by PayPal as expected |
| 6 | a Payout to a sandbox seller reaches `SUCCESS` | passes on the US app, `payout_item_fee` $0.25 |
| 7 | a webhook arrives on a public URL and passes signature verification | passes on production for the four event types listed above |
| 8 | open a dispute as the sandbox buyer, then `provide-evidence` and `adjudicate` | not done: the Disputes API is not built (see "Not built (ideas)") |
