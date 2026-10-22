# PayPal egress Worker

The free GCE VM has no IPv4 and PayPal has no IPv6, so the server sends its PayPal calls through this Worker.

```
server --(PAYPAL_API_BASE, x-egress-key)--> Worker --> https://api-m.sandbox.paypal.com
```

Rules: needs the `x-egress-key` header to equal the `EGRESS_SECRET` secret; GET and POST only; paths under `/v1 /v2 /v3` only;
the upstream origin is fixed by `UPSTREAM` (sandbox or live PayPal, nothing else).

## Deploy (from this folder, with `CLOUDFLARE_API_TOKEN` set)

```bash
npx wrangler deploy
printf '%s' "$EGRESS_SECRET" | npx wrangler secret put EGRESS_SECRET
```

Then on the VM: `bash deploy/gce/write-env.sh PAYPAL_API_BASE=https://<worker-url> PAYPAL_EGRESS_SECRET --restart`
(with `PAYPAL_EGRESS_SECRET` exported locally).

Tested by `server/test/core/paypal-egress-worker.test.ts`.
