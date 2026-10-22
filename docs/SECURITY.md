# The credential locker: security model

Bots on Rent-A-Bot really act: they send email from your inbox, fill forms and create accounts. That means real logins,
passwords and API keys move between buyers and bots. They travel only through the **locker**, one per job, never through
messages, inputs, deliveries or prompts. Code: `shared/src/locker.ts` (schemas, envelope crypto, SDK), `server/src/core/locker.ts`
(gates, shredding, consent receipts), `server/src/intelligence/ai/redact-guard.ts` (guards), `web/src/pages/jobs/sidebar/LockerPanel.tsx`.

## Two directions

| | access | handover |
|---|---|---|
| who puts it in | buyer | seller |
| what | an answer to one of the seller's access requests (A1…): a login, key, token, forwarding address | credentials the bot **created** for the buyer: accounts and passwords, API keys, recovery codes, notes |
| tied to | an `AccessRequest` of the signed contract | a delivered unit (`deliverable_id` + `unit_ref`) |
| who can open it | the seller | the buyer |
| when | while the job is funded and not finished (`IN_PROGRESS` … `APPEALED`), and only while the access request is unchanged since it was shared | once that unit is **paid** (captured) or covered by an agreed settlement |
| shredded | when the job ends (any terminal state) | when the buyer acknowledges it ("I changed the password"), 30 days after release, or at job end if the unit was never paid |

Before release both sides see the metadata (kind, label, site, unit, status and why). A failed or unpaid unit's handover is
never released. Arbiters and the AI mediator never open locker items; they see metadata and the audit.

**Paid** means: the unit passed its checks (rejected units count as failed), and the seller money PayPal has actually captured
(`confirmedSellerGross`), or the part secured by an agreed redo/substitute/wait settlement, covers it. The budget is allocated unit
by unit in delivery order at the quoted unit price; a fixed-price line releases all its units only when the whole line is paid.
A settlement that pays less than the passed units are worth releases only the units it covers.

## Envelope encryption

```
item value  --AES-256-GCM, fresh 256-bit data key (DEK), AAD "rab:locker:v2:<job_id>:<item_id>:<direction>"-->  ciphertext
DEK         --wrapped once per recipient key, AAD "<item AAD>:wrap:<kid>"-->  wraps[]
```

- **End-to-end** (`e2e`, labelled "end-to-end"): the recipient registered an ECDH P-256 public key. The sender's client picks the
  item id (`newLockerItemId()`, bound into the AAD), encrypts, and wraps the DEK for every active key of the recipient with an
  ephemeral ECDH key, HKDF-SHA256 and AES-256-GCM. The server stores ciphertext and wraps it **cannot open**. One WebCrypto
  implementation runs in the browser, in Node and in any runtime (`sealForRecipients`, `openWithPrivateKey`).
- **Sealed** (`sealed`, labelled "sealed by Rent-A-Bot"): for plain MCP/LLM clients that cannot do crypto. The client sends the
  value; the server encrypts it and wraps the DEK under a key-encryption key derived from `SEAL_KEY` (HKDF, separate from the v1
  key). Its `kid` (`srv_…`, a hash of the key) is in every wrap.
- Tampering is detected: moving a ciphertext to another job, item or direction, relabelling a wrap to another kid, using another
  recipient's private key or flipping a bit all fail authentication (`server/test/core/locker.test.ts`).
- The server enforces the gates in **both** modes by withholding the ciphertext and wraps until the rules allow; for e2e items it
  hands out only the wraps made for the caller's *active* keys.

### Keys

- `register_encryption_key` takes a public JWK (a key with `d` is refused) and checks the point is on the curve; several keys per
  agent (devices, runtimes), up to 20 active. `list_encryption_keys {job_id}` returns both parties' active keys with RFC 7638
  fingerprints. `revoke_encryption_key` stops new wraps for that key and stops releasing old ones.
- **Web app:** the browser generates the key pair on first locker use and keeps the private key in IndexedDB. It never leaves
  the browser unencrypted; "Recovery kit" downloads it wrapped under a passphrase (PBKDF2-SHA256, 600k iterations, AES-256-GCM).
- **House bots** (`HOUSE_BOTS=1`) run inside the server process. Their key pair is generated once; the private key is sealed under
  the server key in `DATA_DIR/locker-house-keys.json`, and the public key is registered with `custody: "server_run"`. Items for them
  are e2e in storage and in transit, but **the platform runs the bot**, so treat them like sealed items. The UI says "server-run".
  A handover put by a house bot is marked "sent by a server-run bot": the server saw the value when the bot created it.
- **Third parties:** `lockerClient(call)` in `@rentabot/shared` (re-exported as `lockerFor` in `bots/src/rab.ts` and `agents/src/mcp.ts`)
  registers a key, puts (e2e when the other side has keys, else sealed) and opens.

### Rotating `SEAL_KEY`

Set the new `SEAL_KEY` and put the old one in `SEAL_KEYS_OLD` (comma-separated). At boot every sealed wrap under an old kid is
unwrapped and re-wrapped under the new key, and the house-bot key file is resealed. After one boot the old key can be removed.
A sealed item whose key is gone cannot be opened (the open fails with a clear error); it cannot leak either. Rotation does not
touch e2e items. v1 vault rows (`secrets` table) are migrated into the locker at boot and their v1 ciphertext is wiped.

## Shredding

Crypto-shred deletes the item's ciphertext and **every** wrapped key; metadata, status and the audit stay. The database runs with
`PRAGMA secure_delete = ON` (freed pages are zeroed) and the WAL is checkpointed after shredding, so the bytes leave the file.
Triggers: job end (access items; handovers of unpaid units), `shred_locker_item` (`acknowledged=true` for a taken-over handover),
30 days after a handover's release (scheduler, real time, never demo-scaled), and replacing an access answer.

## Consent and action receipts

An `AccessRequest` may carry `consent`: `actions` (send_email, fill_form, create_account…), `max_total`, `max_per_day`, `targets`
(domains match subdomains, `a@b.c` matches exactly; empty means "only targets the job spec or inputs name") and `until`. Consent is
part of `requirements`, which is part of the contract, so it is **inside the contract hash** both parties sign; changing it resets
the signatures. The buyer sees it in plain words before putting a secret, e.g.
"Investor Outreach may send up to 40 emails (at most 10 a day) via your inbox, only to investors.example, until Nov 3."
Limits count every consented action of one grant together; "a day" is the last 24 hours.

The seller reports every real-world action with `log_action` (action, target, unit, external ref such as a Message-ID). Accepted
actions post to the Job Room timeline and count against the limits. An action outside the consent or over a limit is rejected
(`policy_blocked`), recorded, posted as an "Integrity:" line and counted as an integrity flag on the bot's reputation when the job ends.

**Honest limit:** the platform audits what bots report and what the checks can see. It **cannot prevent** a bot that holds your
inbox password from acting outside the platform. Grant the narrowest access you can (app passwords, scoped tokens, a forwarding
address instead of a password), rotate it after the job, and use the receipts as evidence in a dispute.

## Never leaked

- **Room, inputs, deliveries, statements, reviews, proposals, artifacts, receipts and item labels** go through a guard that rejects
  text containing one of the job's sealed values (exact match, values of 6+ characters) or anything that looks like a credential
  ("password: …", `sk-…`, `AKIA…`, GitHub/Slack/Google tokens, PEM private keys). The error never echoes the value.
- **AI prompts:** every model call (mediator, negotiator, policy gate, copilot, analyst, house bots) goes through `guardAiClient`,
  which replaces registered sealed values and credential patterns before any provider sees them.
- **Events and SSE** carry item ids and statuses only. **Logs**: no value is logged by the server; the bot runtime registers every
  opened value with its log redactor before use. **Errors** never include values.
- **Audit:** every put, open, denied open, release, shred and action, with who, when, which item and which surface
  (`mcp`, `rest`, `web`, `platform`), visible to both parties in `list_locker_items` and the Locker panel.
- Tested: `server/test/core/locker.test.ts` greps the SQLite file and WAL, the events, room, jobs and audit tables, captured console
  output and every input a recording AI provider received; the simulator's `locker_handover` scenario checks the same invariant
  (6) over live HTTP.

## What the server can and cannot read

| | server can read | server cannot read |
|---|---|---|
| sealed items | yes, while they exist (it holds `SEAL_KEY`) | after shredding |
| e2e items for client-held keys | no | the value, ever |
| e2e items for house bots | yes in practice (it runs the bot and holds its key) | |
| metadata, consent, receipts, audit | yes | |

## Known limits

- Sealed items are only as safe as `SEAL_KEY` and the server; prefer e2e. Database backups taken before a shred still contain the
  sealed ciphertext, and with `SEAL_KEY` it can be decrypted: keep backups short-lived and encrypted.
- The redaction guard knows only sealed values; e2e values are invisible to the server, so only the patterns protect them.
  Pattern matching can miss unusual credentials (keyword patterns need "password:"/"api_key=" style separators and a
  value with a digit, so "password: correcthorse" passes) and can block harmless text ("rephrase" is the hint).
- The browser key is extractable (needed for the recovery kit), so script running on the page (XSS, a malicious extension)
  could export it. Lose the browser storage and the recovery kit, and e2e items for that key are gone.
- Key authenticity rests on the server: it could substitute a public key. Compare fingerprints out of band for high-value grants.
- Released handovers are readable by the buyer for 30 days; the seller already knew them. Change the password, then acknowledge.
- The platform cannot see actions a bot takes outside it (see Consent).
