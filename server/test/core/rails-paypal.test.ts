import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.ts'
import { createPayPalRail, fitId } from '../../src/rails/paypal.ts'
import { PaymentError } from '../../src/rails/types.ts'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}
type Reply = { status: number; json?: unknown } | Error

/** Mock fetch: answers the token endpoint itself, everything else from `replies` in order. */
function mock(replies: Reply[], tokenTtl = 32400) {
  const calls: Call[] = []
  let tokens = 0
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined })
    if (url.endsWith('/v1/oauth2/token')) {
      tokens++
      return new Response(JSON.stringify({ access_token: `TOK${tokens}`, token_type: 'Bearer', expires_in: tokenTtl }), { status: 200 })
    }
    const r = replies.shift()
    if (!r) throw new Error(`unexpected call ${url}`)
    if (r instanceof Error) throw r
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status: r.status })
  }) as typeof globalThis.fetch
  return { calls, fetch, api: () => calls.filter((c) => !c.url.endsWith('/oauth2/token')) }
}

let clock = 1_000_000
const rail = (fetch: typeof globalThis.fetch, env: 'sandbox' | 'live' = 'sandbox', webhookId = 'WH-ID') =>
  createPayPalRail({ clientId: 'cid', clientSecret: 'shh-secret', webhookId, env, fetch, now: () => clock })

const AUTH = { id: 'AUTH1', status: 'CREATED', amount: { currency_code: 'USD', value: '25.00' }, expiration_time: '2026-11-17T00:00:00Z' }
const orderParams = {
  job_id: 'job_1',
  request_id: 'job_1:fund:1',
  amount_cents: 2500,
  currency: 'USD' as const,
  contract_hash: 'sha256:abc',
  description: 'x'.repeat(200),
  vault_id: null,
  return_url: 'https://app/return',
  cancel_url: 'https://app/cancel',
  brand_name: 'Rent-A-Bot',
}

describe('paypal rail', () => {
  it('fetches a token with Basic auth and caches it until ~60 s before expiry', async () => {
    const m = mock([{ status: 200, json: { id: 'O1', status: 'CREATED' } }, { status: 200, json: { id: 'O1', status: 'CREATED' } }, { status: 200, json: { id: 'O1', status: 'CREATED' } }], 3600)
    const r = rail(m.fetch)
    expect(r.kind).toBe('paypal_sandbox')
    await r.getOrder('O1')
    await r.getOrder('O1')
    const tok = m.calls.filter((c) => c.url.endsWith('/v1/oauth2/token'))
    expect(tok).toHaveLength(1)
    expect(tok[0]!.url).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token')
    expect(tok[0]!.headers.Authorization).toBe(`Basic ${Buffer.from('cid:shh-secret').toString('base64')}`)
    expect(tok[0]!.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(tok[0]!.body).toBe('grant_type=client_credentials')
    expect(m.api()[0]!.headers.Authorization).toBe('Bearer TOK1')
    clock += (3600 - 59) * 1000
    await r.getOrder('O1')
    expect(m.calls.filter((c) => c.url.endsWith('/v1/oauth2/token'))).toHaveLength(2)
    expect(m.api()[2]!.headers.Authorization).toBe('Bearer TOK2')
  })

  it('creates a vaulted AUTHORIZE order with idempotency header and maps an embedded authorization', async () => {
    const m = mock([
      {
        status: 201,
        json: { id: 'O2', status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [AUTH] } }], links: [{ rel: 'self', href: 'x' }] },
      },
    ])
    const out = await rail(m.fetch).createOrder({ ...orderParams, vault_id: 'vtok_1' })
    const c = m.api()[0]!
    expect(c.url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders')
    expect(c.method).toBe('POST')
    expect(c.headers['PayPal-Request-Id']).toBe('job_1:fund:1')
    expect(c.headers.Prefer).toBe('return=representation')
    expect(c.headers['Content-Type']).toBe('application/json')
    const b = JSON.parse(c.body!)
    expect(b.intent).toBe('AUTHORIZE')
    expect(b.purchase_units[0]).toMatchObject({ reference_id: 'job_1', custom_id: 'sha256:abc', amount: { currency_code: 'USD', value: '25.00' } })
    expect(b.purchase_units[0].description).toHaveLength(127)
    expect(b.payment_source.paypal.vault_id).toBe('vtok_1')
    expect(b.payment_source.paypal.stored_credential.payment_initiator).toBe('MERCHANT')
    expect(out).toEqual({
      order_id: 'O2',
      status: 'COMPLETED',
      approval_url: null,
      authorization: { authorization_id: 'AUTH1', status: 'CREATED', amount_cents: 2500, expires_at: '2026-11-17T00:00:00Z' },
    })
  })

  it('creates an approval-link order without a vault token', async () => {
    const m = mock([
      {
        status: 200,
        json: {
          id: 'O3',
          status: 'PAYER_ACTION_REQUIRED',
          links: [
            { rel: 'self', href: 'https://api/o/O3' },
            { rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=O3' },
          ],
        },
      },
    ])
    const out = await rail(m.fetch).createOrder(orderParams)
    const b = JSON.parse(m.api()[0]!.body!)
    expect(b.payment_source.paypal.vault_id).toBeUndefined()
    expect(b.payment_source.paypal.experience_context).toMatchObject({
      return_url: 'https://app/return',
      cancel_url: 'https://app/cancel',
      brand_name: 'Rent-A-Bot',
      shipping_preference: 'NO_SHIPPING',
    })
    expect(out.approval_url).toBe('https://www.sandbox.paypal.com/checkoutnow?token=O3')
    expect(out.authorization).toBeNull()
  })

  it('authorizes an approved order with an empty body', async () => {
    const m = mock([{ status: 201, json: { id: 'O4', status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [AUTH] } }] } }])
    const out = await rail(m.fetch).authorizeOrder({ order_id: 'O4', request_id: 'job_1:authorize:1' })
    const c = m.api()[0]!
    expect(c.url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders/O4/authorize')
    expect(c.body).toBe('{}')
    expect(c.headers['PayPal-Request-Id']).toBe('job_1:authorize:1')
    expect(out.authorization?.authorization_id).toBe('AUTH1')
  })

  it('captures with amount and final_capture', async () => {
    const m = mock([{ status: 201, json: { id: 'CAP1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '12.50' }, final_capture: false } }])
    const out = await rail(m.fetch).captureAuthorization({ authorization_id: 'AUTH1', request_id: 'job_1:release:1', amount_cents: 1250, final_capture: false, note: 'milestone 1' })
    const c = m.api()[0]!
    expect(c.url).toBe('https://api-m.sandbox.paypal.com/v2/payments/authorizations/AUTH1/capture')
    expect(JSON.parse(c.body!)).toEqual({ amount: { currency_code: 'USD', value: '12.50' }, final_capture: false, note_to_payer: 'milestone 1' })
    expect(out).toMatchObject({ capture_id: 'CAP1', status: 'COMPLETED', amount_cents: 1250, final_capture: false })
  })

  it('voids (204 No Content)', async () => {
    const m = mock([{ status: 204 }])
    expect(await rail(m.fetch).voidAuthorization({ authorization_id: 'AUTH1', request_id: 'job_1:void:1' })).toEqual({ status: 'VOIDED' })
    const c = m.api()[0]!
    expect(c.url).toBe('https://api-m.sandbox.paypal.com/v2/payments/authorizations/AUTH1/void')
    expect(c.headers['PayPal-Request-Id']).toBe('job_1:void:1')
  })

  it('reauthorizes and returns the new authorization', async () => {
    const m = mock([{ status: 201, json: { id: 'AUTH2', status: 'CREATED', expiration_time: '2026-11-17T00:00:00Z' } }])
    const out = await rail(m.fetch).reauthorize({ authorization_id: 'AUTH1', request_id: 'job_1:reauth:1', amount_cents: 2500 })
    expect(m.api()[0]!.url).toBe('https://api-m.sandbox.paypal.com/v2/payments/authorizations/AUTH1/reauthorize')
    expect(JSON.parse(m.api()[0]!.body!)).toEqual({ amount: { currency_code: 'USD', value: '25.00' } })
    expect(out).toEqual({ authorization_id: 'AUTH2', status: 'CREATED', amount_cents: 2500, expires_at: '2026-11-17T00:00:00Z' })
  })

  it('refunds a capture', async () => {
    const m = mock([{ status: 201, json: { id: 'R1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '5.00' } } }])
    const out = await rail(m.fetch).refundCapture({ capture_id: 'CAP1', request_id: 'job_1:refund:1', amount_cents: 500, note: 'split' })
    expect(m.api()[0]!.url).toBe('https://api-m.sandbox.paypal.com/v2/payments/captures/CAP1/refund')
    expect(JSON.parse(m.api()[0]!.body!)).toEqual({ amount: { currency_code: 'USD', value: '5.00' }, note_to_payer: 'split' })
    expect(out).toEqual({ refund_id: 'R1', status: 'COMPLETED', amount_cents: 500 })
  })

  it('sends a one-item payout', async () => {
    const m = mock([{ status: 201, json: { batch_header: { payout_batch_id: 'B1', batch_status: 'PENDING', sender_batch_header: {} } } }])
    const out = await rail(m.fetch).payout({ request_id: 'job_1:payout:1', sender_item_id: 'job_1', receiver_email: 'seller@example.com', amount_cents: 1188, note: 'Job job_1' })
    const c = m.api()[0]!
    expect(c.url).toBe('https://api-m.sandbox.paypal.com/v1/payments/payouts')
    expect(c.headers['PayPal-Request-Id']).toBe('job_1:payout:1')
    const b = JSON.parse(c.body!)
    expect(b.sender_batch_header.sender_batch_id).toBe('job_1:payout:1')
    expect(b.items).toEqual([{ recipient_type: 'EMAIL', receiver: 'seller@example.com', amount: { value: '11.88', currency: 'USD' }, note: 'Job job_1', sender_item_id: 'job_1' }])
    expect(out).toEqual({ batch_id: 'B1', status: 'PENDING', item_id: null })
  })

  it('creates a vault setup token and a payment token', async () => {
    const m = mock([
      { status: 201, json: { id: 'ST1', status: 'PAYER_ACTION_REQUIRED', customer: { id: 'cus_1' }, links: [{ rel: 'approve', href: 'https://sandbox.paypal.com/agreements/approve?token=ST1' }] } },
      { status: 201, json: { id: 'PT1', customer: { id: 'cus_1' } } },
    ])
    const r = rail(m.fetch)
    const st = await r.createVaultSetupToken({ mandate_id: 'm1', request_id: 'm1:setup:1', return_url: 'https://app/r', cancel_url: 'https://app/c', brand_name: 'Rent-A-Bot', description: 'Agent spending mandate' })
    expect(st).toEqual({ setup_token_id: 'ST1', status: 'PAYER_ACTION_REQUIRED', approval_url: 'https://sandbox.paypal.com/agreements/approve?token=ST1' })
    const b1 = JSON.parse(m.api()[0]!.body!)
    expect(m.api()[0]!.url).toBe('https://api-m.sandbox.paypal.com/v3/vault/setup-tokens')
    expect(b1.payment_source.paypal).toMatchObject({ usage_type: 'MERCHANT', description: 'Agent spending mandate', experience_context: { return_url: 'https://app/r', cancel_url: 'https://app/c', brand_name: 'Rent-A-Bot' } })
    const pt = await r.createPaymentToken({ setup_token_id: 'ST1', request_id: 'm1:token:1' })
    expect(m.api()[1]!.url).toBe('https://api-m.sandbox.paypal.com/v3/vault/payment-tokens')
    expect(JSON.parse(m.api()[1]!.body!)).toEqual({ payment_source: { token: { id: 'ST1', type: 'SETUP_TOKEN' } } })
    expect(m.api()[1]!.headers['PayPal-Request-Id']).toBe('m1:token:1')
    expect(pt).toEqual({ payment_token_id: 'PT1', customer_id: 'cus_1' })
  })

  describe('verifyWebhook', () => {
    const headers = {
      'PayPal-Auth-Algo': 'SHA256withRSA',
      'paypal-cert-url': ['https://api.paypal.com/cert.pem'],
      'paypal-transmission-id': 'tid',
      'paypal-transmission-sig': 'sig',
      'Paypal-Transmission-Time': '2026-10-19T00:00:00Z',
    }
    const raw = '{"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"amount":{"value":"1.10"}}}'

    it('returns true on SUCCESS and sends the raw event verbatim', async () => {
      const m = mock([{ status: 200, json: { verification_status: 'SUCCESS' } }])
      expect(await rail(m.fetch).verifyWebhook(headers, raw)).toBe(true)
      const c = m.api()[0]!
      expect(c.url).toBe('https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature')
      expect(c.body!.endsWith(`"webhook_event":${raw}}`)).toBe(true)
      expect(JSON.parse(c.body!)).toMatchObject({
        auth_algo: 'SHA256withRSA',
        cert_url: 'https://api.paypal.com/cert.pem',
        transmission_id: 'tid',
        transmission_sig: 'sig',
        transmission_time: '2026-10-19T00:00:00Z',
        webhook_id: 'WH-ID',
        webhook_event: { id: 'WH-1' },
      })
    })

    it('returns false on FAILURE', async () => {
      const m = mock([{ status: 200, json: { verification_status: 'FAILURE' } }])
      expect(await rail(m.fetch).verifyWebhook(headers, raw)).toBe(false)
    })

    it('returns false without calling PayPal when headers or webhook id are missing', async () => {
      const m = mock([])
      const { 'paypal-transmission-sig': _drop, ...partial } = headers
      expect(await rail(m.fetch).verifyWebhook(partial, raw)).toBe(false)
      expect(await rail(m.fetch, 'sandbox', '').verifyWebhook(headers, raw)).toBe(false)
      expect(m.calls).toHaveLength(0)
    })

    it('returns false (does not throw) when PayPal answers 400', async () => {
      const m = mock([{ status: 400, json: { name: 'VALIDATION_ERROR', message: 'bad', debug_id: 'd' } }])
      expect(await rail(m.fetch).verifyWebhook(headers, raw)).toBe(false)
    })
  })

  describe('errors', () => {
    it('422 with details → definitive PaymentError with issue, debug_id and a hint', async () => {
      const m = mock([
        {
          status: 422,
          json: { name: 'UNPROCESSABLE_ENTITY', message: 'The requested action could not be performed.', debug_id: 'dbg123', details: [{ issue: 'INSTRUMENT_DECLINED', description: 'The instrument presented was declined.' }] },
        },
      ])
      const err = await rail(m.fetch).createOrder({ ...orderParams, vault_id: 'v' }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PaymentError)
      const pe = err as PaymentError
      expect(pe.code).toBe('payment_failed')
      expect(pe.definitive).toBe(true)
      expect(pe.httpStatus).toBe(422)
      expect(pe.issue).toBe('INSTRUMENT_DECLINED')
      expect(pe.debugId).toBe('dbg123')
      expect(pe.message).toContain('PayPal UNPROCESSABLE_ENTITY: INSTRUMENT_DECLINED (The instrument presented was declined.)')
      expect(pe.message).toContain('dbg123')
      expect(pe.hint).toMatch(/another payment method/)
      expect(pe.message).not.toContain('shh-secret')
      expect(pe.message).not.toContain('TOK1')
    })

    it('500 → not definitive', async () => {
      const m = mock([{ status: 500, json: { name: 'INTERNAL_SERVER_ERROR', message: 'oops', debug_id: 'd5' } }])
      const err = (await rail(m.fetch).getOrder('O1').catch((e: unknown) => e)) as PaymentError
      expect(err).toBeInstanceOf(PaymentError)
      expect(err.definitive).toBe(false)
      expect(err.httpStatus).toBe(500)
    })

    it('fetch rejection → not definitive', async () => {
      const m = mock([new TypeError('fetch failed')])
      const err = (await rail(m.fetch).voidAuthorization({ authorization_id: 'A', request_id: 'r' }).catch((e: unknown) => e)) as PaymentError
      expect(err).toBeInstanceOf(PaymentError)
      expect(err.definitive).toBe(false)
      expect(err.httpStatus).toBeNull()
    })

    it('401 → refetches the token once and retries with the same request id', async () => {
      const m = mock([{ status: 401, json: { name: 'AUTHENTICATION_FAILURE' } }, { status: 204 }])
      await rail(m.fetch).voidAuthorization({ authorization_id: 'A', request_id: 'job:void:1' })
      expect(m.calls.filter((c) => c.url.endsWith('/oauth2/token'))).toHaveLength(2)
      const api = m.api()
      expect(api).toHaveLength(2)
      expect(api[0]!.headers.Authorization).toBe('Bearer TOK1')
      expect(api[1]!.headers.Authorization).toBe('Bearer TOK2')
      expect(api[1]!.headers['PayPal-Request-Id']).toBe('job:void:1')
    })

    it('a second 401 is thrown', async () => {
      const m = mock([{ status: 401, json: { name: 'AUTHENTICATION_FAILURE', message: 'x' } }, { status: 401, json: { name: 'AUTHENTICATION_FAILURE', message: 'x' } }])
      const err = (await rail(m.fetch).getOrder('O').catch((e: unknown) => e)) as PaymentError
      expect(err.httpStatus).toBe(401)
      expect(err.definitive).toBe(true)
    })
  })

  it('uses the live base URL and kind', async () => {
    const m = mock([{ status: 200, json: { id: 'O1', status: 'APPROVED' } }])
    const r = rail(m.fetch, 'live')
    expect(r.kind).toBe('paypal_live')
    await r.getOrder('O1')
    expect(m.calls.every((c) => c.url.startsWith('https://api-m.paypal.com/'))).toBe(true)
  })

  it('fits long or odd request ids into 108 chars without collisions', () => {
    const long = `job_${'a'.repeat(120)}:release:1`
    const a = fitId(long, 108)
    const b = fitId(long.replace(/1$/, '2'), 108)
    expect(a.length).toBeLessThanOrEqual(108)
    expect(a).not.toBe(b)
    expect(fitId('job_1:fund:1', 108)).toBe('job_1:fund:1')
    expect(fitId('a b', 108)).not.toBe(fitId('a_b', 108))
  })

  // Response shapes below were captured from the real PayPal sandbox on 2026-10-19 (ids and emails replaced by fakes).
  describe('real sandbox shapes', () => {
    it('vault setup token: user_action only (vault_instruction is mutually exclusive with it), approve link from approval_session_id', async () => {
      const m = mock([
        {
          status: 201,
          json: {
            id: 'SETUP0000000000A',
            customer: { id: 'CUSTfake1' },
            status: 'PAYER_ACTION_REQUIRED',
            payment_source: { paypal: { description: 'd', usage_pattern: 'IMMEDIATE', permit_multiple_payment_tokens: false, usage_type: 'MERCHANT', customer_type: 'CONSUMER' } },
            links: [
              { href: 'https://api.sandbox.paypal.com/v3/vault/setup-tokens/SETUP0000000000A', rel: 'self', method: 'GET', encType: 'application/json' },
              { href: 'https://www.sandbox.paypal.com/agreements/approve?approval_session_id=SETUP0000000000A', rel: 'approve', method: 'GET', encType: 'application/json' },
            ],
          },
        },
      ])
      const st = await rail(m.fetch).createVaultSetupToken({ mandate_id: 'm1', request_id: 'm1:vault-setup:1', return_url: 'https://app/r', cancel_url: 'https://app/c', brand_name: 'Rent-A-Bot', description: 'd' })
      const ctx = JSON.parse(m.api()[0]!.body!).payment_source.paypal.experience_context
      expect(ctx.user_action).toBe('CONTINUE')
      expect(ctx).not.toHaveProperty('vault_instruction')
      expect(st.approval_url).toBe('https://www.sandbox.paypal.com/agreements/approve?approval_session_id=SETUP0000000000A')
    })

    it('PayPal refuses user_action together with vault_instruction (the old request shape)', async () => {
      const m = mock([
        {
          status: 422,
          json: {
            name: 'UNPROCESSABLE_ENTITY',
            details: [{ field: '/payment_source/paypal/experience_context', location: 'body', issue: 'MUTUALLY_EXCLUSIVE_FIELDS_PROVIDED', description: 'MUTUALLY_EXCLUSIVE_FIELDS_PROVIDED' }],
            message: 'The requested action could not be performed, semantically incorrect, or failed business validation.',
            debug_id: 'dbgfake1',
          },
        },
      ])
      const err = (await rail(m.fetch).createVaultSetupToken({ mandate_id: 'm', request_id: 'r', return_url: 'u', cancel_url: 'c', brand_name: 'b', description: 'd' }).catch((e: unknown) => e)) as PaymentError
      expect(err.issue).toBe('MUTUALLY_EXCLUSIVE_FIELDS_PROVIDED')
      expect(err.message).toContain('[/payment_source/paypal/experience_context]')
    })

    it('vaulted order: authorizes at once, echoes stored_credential, no approval link', async () => {
      const m = mock([
        {
          status: 201,
          json: {
            id: 'ORDER000000000001',
            intent: 'AUTHORIZE',
            status: 'COMPLETED',
            payment_source: { paypal: { email_address: 'buyer@example.com', account_id: 'ACCTFAKE1', account_status: 'VERIFIED', name: { given_name: 'A', surname: 'B' }, address: { country_code: 'US' }, stored_credential: { payment_initiator: 'MERCHANT', usage_pattern: 'IMMEDIATE', usage: 'SUBSEQUENT' } } },
            purchase_units: [
              {
                reference_id: 'job_1',
                amount: { currency_code: 'USD', value: '30.00' },
                custom_id: 'sha256:abc',
                payments: { authorizations: [{ status: 'CREATED', id: 'AUTH000000000001', amount: { currency_code: 'USD', value: '30.00' }, custom_id: 'sha256:abc', seller_protection: { status: 'ELIGIBLE' }, expiration_time: '2026-11-17T12:23:44Z', links: [] }] },
              },
            ],
            links: [{ href: 'https://api.sandbox.paypal.com/v2/checkout/orders/ORDER000000000001', rel: 'self', method: 'GET' }],
          },
        },
      ])
      const out = await rail(m.fetch).createOrder({ ...orderParams, amount_cents: 3000, vault_id: 'vtok_1' })
      expect(out).toEqual({ order_id: 'ORDER000000000001', status: 'COMPLETED', approval_url: null, authorization: { authorization_id: 'AUTH000000000001', status: 'CREATED', amount_cents: 3000, expires_at: '2026-11-17T12:23:44Z' } })
    })

    it('final capture response carries the real fee and net (seller_receivable_breakdown)', async () => {
      const m = mock([
        {
          status: 201,
          json: {
            id: 'CAP000000000001',
            amount: { currency_code: 'USD', value: '24.00' },
            final_capture: true,
            seller_protection: { status: 'ELIGIBLE', dispute_categories: ['ITEM_NOT_RECEIVED', 'UNAUTHORIZED_TRANSACTION'] },
            seller_receivable_breakdown: { gross_amount: { currency_code: 'USD', value: '24.00' }, paypal_fee: { currency_code: 'USD', value: '1.46' }, net_amount: { currency_code: 'USD', value: '22.54' } },
            custom_id: 'sha256:abc',
            status: 'COMPLETED',
            supplementary_data: { related_ids: { order_id: 'ORDER000000000001', authorization_id: 'AUTH000000000001' } },
          },
        },
      ])
      const out = await rail(m.fetch).captureAuthorization({ authorization_id: 'AUTH000000000001', request_id: 'job_1:capture:1', amount_cents: 2400, final_capture: true })
      expect(out).toEqual({ capture_id: 'CAP000000000001', status: 'COMPLETED', amount_cents: 2400, final_capture: true, paypal_fee_cents: 146, net_cents: 2254 })
    })

    it('reauthorize inside the honor period → 422 REAUTHORIZATION_TOO_SOON with a hint', async () => {
      const m = mock([
        { status: 422, json: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'REAUTHORIZATION_TOO_SOON', description: 'A reauthorization is only allowed once from Day 4 to Day 29 since the date of the original authorization.' }], message: 'x', debug_id: 'dbgfake2' } },
      ])
      const err = (await rail(m.fetch).reauthorize({ authorization_id: 'A', request_id: 'r', amount_cents: 100 }).catch((e: unknown) => e)) as PaymentError
      expect(err.definitive).toBe(true)
      expect(err.issue).toBe('REAUTHORIZATION_TOO_SOON')
      expect(err.hint).toMatch(/day 4 to day 29/)
    })

    it('payout from a platform account in a restricted country → 403 PAYOUT_NOT_AVAILABLE with a hint', async () => {
      const m = mock([{ status: 403, json: { name: 'PAYOUT_NOT_AVAILABLE', message: 'You live in a country that is not allowed to send this payout.', debug_id: 'dbgfake3', information_link: 'https://developer.paypal.com/docs/api/payments.payouts-batch/#errors', links: [] } }])
      const err = (await rail(m.fetch).payout({ request_id: 'r', sender_item_id: 's', receiver_email: 'a@example.com', amount_cents: 100, note: 'n' }).catch((e: unknown) => e)) as PaymentError
      expect(err.definitive).toBe(true)
      expect(err.issue).toBe('PAYOUT_NOT_AVAILABLE')
      expect(err.hint).toMatch(/payouts-capable/)
    })

    it('error issues seen on void / capture / refund after the state changed', async () => {
      const issue = (name: string, issue: string) => ({ status: 422, json: { name, details: [{ issue, description: issue }], message: 'm', debug_id: 'd' } })
      const m = mock([
        issue('UNPROCESSABLE_ENTITY', 'PREVIOUSLY_VOIDED'),
        issue('UNPROCESSABLE_ENTITY', 'AUTHORIZATION_VOIDED'),
        issue('UNPROCESSABLE_ENTITY', 'AUTHORIZATION_ALREADY_CAPTURED'),
        issue('UNPROCESSABLE_ENTITY', 'PREVIOUSLY_CAPTURED'),
        issue('UNPROCESSABLE_ENTITY', 'REFUND_AMOUNT_EXCEEDED'),
      ])
      const r = rail(m.fetch)
      const hints = [
        ((await r.voidAuthorization({ authorization_id: 'A', request_id: '1' }).catch((e) => e)) as PaymentError).hint,
        ((await r.captureAuthorization({ authorization_id: 'A', request_id: '2', amount_cents: 1, final_capture: true }).catch((e) => e)) as PaymentError).hint,
        ((await r.captureAuthorization({ authorization_id: 'A', request_id: '3', amount_cents: 1, final_capture: true }).catch((e) => e)) as PaymentError).hint,
        ((await r.voidAuthorization({ authorization_id: 'A', request_id: '4' }).catch((e) => e)) as PaymentError).hint,
        ((await r.refundCapture({ capture_id: 'C', request_id: '5', amount_cents: 1 }).catch((e) => e)) as PaymentError).hint,
      ]
      expect(hints.every((h) => !/refused this request/.test(h))).toBe(true) // each has a specific hint, not the generic one
    })
  })

  it('reads actual PayPal fees from a capture response', async () => {
    const { captureFees } = await import('../../src/rails/paypal.ts')
    expect(captureFees({ seller_receivable_breakdown: { gross_amount: { value: '46.50' }, paypal_fee: { value: '2.11' }, net_amount: { value: '44.39' } } })).toEqual({ paypal_fee_cents: 211, net_cents: 4439 })
    expect(captureFees({})).toEqual({ paypal_fee_cents: null, net_cents: null })
  })
})

describe('paypal rail egress proxy', () => {
  const proxied = (fetch: typeof globalThis.fetch, extra: { apiBase?: string; egressSecret?: string }) =>
    createPayPalRail({ clientId: 'cid', clientSecret: 'shh-secret', webhookId: 'WH-ID', env: 'sandbox', fetch, now: () => clock, ...extra })

  it('sends every request (token included) to PAYPAL_API_BASE with the egress key header', async () => {
    const m = mock([{ status: 200, json: { id: 'O1', status: 'CREATED' } }])
    await proxied(m.fetch, { apiBase: 'https://egress.example.com/', egressSecret: 'egress-s3cret' }).getOrder('O1')
    expect(m.calls).toHaveLength(2)
    expect(m.calls[0]!.url).toBe('https://egress.example.com/v1/oauth2/token')
    expect(m.calls[1]!.url).toBe('https://egress.example.com/v2/checkout/orders/O1')
    for (const c of m.calls) expect(c.headers['x-egress-key']).toBe('egress-s3cret')
    expect(m.calls[1]!.headers.Authorization).toBe('Bearer TOK1')
  })

  it('keeps the official URL and sends no egress header by default', async () => {
    const m = mock([{ status: 200, json: { id: 'O1', status: 'CREATED' } }])
    await proxied(m.fetch, {}).getOrder('O1')
    expect(m.calls[0]!.url).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token')
    expect(m.calls[1]!.url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders/O1')
    for (const c of m.calls) expect(c.headers['x-egress-key']).toBeUndefined()
  })

  it('treats an empty PAYPAL_API_BASE as unset and the live env keeps its own default', async () => {
    const m = mock([{ status: 200, json: { id: 'O1', status: 'CREATED' } }])
    await createPayPalRail({ clientId: 'c', clientSecret: 's', webhookId: '', env: 'live', apiBase: '  ', fetch: m.fetch, now: () => clock }).getOrder('O1')
    expect(m.calls[0]!.url).toBe('https://api-m.paypal.com/v1/oauth2/token')
  })

  it('reads PAYPAL_API_BASE and PAYPAL_EGRESS_SECRET from the environment', () => {
    const saved = { b: process.env.PAYPAL_API_BASE, s: process.env.PAYPAL_EGRESS_SECRET }
    process.env.PAYPAL_API_BASE = 'https://paypal-egress.example.com/'
    process.env.PAYPAL_EGRESS_SECRET = 'k'
    try {
      const cfg = loadConfig({ sealKey: 'x'.repeat(64) })
      expect(cfg.paypal.apiBase).toBe('https://paypal-egress.example.com')
      expect(cfg.paypal.egressSecret).toBe('k')
    } finally {
      for (const [k, v] of [['PAYPAL_API_BASE', saved.b], ['PAYPAL_EGRESS_SECRET', saved.s]] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})
