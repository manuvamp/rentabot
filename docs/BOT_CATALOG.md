# Bot catalog (draft v0.1)

Rent-A-Bot launches with **house bots** built from tools we already run for our own startup, ORANO, then opens the
registry to anyone who publishes a Bot Card and speaks the protocol. Every bot below has acceptance
tests a machine can run. A bot with only "trust me" deliverables doesn't ship.

Each bot has two modes:
- **Demo mode** acts on **Sandbox Web**, sites we host so judges can run the whole flow with no side
  effects (see the end of this file).
- **Live mode** acts on the real web for real buyers (ORANO first).

## Launch bots (in the demo)

### 1. Directory Blaster: `real_world_action`
Submits a product to AI, SaaS, startup and MCP directories and proves each listing.
- **Built from:** the ORANO directory playbook and site log (our own launch notes)
  (`2026-10-09-visibility\PROGRESS.md`, `2026-10-10-directory-listings\`, `mcp-registry\`), including the
  trick for reading verification emails. Step 1 is turning that log into a machine-readable site
  catalog (free / paid / login-walled / captcha-walled, expected moderation time).
- **Needs:** name, URL, 60- and 300-character copy, logo, 2+ screenshots, category, contact email, and
  inbox verification (a forwarding address, or the buyer clicks links within 24 h).
- **Delivers:** a list of listing URLs + screenshots + submission receipts.
- **Checks:** `listing_url_live`, `listing_mentions_product`, `screenshot_attached`; re-run after the
  `verify_window` for directories that moderate.
- **Pricing:** per verified listing ($1.50, minimum 20). Settled with one final capture of the verified amount; the rest of the authorization is voided.
- **Runs on:** Sandbox Web over plain HTTP (no headless browser on the free server). A real-web mode is not built.
- **Demo mode, what it really does:** 14 of the 32 eligible Sandbox Web directories refuse anonymous submissions, so for each of
  them the bot creates a real account (a unique 24-character password per directory), hands the login to the buyer through the
  locker tied to that listing, reads the verification mail in the buyer's mailbox (the buyer shares its app password as access
  `A1`), opens the link, signs in and submits through the account. Every account, form and link is reported with `log_action`
  first, inside the consent the contract carries (create account, fill form, browse; targets `dirs.sandbox`; capped at three
  actions per listing plus a little headroom). Without that consent it creates no accounts; directories that need an email
  confirmation, a payment or a captcha are still skipped and the summary says so.

### 2. Investor Outreach Bot: `reach`
Builds a fit-scored investor and accelerator list, writes personal emails, and sends them.
- **Built from:** our own fundraising workflow for ORANO (application kit, investor screening and verification),
  our lead-verification rule, our cold-email linter,
  and our send rules (recipient's local send window, one follow-up, stop on reply, bounce or opt-out,
  SPF/DKIM/DMARC probe).
- **Needs:** a facts kit (the ORANO application kit is the template), stage, raise, sectors, and a
  sending inbox the buyer connects (OAuth), so the buyer's own reputation sends, never ours.
- **Delivers:** verified investor list (JSONL), drafts that pass the linter, send log with Message-IDs,
  replies forwarded into the Job Room.
- **Checks:** `lead_verified` (address on the firm's own site, domain accepts mail, one per firm),
  `lint_passed`, `email_sent` (Message-ID in Sent), `deliverability_ok`.
- **Pricing:** per verified lead + per sent email, plus an optional **success fee per positive reply**,
  held as its own milestone in the same authorization and captured only if a reply arrives.
- Human-in-the-loop by default: the buyer (or the buyer's agent within its mandate) approves the batch
  before sending.
- **Demo mode, what it really does:** the sending inbox is required. The buyer creates a Sandbox Web mailbox
  (`POST /sandbox/mail/mailboxes`, which returns an app password shown once) and puts the address + app password in the locker as
  access `A1` (`inbox_send`). The bot scores the investor personas against the facts kit, writes a lint-clean email for each fit,
  puts its own `Message-ID` on it, calls `log_action send_email` first (consent: send only, `demo-vc.sandbox` only, capped at the
  quantity plus replacement headroom and 100 a day), then sends through `/sandbox/mail/smtp/send` as the buyer. A registered mailbox
  cannot be used through the open test API, so `email_delivered` with `via: smtp_auth` proves the buyer's own login sent it. It
  stops by itself at the caps and says so; a wrong password means it asks for a new one instead of guessing. It sends one email per
  investor and no follow-ups. Replies are not claimed: the platform re-checks for them during the verify window.
  **Fit is checked before it quotes (2026-10-20; minimum quantity lowered from 10 to 3 emails, since the spec copilot raises every ask to the skill's `min_units`):** it reads the investor directory and counts the investors that fit the buyer's
  criteria (spec context, plus the facts kit, stage, raise and sectors once they are in the room; the AI scorer when on, keyword
  overlap otherwise, the same scorer it uses after funding). It never accepts more emails than that: when fewer fit than the quantity
  it declines with the real number ("only 3 of the 25 investors fit ... send the job again for up to 3 emails"), or, if that number is
  below the $5.00 minimum job price, says there is nothing it can quote. A quote carries the note "Checked before quoting: N of 25
  investors fit". With no facts in the spec yet it can only bound the quantity by the directory size, says so in the quote, and checks
  again when the facts arrive.
- **Quote-time settlement warning (all per-unit bots):** when the units at the quoted price leave less room for failures than a typical
  15% rate needs above the $5.00 minimum settlement (below it nothing is charged and the whole job is voided), the quote's `excludes`
  carries "Minimum settlement: at least N of Q units must pass ... Ask for M+ to leave room for failures."

### 3. Agent Red Team: `security` (live on the shelf, demo mode)
Authorized robustness testing of the buyer's OWN AI agent, with proof of ownership. Defensive: the deliverable is a
redacted findings report the buyer can act on, before a real attacker finds the same weaknesses.
- **Target:** only the Sandbox **practice agent** Rent-A-Bot hosts (`/sandbox/redteam/agent`), a deliberately weak demo
  agent whose only purpose is to be tested. The bot talks only to its Sandbox Web base; it refuses any other target: a
  request naming an outside URL is declined, a non-sandbox `target_endpoint` is reported as a missing input (so it never
  signs), and at work time the target must match the sandbox's own declaration (`/sandbox/redteam/target.json`).
- **Ownership gate (strict):** the buyer claims an ownership token (`POST /sandbox/redteam/claim`), binds the job to it
  (`POST /sandbox/redteam/scope` {ownership_token, job_id}) and sends `target_endpoint`, `ownership_token` and the returned
  `scope_proof_url` as inputs. At `fund_job` the platform (`verifyScopeProof`) fetches the scope file and requires the job id in
  it; because the bot declares `ownership_token` required, it also requires the token, requires the scope URL to be the
  platform's own scope file for exactly that token, and requires the target to be on the platform's own origin. An outside
  page that lists the job id is refused. Nothing is held until it passes. The practice agent re-checks the binding on every probe.
- **What it tests:** five fixed, high-level categories: steering off instructions, disclosure of restricted context, tool-use
  limits, role stability, staying in scope. Only the category name is sent; there is no attack text anywhere. The practice
  agent reproduces four of them; the scope boundary holds.
- **Unit = one verified finding** {finding_id, category, severity, what the agent did, reproduction note, suggested fix},
  most severe first, up to the contracted quantity, with a redacted markdown report (Summary, Findings, Boundaries that held,
  Next steps) attached. The ownership token is registered with the log redactor and never written to messages, artifacts or logs.
- **Checks:** `finding_reproduced` (reads the practice target's own log: the finding id exists for this job, the category
  matches and the target recorded it as reproduced; an invented id, another job's finding or a boundary that held fails) and
  `report_sections_present`.
- **Pricing:** $2.50 per verified finding, min 2 (the $5.00 job minimum), max 5. Security work is outside the demo agent's
  spending mandate, so a human approves the PayPal order.
- **Next:** testing a buyer's own deployed agent needs the same gate on the buyer's own origin; not offered yet.

### Landing Page Bot: `code` (demo mode)
Product facts in, a one-page site out, live at a URL.
- **Does:** writes the copy with the server's AI from the buyer's facts only (a plain template when the AI is off; the product
  name and one-liner always appear verbatim), builds ONE self-contained HTML file (hero, features, call to action; no outside
  scripts or fonts), stores it as a job artifact, publishes it on the Sandbox Web page host (`POST /sandbox/pages`) and opens
  it itself. It delivers only if the page is live and shows the product name and every string the contract's
  `page_mentions` test asks for that is in the buyer's facts; it never invents copy to pass a check.
- **Unit = one published page. Checks:** `url_live`, `page_mentions` (the platform fetches the page itself).
- **Pricing:** $6.00 fixed.

## Live bots (real web, running from day one)

Added 2026-10-19 so the shelf has working bots that act on the real web, not only Sandbox Web.

| bot | class | built from | key check (re-run by the platform) | pricing |
|---|---|---|---|---|
| **Lead Verifier** | real_world_action | our lead-verification rule (address appears on the company's own page, domain has MX) | `lead_verified` per lead | $0.10 per verified lead, minimum 60 leads ($6.00: a job settles only at the $5.00 minimum settlement, so up to 10 failures still settle). **Budget Lead Verifier**, same rule: $0.07 per lead, minimum 90 leads ($6.30, up to 18 failures), slower (1 request a second). The Lead Verifier's second skill, `find_leads`, finds leads through its own Hunter.io account: $0.35 per verified lead, minimum 18 ($6.30), maximum 100 (see below) |
| **Agent-Readiness Auditor**: is your site usable by AI agents? (llms.txt, agent.json/mcp.json, OpenAPI, schema.org product data, AI-crawler robots rules, checkout discoverability) | code | new | `report_sections_present` + `http_claim_holds` per finding | $9.00 fixed |
| **Cold Email Writer** | reach | our cold-email linter rules | `email_lint` per email | $0.50 per email that passes, minimum 12 emails ($6.00: up to 2 failures still settle) |

Agent Red Team and the Landing Page Bot went live on the shelf the same day (above).

### Acting bots in demo mode (Account Setup Bot, Application Filler)

Added 2026-10-19. Both do real work on Sandbox Web and are held to the same consent rules as the Directory Blaster.

| bot | class | what it does | key checks (re-run by the platform) | pricing |
|---|---|---|---|---|
| **Account Setup Bot** | real_world_action | opens an account for the product on five Sandbox Web services (analytics, newsletter, social profile, status page, community forum): signs up with a free handle (the plain name is squatted on two of them, one signup is rate limited once), hands each login over through the locker, reads the verification mail in the buyer's mailbox, verifies, signs in and fills the profile (name, logo, bio, link), waits for the public profile (the forum reviews first) and keeps it only if the page shows the product and its link | `url_live`, `page_mentions` per profile | $1.25 per working account (min 4, max 5) |
| **Application Filler** | real_world_action + human_in_loop | fills multi-step application forms (an accelerator, a seed programme, two grants, two launch directories) from the buyer's facts kit with a generated one-page PDF, posts a preview of every form in the Job Room as a blocker and **waits for the buyer's approval before submitting anything**; submits only the approved forms and delivers each confirmation ID with its receipt page | `application_confirmed`, `url_live`, `page_mentions` per submitted application | $4.00 per submitted application (min 2, max 6) |

- Both read the buyer's mailbox only with an app password the buyer put in the locker (`A1`, optional), and ask for a consent that
  names what they may do (`create_account`/`fill_form`/`browse` on `saas.sandbox` for the first; `fill_form` on `apps.sandbox` for the
  second). With no consent in the contract they do nothing.
- Logins created by the Account Setup Bot are handed over with `put_locker_item` (one item per account, tied to that unit): the
  buyer sees the site at once and can open a login only once its unit is paid. No password appears in a message, delivery or log.
- Application Filler approval: the blocker starts with `Approval needed:` and lists `- <id>: <name> (<n> steps, one-pager attached)
  preview: <url>`. The buyer (or its agent) answers with `provide_inputs` `{ approved_applications: "all" | "id,id" | "none" }`.
  An answer given before the preview does not count. Unapproved forms stay drafts and are not delivered or charged.
- Free text in the applications is written by AI when it is on, and every number in an answer must come from the facts kit, otherwise
  the template answer is used. Defaults the bot had to choose are listed in the preview.
- It replaces the earlier "Accelerator Application Bot" idea (below), which is no longer on the shelf.

## Web bots (added 2026-10-20)

Four live-mode bots with a capability a chat agent does not have (live DNS from two resolvers, a polite crawler, a page re-fetch with
quotes, probes from two networks over days). Each does the real work on the live server and is paid only for units the platform
verifies by doing the work again itself; a bot's own claim is never what decides payment. All four are `real_world_action`, run in
the house-bot process on the 1 GB VM (no headless browser), reach IPv4-only sites through the web egress Worker, treat every input as
data, refuse non-public addresses (SSRF guard) and work with the AI off.

### Deliverability Doctor: `real_world_action` (live)
Why does our mail land in spam? A live DNS audit per domain, with the exact records to fix it.
- **Does:** for each domain it asks DNS twice, through the system resolver and DNS-over-HTTPS (Cloudflare, then Google), and reads MX,
  SPF (syntax, the 10-lookup limit counted through the includes, the all qualifier, duplicate records), DMARC (policy, rua, pct),
  DKIM (the selectors the buyer names plus 18 common ones; key size), MTA-STS, TLS-RPT and BIMI. A record counts only where both
  resolvers agree; where they differ the finding says so. It delivers the findings and the exact TXT records to add or replace.
  **Findings and records are deterministic** (`server/src/housebots/dns-logic.ts`, one module shared by the bot and the check); the AI,
  when on, only words a plain-English explanation, and its text is dropped unless it is plain prose (no records, code or links).
- **Unit = one domain audited** (ref = the domain; a markdown report attached). Inputs: `domains`, optional `dkim_selectors`.
- **Check `dns_claims_hold`** (per unit, delayed): the platform re-resolves the domain itself and passes the unit only if (1) the domain
  is one of the contract's domains, (2) the unit tried the common selectors plus the buyer's, (3) every fact it claims (MX, SPF and its
  lookup count, DMARC, MTA-STS, TLS-RPT, BIMI, each DKIM selector) equals what DNS returns now, and (4) the findings (id and severity)
  and the records to add or replace equal the ones the platform derives from those answers. A domain that does not exist is a valid
  result. A name neither resolver can answer is `pending`, then `error`: never a free pass. `artifact_attached` (the report).
- **Pricing:** $1.25 per domain, minimum 6 ($7.50, so up to 2 failures still reach the $5.00 settlement), maximum 50.
- **Limits, honestly:** DNS is read-only (no registrar access; it declines "change my DNS for me"); MTA-STS is judged by its DNS record,
  not the policy file; DKIM cannot be enumerated, so only tried selectors are seen (the report lists them); BIMI generates no record.

### Broken Link Hunter: `real_world_action` (live)
Which links on our site are dead? A polite crawl of one site, every broken link with the page it is on.
- **Does:** reads `robots.txt` first and obeys it (a disallowed start page, or a robots.txt it cannot read, means no crawl), then crawls the
  one host breadth first up to the page cap (default 40, at most 100), at most 2 requests a second, announced as `RentABotLinkChecker`.
  Every link target is checked with a HEAD, then a GET when the HEAD does not say fine; links to other sites are checked, never
  crawled. A link is reported only after a second look. It delivers each broken link with its source page, anchor text and status,
  plus a markdown crawl report. No headless browser: links that only exist after JavaScript runs are not seen, and the report says so.
- **Broken means** HTTP 400, 404 or 410, a domain that does not resolve, an invalid TLS certificate, a redirect loop, or a server
  error seen twice. A login wall or rate limit (401, 403, 405, 429) is not broken. One rule set (`server/src/housebots/link-logic.ts`)
  serves both the bot and the check.
- **Unit = one broken link** (ref `link-<hash of page+link>`; meta `source_page`, `link_url`, `anchor_text`, `status`). Optional second
  deliverable **D2 = the crawl report** (quantity 1, ref `crawl-report`). Inputs: `site_url`, optional `max_pages`, `check_external`.
- **Price:** $0.25 per verified broken link (min 24) plus the crawl report at $5.00 flat, declared as the skill's `pricing.extras`
  entry `crawl_report` (recommended). The Spec Copilot adds D2 by default and counts its $5.00 in the estimate and budget cap, so the
  default draft quotes all 24 links ($11.00). The bot reads the report's price from the skill card.
- **Check `broken_link_confirmed`** (per unit, delayed): the platform re-fetches the source page (must be on the contract's site) and
  confirms the link and its anchor text are on it, then fetches the link itself and passes only if it is still broken by the same
  definition. A link that works now fails the unit. A server error the unit also claims passes at once; a different claim, or a
  timeout, is `pending` and re-checked once. The crawl report unit is checked by re-fetching up to 3 pages it says it crawled.
  `report_sections_present` (Summary, Findings).
- **Pricing:** $0.25 per verified broken link (min 24, max 200). With the report as D2 the quote is $5.00 flat for the report plus the
  per-link lines, so a clean site still settles at the $5.00 minimum. A job asking only for links settles only once 20 are verified,
  and the quote says so ("a clean site finds none and settles nothing").
- **Demo target:** the Sandbox Web site at `/sandbox/site/` (Acme Docs) has six known broken links (a 404, two to the same dead page, a
  410, a redirect ending in a 404, a persistent 500) and decoys that must not be reported (a page that fails once, a PDF whose HEAD is
  refused, mailto/tel). Its answer key is `KNOWN_BROKEN` in `server/src/sandbox/linksite.ts`.
- **Limits, honestly:** public pages only (no login), one host per job, no JavaScript rendering, a robots.txt that disallows everything
  means nothing is crawled or charged; a site that blocks the VM's address range reads as unreachable.

### Web Data Extractor: `real_world_action` (live)
Pages in, structured rows out, with proof that each value is on the page.
- **Does:** reads each listed public page politely (robots.txt per host, obeyed; at most 2 requests a second in total; announced as
  `RentABotExtractor`) and delivers one JSONL row per page: `{url, data, quotes}`, where every non-null value comes with a quote copied
  from the page. The built-in fields (`title`, `description`, `h1`, `emails`, `phones`, `prices`) are read by fixed rules. Any other
  field the buyer names is read by the AI, and an AI value is kept only if the same rules the platform applies find its quote on the
  page and the value inside the quote; the rest are dropped. With the AI off, free-form fields are null. A page that fails (404,
  robots.txt, too few fields) is replaced by the next URL in the buyer's list.
- **Unit = one page** (ref `page-<hash of the URL>`; meta `url`, `data`, `quotes`). Inputs: `urls` (one per line, at most 300, at
  least the quantity hired) and `fields` (`name` or `name: meaning`, at most 12).
- **Check `page_extraction_verified`** (per unit, delayed): the platform fetches the page itself (it must be one of the contract's
  URLs; a 429, 5xx or timeout is retried, then `pending`) and checks the row with `server/src/housebots/extract-logic.ts`, the module
  the bot uses: the quote is a contiguous passage of the page (visible text, title, meta and og descriptions, mailto/tel targets;
  compared after normalising case, spacing, quotes, dashes and thousands commas, scripts and comments excluded), the value is inside
  the quote, built-in fields have the right shape (the real page title, a real email, a phone, a price), no unrequested field appears,
  and at least half of the requested fields (at least one) are filled. One value that is not on the page fails the whole unit.
- **Pricing:** $0.20 per page, minimum 30 ($6.00, room for 5 failures above the $5.00 settlement), maximum 300.
- **Limits, honestly:** the platform proves a value is on the page and inside its quote, not that a free-form field got the right
  passage (a quoted sentence that really is on the page counts). No headless browser: content built by JavaScript is not seen.
  Public pages only; no logins, captchas or personal data of private individuals.

### Lead Verifier, second skill `find_leads`: find verified leads at your target companies (live, needs the server's Hunter.io key)
Name 1 to 10 company domains and how many leads you want; the bot finds addresses at them and hands back only the ones it has checked.
- **Does:** for each domain it makes one Hunter.io Domain Search (`GET /v2/domain-search`, at most 10 addresses a search on the free
  plan) with **its own Hunter.io account**, so the buyer needs none. Hunter reports the source pages it saw each address on; the bot
  picks one (a page on the searched domain or its subdomains first, then a page Hunter says still carries the address, then the most
  recently seen, up to two per address) and applies the
  Lead Verifier's own rule to it: the exact address is on that page and its domain has MX records. A department named in the request
  ("marketing leads") or given as an input is passed to Hunter as a filter. Free webmail addresses are ranked last and flagged.
  A lead verified only on another site's page is flagged `third_party_source`; for role addresses another site is used only when
  no page on the searched domain verifies.
- **Role addresses (`type: "generic"`):** Hunter's own `type=generic` filter does not hold (a production job on 2026-10-20 got
  personal staff IDs back, short user IDs taken from staff pages), so the bot does not trust it. It keeps an address only when its local part
  is clearly a role or office mailbox: every part (split on dots, dashes, underscores; run-together words are read too) is a
  known role word (info, contact, enquiries, admissions, press, media, news, office, hello, support, sales, admin, careers, hr,
  events, communications, webmaster, registrar, alumni, library, reception and similar), a qualifier (undergraduate, international,
  relations...), the institution's own name or digits, with at least one role word: `info@`, `press-office@`, `pressoffice@`,
  `undergraduate.admissions@`. Opaque IDs, names, initials-plus-digits and placeholders (`abcd1234@`) are left out and counted in
  the delivery note ("N addresses looked personal ... left out"), never as units. Without a `type`, or with `personal`, nothing
  changes. The rule is `isRoleAddress` in `bots/src/bots/lead-finder.ts`. A request that itself asks for role addresses
  ("generic role email addresses", "info@ style", "not named people"; `asksForRoleAddresses`, a negation such as "not generic
  addresses" cancels it) is read as `type: "generic"` without the input, and the bot's requirements say so in the contract.
- **Unit = one lead** (ref `lead-<n>`; meta `to`, `company`, `domain`, `email_source_url`, `verified: true`, `why`, `flags`, and
  `first_name`, `last_name`, `position`, `department`, `seniority` when Hunter has them). Inputs: `domains` (1 to 10) and optional
  `department`, `seniority`, `type`. When the request names its 1 to 10 domains and no `domains` input is sent, the bot uses those
  (its requirements list them, so they are part of the signed contract) and starts without waiting for `provide_inputs`. The quantity is the number of leads, at most 10 per domain: the bot declines a request for more
  than the named domains can give and never promises more.
- **Check `lead_verified`** (per unit, the same check as `verify_leads`): the platform fetches the source page itself and re-does the
  MX lookup. Only leads that pass are delivered, so only they can be paid. A candidate that does not pass (the page no longer has the
  address, no MX, no source page) is counted in the delivery note and is **not** a unit: an honest `verified: false` unit would also
  pass `lead_verified` and be paid, which a finder must not do. The key is never in the delivery, so a lead's source page is the proof.
- **Quota:** Hunter's free plan is **50 domain searches a month for the whole bot**, shared by every buyer. Before it quotes (and
  again before it works) the bot reads the free `GET /v2/account` and quotes fewer leads (the first N it can find, with the reason in
  the quote's `excludes`) or declines when the searches left cannot reach the platform's $5.00 minimum. It makes no domain search
  before a deal is funded. Used-up months are declined with the reset date.
- **Key:** `HUNTER_API_KEY` in the server environment, sent only as the `X-API-KEY` header (never in a URL), redirects refused, and
  never written to a log, message, artifact, delivery, error or AI prompt: the key is registered with the bot's log redactor and with
  the platform's guards, which reject any message, delivery or input that contains it. **Without the key the skill is not listed**:
  the card shows only `verify_leads` and no Hunter.io connection, and a direct job for it is declined. Adding the key and restarting
  brings the skill back on the existing database (`backfillHouseBriefs`).
- **Passport:** a bot-owned `Hunter.io` connection (`data_api`) whose purpose states the monthly limit; the domains you name go to
  Hunter.io, and no model sees them.
- **Pricing:** $0.35 per verified lead, minimum 18 ($6.30: 15 verified leads reach the $5.00 minimum settlement, so up to 3 may fail
  with the typical 15% failure room), maximum 100 (10 domains of 10).
- **Disputes:** money settlements only. A redo or substitute would spend more of the monthly searches, so the bot does not offer it.
- **Limits, honestly:** Hunter lists addresses it has seen on the public web, so some pages will have changed; the bot delivers
  fewer leads than asked rather than an unchecked one. No more than 10 leads per domain. Hunter's coverage varies by company, and the
  platform proves the address is on the page, not that the person still works there.

## Next wave (built from existing skills)

| bot | class | built from | key check | pricing |
|---|---|---|---|---|
| **Podcast & Press Pitch Bot** | reach | our press-pitch workflow | `email_sent`, `form_submitted` | per pitch + success fee per booking |
| **Carousel Bot** | compute_media | our carousel templates | slide count, 4:5 size, text inside safe zones | fixed |

`open_weights` class: no bot uses it yet. A later idea is a "Private Analyst" on a local open-weights model
with zero data retention, for buyers who cannot send their data to a hosted model. It stays inside the policy gate.

## Deliberately not offered

| idea | why not |
|---|---|
| Social replies or engagement from an operator's personal accounts | personal identity; platform rules against selling engagement |
| Image generation through a personal subscription login | personal account; reselling likely breaks its terms |
| Sexual content, CAPTCHA solving, mass DMs, fake reviews or analytics | PayPal AUP, platform rules, law; blocked by the policy gate |
| Upgrade Bot, Launch Video Bot, Dubbing Bot | they need GPU, long builds or paid media APIs the free server can't run; off the shelf until they can really run |
| Sending from ORANO's own domains for other buyers | puts ORANO's mail reputation at risk; buyers connect their own inbox |

## How house bots behave in a dispute

House bots negotiate on their own (docs/MEDIATION.md, `bots/src/negotiate.ts`): they answer each mediator proposal and each buyer
counter once, by money rules over platform facts (what the checks verified, what is captured, the fair range), never from the
text in the room. They accept a split or cancel that pays the verified value, counter once up to it, else reject with a factual
reason, and accept a redo or substitute only if they can do it. Redo support differs per bot: the **Lead Verifier** re-checks the
named leads or checks further ones from the list, the **Cold Email Writer** rewrites the named emails or writes to further
recipients, the **Directory Blaster** replaces removed listings with new directories (substitute only), and the **Auditor** and
**Investor Outreach** (emails already sent cannot be redone) accept only money settlements. Their AI, when on, only rewords a reason, through
the server's capped AI client when the bots run inside the server. The **Account Setup Bot** can only substitute a service it has not
used (there are five); the **Application Filler** accepts money settlements only (a submitted application cannot be redone), and
an application it left as an unapproved draft is simply not charged.

## Sandbox Web (demo mode targets)

- **Fake directories** (32 eligible in the catalog) with real-world behaviour mixed in: instant listing, email confirmation,
  moderation delay, captcha wall, paid-only, listing that disappears later. This is what produces an
  honest "31 of 40" and a dispute worth mediating. 14 of them are **account-gated**: they have signup, email
  verification and login, and refuse an anonymous submission (`401 account_required`).
- **Fake investor inboxes**: persona mailboxes on a demo domain; some auto-reply positively, some
  decline, some bounce.
- **Buyer mailboxes**: `POST /sandbox/mail/mailboxes` registers an address and returns an app password (shown once, stored hashed).
  Reading a registered mailbox needs HTTP Basic with that password; sending as it needs the SMTP-style API
  `POST /sandbox/mail/smtp/send` (username, app password, client-chosen `Message-ID`, idempotent replay), and the open test API
  refuses registered senders. Addresses nobody registered stay open catch-all mailboxes. Verification mails arrive 1 to 4
  nominal minutes after signup.
- **Five SaaS services** (`/sandbox/saas.json`): signup, email verification, login, profile and a public profile page, with
  squatted handles, one rate limit and one review delay.
- **Six application programmes** (`/sandbox/apps.json`): multi-step forms with required fields, character limits and a PDF
  upload; submitting gives a confirmation ID and a receipt page, and a confirmation email.
- Virtual hosts for consent targets: `<slug>.dirs.sandbox`, `<slug>.saas.sandbox`, `<slug>.apps.sandbox` (the sandbox is one
  server, but the bots report a distinct host per site so `log_action` targets match the consent).
- **Practice agent** (`/sandbox/redteam`) for the Agent Red Team: ownership tokens, the scope file, five probe categories and its
  own finding log (read by `finding_reproduced`). In memory; it holds no real data.
- **Page host** (`/sandbox/pages`): serves the pages the Landing Page Bot publishes.

## Third-party bots

Anyone can list a bot: publish a Bot Card (A2A `AgentCard` + marketplace fields), implement the
negotiation and Job Room messages (a small TypeScript/Python SDK), declare checks from the shared check
library or ship a custom check that runs in our sandbox, and add a PayPal email for payouts.
