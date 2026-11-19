import { webcrypto } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHttpClient } from '../api/httpClient'
import { createPublicOAuthClient, relayPublicOAuthPopupCode, type PublicOAuthRegistration } from './gatewayAuthClient'

const crypto = webcrypto as unknown as Crypto
const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }
const issuer = 'https://issuer.example/tenants/101'
const origin = 'https://portal.example'
const primary = registration('knowledge', 'https://api.example/knowledge')
const secondary = registration('metrics', 'https://api.example/metrics')
let key: CryptoKeyPair
let jwk: JsonWebKey

beforeAll(async () => {
  key = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])
  jwk = { ...await crypto.subtle.exportKey('jwk', key.publicKey), kid: 'primary-key', alg: 'RS256', use: 'sig' } as JsonWebKey
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

function registration(id: string, target: string, realm = issuer, tenantId = '101'): PublicOAuthRegistration {
  return { id, tenantId, issuer: realm, clientId: 'public-' + id, resource: target, apiBaseUrl: target,
    scopes: ['openid', id + ':read'], authorizationEndpoint: realm + '/oauth2/authorize', tokenEndpoint: realm + '/oauth2/token',
    jwksUri: realm + '/.well-known/jwks.json', redirectUri: origin + '/auth/' + tenantId + '/callback',
    popupRedirectUri: origin + '/auth/' + tenantId + '/popup', browserBound: false }
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const bytes = (data: string | Uint8Array) => Buffer.from(data).toString('base64url')
async function jwt(typ: string, claims: Record<string, unknown>) {
  const content = bytes(JSON.stringify({ alg: 'RS256', typ, kid: 'primary-key' })) + '.' + bytes(JSON.stringify(claims))
  const signature = await crypto.subtle.sign(algorithm.name, key.privateKey, new TextEncoder().encode(content))
  return content + '.' + bytes(new Uint8Array(signature))
}

async function tokens(reg: PublicOAuthRegistration, nonce: string, alterId = {}, alterAccess = {}) {
  const now = Math.floor(Date.now() / 1000)
  const common = { iss: reg.issuer, sub: 'subject-123', iat: now, exp: now + 300 }
  const access_token = await jwt('at+jwt', { ...common, aud: [reg.resource], client_id: reg.clientId,
    tenant_id: reg.tenantId, principal_type: 'USER', scope_context: 'TENANT', scope: reg.scopes.join(' '), ...alterAccess })
  const atHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(access_token))
  const id_token = await jwt('JWT', { ...common, aud: [reg.clientId], nonce,
    at_hash: bytes(new Uint8Array(atHash).subarray(0, 16)), ...alterId })
  return { token_type: 'Bearer', expires_in: 300, access_token, id_token }
}

function fixture(registrations = [primary, secondary]) {
  const values = new Map<string, string>()
  const sessionStorage = { getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, value) }, removeItem: (name: string) => { values.delete(name) } }
  const fetch = vi.fn<typeof globalThis.fetch>()
  const navigate = vi.fn<(url: string) => void>()
  const replaceLocation = vi.fn<(url: string) => void>()
  const opts = { registrations, activeResource: registrations[0].id, sessionStorage, fetch, navigate, replaceLocation, crypto }
  const client = createPublicOAuthClient(opts)
  return { values, fetch, navigate, replaceLocation, opts, client }
}

const redirect = (address: URL, responseIssuer?: string) => {
  const url = new URL(address.searchParams.get('redirect_uri')!)
  url.searchParams.set('state', address.searchParams.get('state')!)
  url.searchParams.set('code', 'test-code')
  if (responseIssuer !== undefined) url.searchParams.set('iss', responseIssuer)
  return url.href
}

async function start(f: ReturnType<typeof fixture>) {
  await f.client.login('/dashboard')
  return new URL(f.navigate.mock.lastCall![0])
}

const callbackTokens = (f: ReturnType<typeof fixture>, body: unknown) => {
  f.fetch.mockResolvedValueOnce(json(body)).mockResolvedValueOnce(json({ keys: [jwk] }))
}

describe('tenant public OAuth authorization', () => {
  it.each([false, true])('starts S256, validates a signed response after navigation, and never persists either token (browserBound=%s)', async browserBound => {
    const reg = { ...primary, browserBound }
    const f = fixture([reg, secondary])
    const destination = await start(f)
    expect(destination.origin + destination.pathname).toBe(reg.authorizationEndpoint)
    expect(Object.fromEntries(destination.searchParams)).toMatchObject({ response_type: 'code', client_id: reg.clientId,
      redirect_uri: reg.redirectUri, code_challenge_method: 'S256', resource: reg.resource })
    expect(destination.searchParams.has('client_secret')).toBe(false)
    expect(destination.searchParams.has('browser_binding')).toBe(browserBound)
    if (browserBound) expect(destination.searchParams.get('browser_binding')).toMatch(/^[0-9a-f]{64}$/)
    const [tx] = [...f.values.values()].map(value => JSON.parse(value))
    expect(destination.searchParams.get('code_challenge')).toBe(bytes(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tx.verifier)))))
    expect(new Set([tx.state, tx.nonce, tx.verifier]).size).toBe(3)
    expect([tx.state, tx.nonce, tx.verifier]).toEqual(Array.from({ length: 3 }, () => expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)))

    const signed = await tokens(reg, destination.searchParams.get('nonce')!)
    callbackTokens(f, signed)
    const returned = createPublicOAuthClient(f.opts)
    const callback = redirect(destination, reg.issuer)
    await expect(returned.completeRedirect(callback)).resolves.toMatchObject({ returnTo: '/dashboard', identity: {
      issuer: reg.issuer, tenantId: reg.tenantId, subject: 'subject-123', resource: reg.resource,
    } })
    expect(f.replaceLocation).toHaveBeenCalledWith(reg.redirectUri)
    expect(f.values.size).toBe(0)
    expect(JSON.stringify(returned.identity())).not.toContain(signed.access_token)
    expect(JSON.stringify(returned.identity())).not.toContain(signed.id_token)
    expect(f.fetch.mock.calls.map(([url]) => url)).toEqual([reg.tokenEndpoint, reg.jwksUri])
    expect(f.fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' })
    const body = f.fetch.mock.calls[0][1]?.body as URLSearchParams
    expect(Object.fromEntries(body)).toMatchObject({ grant_type: 'authorization_code', client_id: reg.clientId,
      code: 'test-code', code_verifier: tx.verifier, redirect_uri: reg.redirectUri, resource: reg.resource })
    expect(body.get('browser_binding')).toBe(destination.searchParams.get('browser_binding'))
    expect(body.has('client_secret')).toBe(false)
    expect(returned.authority(reg.id).authorizationHeader()).toBe('Bearer ' + signed.access_token)
    expect(() => returned.authority(secondary.id).authorizationHeader()).toThrow('AUTHORIZATION_REQUIRED')
    expect(createPublicOAuthClient(f.opts).identity()).toBeUndefined()
    await expect(returned.completeRedirect(callback)).rejects.toMatchObject({ code: 'INVALID_CALLBACK' })
    expect(f.fetch).toHaveBeenCalledTimes(2)
  })

  it('requires separate callbacks for distinct tenant issuers, and fixed endpoints and API addresses', () => {
    const f = fixture()
    const other = registration('other', 'https://other.example', 'https://issuer.example/tenants/102', '102')
    for (const input of [{ ...other, redirectUri: primary.redirectUri }, { ...other, tokenEndpoint: primary.tokenEndpoint },
      { ...other, jwksUri: 'https://unregistered.example/jwks' }, { ...other, apiBaseUrl: 'http://resource.example' }]) {
      expect(() => createPublicOAuthClient({ ...f.opts, registrations: [primary, input] })).toThrow('INVALID_CONFIGURATION')
    }
  })

  it('rejects wrong origins, issuer, state and duplicate parameters before the code exchange', async () => {
    const f = fixture()
    const destination = await start(f)
    const callback = redirect(destination)
    await expect(f.client.completeRedirect(callback.replace('portal.example', 'third-party.example'))).rejects.toMatchObject({ code: 'INVALID_CALLBACK' })
    await expect(f.client.completeRedirect(callback + '&code=second')).rejects.toMatchObject({ code: 'INVALID_CALLBACK' })
    const wrongState = new URL(callback)
    wrongState.searchParams.set('state', '0'.repeat(43))
    await expect(f.client.completeRedirect(wrongState.href)).rejects.toMatchObject({ code: 'INVALID_CALLBACK' })
    await expect(f.client.completeRedirect(redirect(destination, 'https://issuer.example/tenants/102'))).rejects.toMatchObject({ code: 'INVALID_CALLBACK' })
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.values.size).toBe(0)
  })

  it('retires an expired transaction without sending the code', async () => {
    const f = fixture()
    const target = await start(f)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300_001)
    await expect(f.client.completeRedirect(redirect(target))).rejects.toMatchObject({ code: 'INVALID_CALLBACK' })
    expect(f.values.size).toBe(0)
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['nonce', { nonce: 'wrong-nonce' }, {}], ['ID audience', { aud: ['another-client'] }, {}],
    ['access audience', {}, { aud: [secondary.resource] }], ['issuer', { iss: 'https://wrong.example' }, {}],
    ['tenant', {}, { tenant_id: '102' }], ['scope', {}, { scope: 'openid excessive:scope' }],
    ['SERVICE token', {}, { principal_type: 'SERVICE' }], ['access hash', { at_hash: 'wrong' }, {}],
  ])('rejects invalid signed %s claims', async (_name, alterId, alterAccess) => {
    const f = fixture()
    const address = await start(f)
    callbackTokens(f, await tokens(primary, address.searchParams.get('nonce')!, alterId, alterAccess))
    await expect(f.client.completeRedirect(redirect(address))).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
    expect(f.client.identity()).toBeUndefined()
    expect(f.values.size).toBe(0)
  })

  it('rejects a changed signature, an unexpected refresh token and misplaced authority responses', async () => {
    const f = fixture()
    let address = await start(f)
    const signed = await tokens(primary, address.searchParams.get('nonce')!)
    const pieces = signed.id_token.split('.')
    pieces[2] = (pieces[2][0] === 'A' ? 'B' : 'A') + pieces[2].slice(1)
    callbackTokens(f, { ...signed, id_token: pieces.join('.') })
    await expect(f.client.completeRedirect(redirect(address))).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
    address = await start(f)
    f.fetch.mockResolvedValueOnce(json({ ...signed, refresh_token: 'unexpected' }))
    await expect(f.client.completeRedirect(redirect(address))).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
    address = await start(f)
    f.fetch.mockResolvedValueOnce(json({ error: 'temporarily_unavailable' }, 503))
    await expect(f.client.completeRedirect(redirect(address))).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' })
    expect(f.client.identity()).toBeUndefined()
    expect(f.fetch).toHaveBeenCalledTimes(4)
  })

  it('uses the current resource for bootstrap, then ends expired or switched tenant authority', async () => {
    const other = registration('other', 'https://other.example', 'https://issuer.example/tenants/102', '102')
    const f = fixture([primary, secondary, other])
    const address = await start(f)
    const token = await tokens(primary, address.searchParams.get('nonce')!)
    callbackTokens(f, token)
    vi.useFakeTimers()
    await f.client.completeRedirect(redirect(address))
    f.fetch.mockResolvedValueOnce(json({ success: true, data: { result: true } }))
      .mockResolvedValueOnce(json({ user: { identitySub: 'subject-123', tenantId: '101' } }))
    await expect(f.client.bootstrap('/api/v1/bootstrap', primary.id)).resolves.toEqual({ result: true })
    await expect(f.client.bootstrap('/api/v1/bootstrap', primary.id)).resolves.toEqual({ user: { identitySub: 'subject-123', tenantId: '101' } })
    const [url, options] = f.fetch.mock.lastCall!
    expect(url).toBe(primary.apiBaseUrl + '/api/v1/bootstrap')
    expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer ' + token.access_token)
    const authority = f.client.authority()
    const waiting = authority.context.capture()
    await vi.advanceTimersByTimeAsync(300_001)
    expect(waiting.signal.aborted).toBe(true)
    expect(() => authority.authorizationHeader()).toThrow('AUTHORIZATION_REQUIRED')
    const currentGeneration = authority.context.capture()
    f.client.selectResource(other.id)
    expect(currentGeneration.signal.aborted).toBe(true)
    expect(() => authority.authorizationHeader()).toThrow('AUTHORIZATION_REQUIRED')
    await f.client.login()
    expect(f.navigate.mock.lastCall![0]).toContain(other.authorizationEndpoint)
    f.client.logout({ sso: true })
    expect(f.navigate.mock.lastCall![0]).toBe(other.issuer + '/logout')
    expect(f.values.size).toBe(0)
  })

  it('discards an outstanding exchange on local logout', async () => {
    const f = fixture()
    const address = await start(f)
    let resolve!: (value: Response) => void
    f.fetch.mockReturnValueOnce(new Promise<Response>(done => { resolve = done }))
    const result = f.client.completeRedirect(redirect(address)).catch(error => error)
    const capture = f.client.authority().context.capture()
    f.client.logout()
    expect(capture.signal.aborted).toBe(true)
    resolve(json({}))
    expect(await result).toMatchObject({ name: 'AbortError' })
    expect(f.values.size).toBe(0)
    expect(f.navigate).toHaveBeenCalledTimes(1)
  })
})

describe('independent second resource', () => {
  it('requires the popup origin, window and one-time state, and keeps the two fetch audiences separate', async () => {
    const f = fixture()
    const replace = vi.fn<(url: string) => void>()
    const popup = { location: { replace }, close: vi.fn(), closed: false }
    const listeners = new Set<(event: MessageEvent) => void>()
    const browserWindow = { open: vi.fn(() => popup), addEventListener: (_type: string, fn: (event: MessageEvent) => void) => listeners.add(fn),
      removeEventListener: (_type: string, fn: (event: MessageEvent) => void) => listeners.delete(fn) } as unknown as Window
    // Use the same session instance for both grants.
    const client = createPublicOAuthClient({ ...f.opts, browserWindow })
    await client.login()
    const again = new URL(f.navigate.mock.lastCall![0])
    const main = await tokens(primary, again.searchParams.get('nonce')!)
    callbackTokens(f, main)
    await client.completeRedirect(redirect(again))
    const pending = client.authorizeInPopup(secondary.id)
    await vi.waitFor(() => expect(replace).toHaveBeenCalledTimes(1))
    const target = new URL(replace.mock.lastCall![0])
    expect(target.searchParams.get('redirect_uri')).toBe(secondary.popupRedirectUri)
    expect(target.searchParams.get('resource')).toBe(secondary.resource)
    const second = await tokens(secondary, target.searchParams.get('nonce')!)
    callbackTokens(f, second)
    const message = { type: 'stellar.public-oauth.code.v1', state: target.searchParams.get('state'), code: 'secondary-code', rejected: false }
    const send = (data: unknown, source: unknown, sender: string) => {
      listeners.forEach(listener => listener({ data, source, origin: sender } as MessageEvent))
    }
    send(message, popup, 'https://third.example')
    send(message, {}, origin)
    send({ ...message, state: '0'.repeat(43) }, popup, origin)
    expect(f.fetch).toHaveBeenCalledTimes(2)
    send(message, popup, origin)
    await expect(pending).resolves.toMatchObject({ resource: secondary.resource })
    send(message, popup, origin)
    expect(f.fetch).toHaveBeenCalledTimes(4)
    expect(popup.close).toHaveBeenCalledTimes(1)
    expect(listeners.size).toBe(0)
    expect(f.values.size).toBe(0)
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(json({})))
    for (const [reg, signed] of [[primary, main], [secondary, second]] as const) {
      const authority = client.authority(reg.id)
      await createHttpClient({ authority, baseUrl: reg.apiBaseUrl, fetch }).request('/api/info')
      expect(new Headers(fetch.mock.lastCall?.[1]?.headers).get('Authorization')).toBe('Bearer ' + signed.access_token)
    }
  })

  it('allows explicit top-level navigation after a blocked popup without starting an automatic login', async () => {
    const f = fixture()
    const browserWindow = { open: vi.fn(() => null), addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const client = createPublicOAuthClient({ ...f.opts, browserWindow })
    await expect(client.authorizeInPopup(secondary.id)).rejects.toMatchObject({ code: 'POPUP_UNAVAILABLE' })
    expect(f.navigate).not.toHaveBeenCalled()
    expect(f.fetch).not.toHaveBeenCalled()
    client.selectResource(secondary.id)
    await client.login('/metrics')
    const target = new URL(f.navigate.mock.lastCall![0])
    expect(target.searchParams.get('resource')).toBe(secondary.resource)
    expect(target.searchParams.get('redirect_uri')).toBe(secondary.redirectUri)
  })

  it('relays only one authorization code to the same-origin opener after cleaning the callback address', () => {
    const state = 'a'.repeat(43)
    const postMessage = vi.fn()
    const replaceState = vi.fn()
    const callback = secondary.popupRedirectUri!
    const browser = { location: { href: callback + '?state=' + state + '&code=secondary-code', origin },
      history: { replaceState }, opener: { postMessage } } as unknown as Window
    relayPublicOAuthPopupCode(callback, browser)
    expect(replaceState).toHaveBeenCalledWith(null, '', callback)
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'stellar.public-oauth.code.v1', state, code: 'secondary-code',
      issuer: undefined, rejected: false }, origin)
  })
})
