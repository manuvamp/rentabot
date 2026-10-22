# Test and simulation plan

Run order: everything on a local machine first (an OpenAI-compatible dev AI endpoint, simulated rail, then PayPal
sandbox), then a final production pass with an Anthropic key (read into the process only, never committed, with a hard
spend cap).

## 1. Suites (vitest, every package)

| suite | command | covers |
|---|---|---|
| core | `npx vitest run test/core` (server) | state table, contract hash, room chain, fees, escrow happy/approval/cure/dispute/appeal paths, timers, permissions, idempotency, rails request shapes |
| intelligence | `npx vitest run test/intelligence` | checks + SSRF guard, injection scanner, remedy math, jury aggregation, copilot fallback |
| negotiation | `npx vitest run test/intelligence/negotiation` | proposal money invariant, counters, fair range, rounds, AI-off agreement |
| sandbox | `npx vitest run test/sandbox` | 48 directories, 31/40 outcome, mail, checks |
| adapters | `npx vitest run test/adapters` | MCP tools/resources/prompts/sessions, REST parity, SSE, discovery |
| house bots | `npx vitest run test/housebots` + `npm test -w bots` | lead_verified / http_claim_holds / email_lint, each bot's work logic |
| web | `npm run typecheck -w web && npm run build -w web` | types and build |

## 2. Simulation (`scripts/simulate.ts`)

Many concurrent jobs against the real server (simulated rail, fast demo clock), every bot, with
randomized buyer and seller behaviour: accept, reject with reasons, cure, dispute, counter-offers,
appeals, missed deadlines, unanswered blockers, duplicate requests with the same idempotency key,
duplicate and out-of-order webhooks. After every event, assert:

- **Money conservation** per job: authorized = captured + voided + still held; refunds never exceed captures.
- **Payouts**: seller payout = captured − commission; commission = max($3, 15%) per settlement;
  platform net after estimated PayPal fees ≥ $1 for every settlement ≥ $5.
- No capture without passing checks, an agreed settlement, or a ruling.
- Mandate caps (per job and monthly) never exceeded; no spend by unclaimed agents.
- Room hash chain valid; state changes only along the state table; terminal jobs hold $0.
- Secrets unreadable before funding and after close; strangers can't read jobs.
- Every MCP tool result validates against its output schema.

Report: jobs per outcome, disputes settled by agreement vs ruling vs human, invariant violations (must be 0),
p50/p95 latency per operation.

## 3. Agent autonomy

The ORANO Growth Agent (LLM tool loop over MCP, no scripting) hires a bot from a blank start, N runs:
success rate, steps, tool errors, whether it stops correctly when human approval is needed. Plus the
scripted buyer as a deterministic baseline.

Status: the agent and the scripted baseline exist (`agents/`); no results of repeated autonomous runs are recorded yet.

## 4. PayPal sandbox end to end

Real sandbox app (credentials in a gitignored file): approval-link funding with the sandbox
buyer, Vault mandate funding without a click, partial capture, void of the remainder, Payouts to the
sandbox seller, reauthorization, refund in capture-and-hold mode, webhooks verified through a public URL
(Cloudflare Tunnel), and a ledger comparison with direct PayPal reads (PayPal's transaction search returned
nothing in the sandbox). Record actual PayPal fees vs the estimates.

Status: done, with ids and amounts, in `PAYPAL_SANDBOX_RUN.md`, except the success path of `reauthorize` (PayPal allows it
only from day 4) and capture-and-hold at job level (both listed there as not verified).

## 5. Web end to end

Headless browser against the built web app on the real server: landing, marketplace, hire flow, Job Room
live updates, negotiation cards, escrow ledger, arbiter console, simulated-PayPal page, mobile width.

## 6. Production AI pass

With ORANO's key and a $5 cap: policy gate, Spec Copilot, three-model Claude jury and the negotiation on
the demo dispute, plus one autonomous-agent run. Report latency, outcomes and actual spend from the ledger.

Status: the live site runs these paths with the Anthropic provider (a real mediated dispute with a jury led by
`claude-opus-5-5` is in `PAYPAL_SANDBOX_RUN.md`), but no latency or spend report for this pass has been recorded.
