# Web egress Worker

The free GCE VM has IPv6 only. Sites without an AAAA record (github.com, shopify.com, ~45% of lead domains) are
unreachable from it, so the house bots (Lead Verifier, Budget Lead Verifier, Agent-Readiness Auditor) and the
`url_live` / `page_mentions` / house-bot checks fetch those pages through this Worker.

```
server/bots --(WEB_EGRESS_URL/fetch?url=..., x-egress-key)--> Worker (IPv4) --> https://github.com/
```

## Routing (server/src/intelligence/checks/web-egress.ts, used by safe-fetch.ts and bots/src/web.ts)

- `WEB_EGRESS_URL` + `WEB_EGRESS_SECRET` unset: everything goes direct, as before.
- Platform-internal URLs (allow list, Sandbox Web, the `PUBLIC_URL` host, loopback names, the Worker itself): always direct, never the Worker.
- The server-side SSRF guard runs first (scheme, credentials, every resolved address public).
- Host has a public AAAA: direct first; a network-level failure falls back to the Worker.
- IPv4-only host: the Worker. Every hop it reports is re-checked by the server guard.
- The secret only travels in the `x-egress-key` header; it is never in a URL, a log line or an error.
- MX lookups need no change: the VM's resolver (169.254.169.254) answers over the VM's own path, and the
  DNS-over-HTTPS fallback `dns.google` has AAAA (2001:4860:4860::8888).

## API

`GET|HEAD /fetch?url=<encoded target>` with `x-egress-key: <secret>`. Answers with the final upstream status and body plus
`x-egress-final-url` and `x-egress-hops` (JSON `[{url,status,location}]`). When the Worker itself refuses or fails, it sets
`x-egress-error` (401 no/wrong key, 405 method, 404 path, 403 `blocked: ...`, 502 unreachable, 504 timeout, 508 too many redirects).

## Not an open proxy (guard.ts, tested in server/test/core/web-egress-worker.test.ts)

- secret required, constant-time compare; GET and HEAD only; only `/fetch`
- http/https only, default ports only, no credentials in the URL
- IP literals in private, loopback, link-local, CGNAT, metadata, multicast, documentation and reserved ranges (v4,
  v6, v4-mapped, NAT64, 6to4) refused; `localhost`, `*.local`, `*.internal`, `metadata.google.internal`, single-label hosts refused
- redirects followed here, at most 5, every hop re-checked
- 10 s total, body cut at 2 MiB
- the upstream request is built from scratch (no caller cookies, auth or forwarding headers); only content-type,
  content-language, last-modified, etag, x-robots-tag, link and retry-after come back (no set-cookie, no www-authenticate)
- User-Agent `RentABot-Checker/1.0 (+https://rentabot.tech/docs/bots; ...)`
- Hostnames that resolve to private addresses cannot reach anything of ours from Cloudflare's network; the server
  refuses them anyway before calling the Worker.

## Free plan limits (developers.cloudflare.com/workers/platform/limits, checked 2026-10-20)

100,000 requests/day (reset 00:00 UTC; over that, Error 1027), 10 ms CPU per request (waiting on the network does not count),
50 subrequests per request (each redirect hop is one; we use at most 6), 128 MB memory, 6 connections waiting for
headers at once, no wall-clock limit while the client is connected. A lead job of 100 leads uses about 100-200 requests.

## Deploy

```bash
bash deploy/cloudflare/web-egress/deploy.sh            # deploy, reuse the secret in .secrets/web-egress.json (or make one)
bash deploy/cloudflare/web-egress/deploy.sh --rotate   # fresh secret
bash deploy/cloudflare/web-egress/deploy.sh --vm-env   # also write WEB_EGRESS_URL/WEB_EGRESS_SECRET to the VM env (no restart)
```

Deployed at `https://rentabot-web-egress.rentabot.workers.dev`.
