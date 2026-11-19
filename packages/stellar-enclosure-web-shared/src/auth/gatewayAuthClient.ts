import { createHttpClient, type ResourceRequestAuthority } from '../api/httpClient'
import { AuthRequestContext, normalizeApiBase } from './authRequestContext'

export interface PublicOAuthRegistration {
  readonly id: string
  readonly tenantId: string
  readonly issuer: string
  readonly clientId: string
  readonly resource: string
  readonly apiBaseUrl: string
  readonly scopes: readonly string[]
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly jwksUri: string
  readonly redirectUri: string
  readonly popupRedirectUri?: string
  readonly browserBound: boolean
}

export interface PublicOAuthClientOptions {
  readonly registrations: readonly PublicOAuthRegistration[]
  readonly activeResource: string
  readonly fetch?: typeof globalThis.fetch
  readonly sessionStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  readonly navigate?: (url: string) => void
  readonly replaceLocation?: (url: string) => void
  readonly crypto?: Crypto
  readonly timeout?: number
  readonly browserWindow?: Pick<Window, 'open' | 'addEventListener' | 'removeEventListener'>
}

export interface PublicOAuthIdentity {
  readonly issuer: string
  readonly tenantId: string
  readonly subject: string
  readonly clientId: string
  readonly resource: string
  readonly accessExpiresAt: number
}

export interface PublicOAuthLoginResult {
  readonly identity: PublicOAuthIdentity
  readonly returnTo: string
}

export type PublicOAuthErrorCode = 'INVALID_CONFIGURATION' | 'INVALID_CALLBACK' | 'AUTHORIZATION_REQUIRED' |
  'AUTHORIZATION_REJECTED' | 'AUTHORITY_UNAVAILABLE' | 'INVALID_TOKEN' | 'POPUP_UNAVAILABLE'

export class PublicOAuthError extends Error {
  constructor(readonly code: PublicOAuthErrorCode) {
    super(code)
    this.name = 'PublicOAuthError'
  }
}

export interface PublicOAuthClient {
  selectResource(id: string): void
  login(returnTo?: string, options?: { readonly reauthenticate?: boolean }): Promise<void>
  completeRedirect(url?: string, signal?: AbortSignal): Promise<PublicOAuthLoginResult>
  authorizeInPopup(id: string, signal?: AbortSignal): Promise<PublicOAuthIdentity>
  identity(id?: string): PublicOAuthIdentity | undefined
  authority(id?: string): ResourceRequestAuthority
  bootstrap<T>(path: string, id?: string, signal?: AbortSignal): Promise<T>
  logout(options?: { readonly sso?: boolean }): void
}

interface AuthorizationTransaction {
  readonly binding: string
  readonly redirectUri: string
  readonly state: string
  readonly nonce: string
  readonly verifier: string
  readonly browserBinding?: string
  readonly returnTo: string
  readonly expiresAt: number
}

interface ResourceSession {
  readonly registration: PublicOAuthRegistration
  readonly context: AuthRequestContext
  token?: { readonly value: string; readonly identity: PublicOAuthIdentity }
  expiryTimer?: ReturnType<typeof setTimeout>
}

const TRANSACTION_PREFIX = 'stellar.public-oauth.v1.'
const TRANSACTION_TTL = 5 * 60 * 1000
const CODE_MESSAGE = 'stellar.public-oauth.code.v1'
const RS256 = 'RSASSA-PKCS1-v1_5'
const identifier = /^[A-Za-z0-9._:-]{1,128}$/
const randomValue = /^[A-Za-z0-9_-]{43}$/
const base64Value = /^[A-Za-z0-9_-]+$/
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (code: PublicOAuthErrorCode): never => { throw new PublicOAuthError(code) }

/** The configured issuer, callbacks and API bindings are copied once. Only PKCE transactions survive a navigation. */
export const createPublicOAuthClient = (options: PublicOAuthClientOptions): PublicOAuthClient => {
  const sessions = configure(options.registrations)
  const find = (id: string): ResourceSession => sessions.get(id) ?? fail('INVALID_CONFIGURATION')
  let active = find(options.activeResource)
  const storage = () => options.sessionStorage ?? window.sessionStorage
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
  const navigate = options.navigate ?? ((url: string) => window.location.assign(url))
  const replace = options.replaceLocation ?? ((url: string) => window.history.replaceState(null, '', url))
  const crypto = options.crypto ?? globalThis.crypto
  const timeout = options.timeout ?? 15_000
  if (!crypto?.subtle || !Number.isFinite(timeout) || timeout <= 0 || timeout > 60_000) fail('INVALID_CONFIGURATION')

  const clearToken = (session: ResourceSession) => {
    clearTimeout(session.expiryTimer)
    delete session.expiryTimer
    delete session.token
  }
  const invalidate = (session: ResourceSession) => {
    clearToken(session)
    session.context.invalidate()
  }
  const clear = () => {
    for (const session of sessions.values()) clearToken(session)
    for (const session of sessions.values()) session.context.invalidate()
    for (const id of sessions.keys()) storage().removeItem(TRANSACTION_PREFIX + id)
  }
  const current = (session: ResourceSession) => {
    const token = session.token
    if (token && token.identity.accessExpiresAt <= Date.now()) {
      invalidate(session)
      return undefined
    }
    return token
  }
  const allowed = (session: ResourceSession) => sameRealm(active.registration, session.registration)
  const authority = (id = active.registration.id): ResourceRequestAuthority => {
    const session = find(id)
    return Object.freeze({
      apiBaseUrl: session.registration.apiBaseUrl,
      resource: session.registration.resource,
      context: session.context,
      authorizationHeader: () => {
        const token = allowed(session) ? current(session) : undefined
        if (!token) return fail('AUTHORIZATION_REQUIRED')
        return 'Bearer ' + token.value
      },
      invalidate: () => invalidate(session),
    })
  }

  const createTransaction = (registration: PublicOAuthRegistration, redirectUri: string, returnTo: string): AuthorizationTransaction => {
    const secret = () => encode(crypto.getRandomValues(new Uint8Array(32)))
    return {
      binding: binding(registration), redirectUri, returnTo: checkedReturnPath(returnTo),
      state: secret(), nonce: secret(), verifier: secret(), expiresAt: Date.now() + TRANSACTION_TTL,
      browserBinding: registration.browserBound
        ? Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
        : undefined,
    }
  }

  const authorizationUrl = async (registration: PublicOAuthRegistration, tx: AuthorizationTransaction, reauthenticate: boolean) => {
    const challenge = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tx.verifier))))
    const url = new URL(registration.authorizationEndpoint)
    url.search = new URLSearchParams({
      response_type: 'code', client_id: registration.clientId, redirect_uri: tx.redirectUri, resource: registration.resource,
      scope: registration.scopes.join(' '), state: tx.state, nonce: tx.nonce, code_challenge_method: 'S256', code_challenge: challenge,
    }).toString()
    if (tx.browserBinding) url.searchParams.set('browser_binding', tx.browserBinding)
    if (reauthenticate) url.searchParams.set('prompt', 'login')
    return url.href
  }

  const exchange = async (session: ResourceSession, tx: AuthorizationTransaction, code: string, signal?: AbortSignal): Promise<PublicOAuthLoginResult> => {
    const { registration } = session
    const capture = session.context.capture(signal)
    const deadline = AbortSignal.timeout(timeout)
    const exchangeSignal = AbortSignal.any([capture.signal, deadline])
    const assertCurrent = () => {
      capture.assertCurrent()
      if (deadline.aborted) fail('AUTHORITY_UNAVAILABLE')
    }
    const request = async (url: string, body?: URLSearchParams) => {
      try {
        assertCurrent()
        const response = await fetcher(url, {
          method: body ? 'POST' : 'GET', body, redirect: 'error', credentials: 'omit', cache: 'no-store',
          referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: exchangeSignal,
        })
        assertCurrent()
        if (!response.ok) fail(response.status >= 500 ? 'AUTHORITY_UNAVAILABLE' : 'AUTHORIZATION_REJECTED')
        const result = await boundedJson(response)
        assertCurrent()
        return result
      } catch (error) {
        assertCurrent()
        if (error instanceof PublicOAuthError) throw error
        return fail('AUTHORITY_UNAVAILABLE')
      }
    }
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: tx.redirectUri,
      client_id: registration.clientId, code_verifier: tx.verifier, resource: registration.resource })
    if (tx.browserBinding) body.set('browser_binding', tx.browserBinding)
    const { access, id, expiresIn } = tokenResponse(await request(registration.tokenEndpoint, body))
    const jwks = await request(registration.jwksUri)
    const keys = new Map<string, CryptoKey>()
    const [identityClaims, accessClaims] = await Promise.all([
      verifiedClaims(id, 'JWT', registration.clientId, registration.issuer, jwks, keys, crypto),
      verifiedClaims(access, 'at+jwt', registration.resource, registration.issuer, jwks, keys, crypto),
    ])
    if (identityClaims.nonce !== tx.nonce || (identityClaims.azp !== undefined && identityClaims.azp !== registration.clientId)
      || accessClaims.sub !== identityClaims.sub || accessClaims.principal_type !== 'USER' || accessClaims.scope_context !== 'TENANT'
      || accessClaims.tenant_id !== registration.tenantId || accessClaims.client_id !== registration.clientId
      || !equalScopes(accessClaims.scope, registration.scopes)) {
      fail('INVALID_TOKEN')
    }
    if (identityClaims.at_hash !== undefined) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(access)))
      if (identityClaims.at_hash !== encode(digest.subarray(0, 16))) fail('INVALID_TOKEN')
    }
    assertCurrent()
    if (!allowed(session)) fail('AUTHORIZATION_REQUIRED')
    const now = Date.now()
    if (now >= tx.expiresAt) fail('INVALID_CALLBACK')
    if (accessClaims.exp * 1000 - now > 600_000 || accessClaims.exp - accessClaims.iat > 600) fail('INVALID_TOKEN')
    const accessExpiresAt = Math.min(accessClaims.exp * 1000, identityClaims.exp * 1000, now + expiresIn * 1000)
    if (accessExpiresAt <= now) fail('INVALID_TOKEN')
    if ([...sessions.values()].some(other => other !== session && allowed(other)
      && other.token && other.token.identity.accessExpiresAt > now && other.token.identity.subject !== identityClaims.sub)) {
      fail('INVALID_TOKEN')
    }
    const identity = Object.freeze({ issuer: registration.issuer, tenantId: registration.tenantId,
      subject: identityClaims.sub, clientId: registration.clientId, resource: registration.resource, accessExpiresAt })
    invalidate(session)
    session.token = { identity, value: access }
    session.expiryTimer = setTimeout(() => invalidate(session), accessExpiresAt - now)
    return { identity, returnTo: tx.returnTo }
  }

  return {
    selectResource: id => {
      const session = find(id)
      if (!allowed(session)) clear()
      active = session
    },
    login: async (returnTo = '/', login = {}) => {
      const session = active
      const registration = session.registration
      const tx = createTransaction(registration, registration.redirectUri, returnTo)
      invalidate(session)
      const capture = session.context.capture()
      const url = await authorizationUrl(registration, tx, login.reauthenticate === true)
      capture.assertCurrent()
      if (active !== session) fail('AUTHORIZATION_REQUIRED')
      const key = TRANSACTION_PREFIX + registration.id
      storage().setItem(key, JSON.stringify(tx))
      try { navigate(url) } catch (error) { storage().removeItem(key); throw error }
    },
    completeRedirect: async (url = window.location.href, signal) => {
      const parsed = callbackUrl(url)
      const callback = parsed.origin + parsed.pathname
      const matches = [...sessions.values()].filter(session => session.registration.redirectUri === callback)
      if (matches.length === 0) return fail('INVALID_CALLBACK')
      replace(callback)
      const { state, code, issuer, rejected } = parseCallback(parsed)
      for (const session of matches) {
        const key = TRANSACTION_PREFIX + session.registration.id
        const tx = readTransaction(storage().getItem(key), session.registration, state, () => storage().removeItem(key))
        if (!tx) continue
        if (issuer !== undefined && issuer !== session.registration.issuer) return fail('INVALID_CALLBACK')
        if (rejected) return fail('AUTHORIZATION_REJECTED')
        if (!allowed(session)) clear()
        active = session
        invalidate(session)
        return exchange(session, tx, code, signal)
      }
      return fail('INVALID_CALLBACK')
    },
    authorizeInPopup: async (id, signal) => {
      const session = find(id)
      const registration = session.registration
      const redirectUri = registration.popupRedirectUri
      if (!redirectUri || !allowed(session)) return fail('POPUP_UNAVAILABLE')
      const browser = options.browserWindow ?? window
      const popup = browser.open('about:blank', '_blank', 'popup,width=560,height=680')
      if (!popup) return fail('POPUP_UNAVAILABLE')
      invalidate(session)
      const capture = session.context.capture(signal)
      try {
        const tx = createTransaction(registration, redirectUri, '/')
        const url = await authorizationUrl(registration, tx, false)
        capture.assertCurrent()
        const code = await receivePopupCode(browser, popup, url, registration.issuer, tx, capture.signal)
        return (await exchange(session, tx, code, capture.signal)).identity
      } finally { popup.close() }
    },
    identity: (id = active.registration.id) => {
      const session = find(id)
      return allowed(session) ? current(session)?.identity : undefined
    },
    authority,
    bootstrap: async <T>(path: string, id?: string, signal?: AbortSignal) => {
      const selected = authority(id)
      const client = createHttpClient({ authority: selected, baseUrl: selected.apiBaseUrl, fetch: fetcher, timeout })
      if (!path.startsWith('/api/')) return fail('INVALID_CONFIGURATION')
      const response = await client.request<unknown>(path, { signal })
      if (!isObject(response)) return fail('AUTHORITY_UNAVAILABLE')
      if (!('success' in response)) return response as T
      if (response.success !== true || response.data == null) return fail('AUTHORITY_UNAVAILABLE')
      return response.data as T
    },
    logout: (logout = {}) => {
      const issuer = active.registration.issuer
      clear()
      if (logout.sso === true) navigate(issuer + '/logout')
    },
  }
}

/** Used by the app's exact popup callback page. Only the one-use code and its correlation values cross windows. */
export const relayPublicOAuthPopupCode = (redirectUri: string, browser: Window = window): void => {
  const parsed = callbackUrl(browser.location.href)
  const callback = parsed.origin + parsed.pathname
  if (callback !== redirectUri || parsed.origin !== browser.location.origin || !browser.opener) fail('INVALID_CALLBACK')
  browser.history.replaceState(null, '', callback)
  const { state, code, issuer, rejected } = parseCallback(parsed)
  browser.opener.postMessage({ type: CODE_MESSAGE, state, code, issuer, rejected }, parsed.origin)
}

const sameRealm = (left: PublicOAuthRegistration, right: PublicOAuthRegistration) => left.issuer === right.issuer && left.tenantId === right.tenantId
const binding = (registration: PublicOAuthRegistration) => JSON.stringify(registration)
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
const decode = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0))

function parseUrl(text: string): URL | undefined {
  try { return new URL(text) } catch { return undefined }
}

function secureUrl(text: string): URL {
  const url = parseUrl(text)
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || (url.href !== text && url.origin !== text) || text.length > 2048) return fail('INVALID_CONFIGURATION')
  return url
}

function configure(registrations: readonly PublicOAuthRegistration[]): Map<string, ResourceSession> {
  if (registrations.length < 1 || registrations.length > 32) fail('INVALID_CONFIGURATION')
  const sessions = new Map<string, ResourceSession>()
  const callbackBindings = new Map<string, string>()
  for (const input of registrations) {
    const { id, tenantId, issuer, clientId, resource, authorizationEndpoint, tokenEndpoint, jwksUri, redirectUri, popupRedirectUri, browserBound } = input
    if (!identifier.test(id) || sessions.has(id) || !/^[1-9][0-9]{0,18}$/.test(tenantId) || !identifier.test(clientId)
      || typeof browserBound !== 'boolean' || issuer.endsWith('/')) fail('INVALID_CONFIGURATION')
    const issuerUrl = secureUrl(issuer)
    for (const endpoint of [authorizationEndpoint, tokenEndpoint, jwksUri]) {
      const parsed = secureUrl(endpoint)
      if (parsed.origin !== issuerUrl.origin || !endpoint.startsWith(issuer + '/')) fail('INVALID_CONFIGURATION')
    }
    if (new Set([authorizationEndpoint, tokenEndpoint, jwksUri]).size !== 3) fail('INVALID_CONFIGURATION')
    secureUrl(resource)
    secureUrl(input.apiBaseUrl)
    const apiBaseUrl = normalizeApiBase(input.apiBaseUrl)
    const origin = secureUrl(redirectUri).origin
    if (popupRedirectUri && (secureUrl(popupRedirectUri).origin !== origin || popupRedirectUri === redirectUri)) fail('INVALID_CONFIGURATION')
    for (const [uri, mode] of [[redirectUri, 'navigation'], [popupRedirectUri, 'popup']] as const) {
      if (!uri) continue
      if (secureUrl(uri).href !== uri) fail('INVALID_CONFIGURATION')
      const owner = issuer + ' ' + mode
      if (callbackBindings.has(uri) && callbackBindings.get(uri) !== owner) fail('INVALID_CONFIGURATION')
      callbackBindings.set(uri, owner)
    }
    const scopes = Object.freeze([...input.scopes].sort())
    if (!scopes.includes('openid') || scopes.length > 64 || scopes.some(value => !identifier.test(value)) || new Set(scopes).size !== scopes.length) fail('INVALID_CONFIGURATION')
    const registration = Object.freeze({ id, tenantId, issuer, clientId, resource, apiBaseUrl, scopes, authorizationEndpoint, tokenEndpoint,
      jwksUri, redirectUri, popupRedirectUri, browserBound })
    sessions.set(id, { registration, context: new AuthRequestContext() })
  }
  return sessions
}

function checkedReturnPath(value: string): string {
  if (!/^\/[A-Za-z0-9/._~-]{0,2047}$/.test(value) || value.startsWith('//')
    || value.split('/').some(segment => segment === '.' || segment === '..')) return fail('INVALID_CONFIGURATION')
  return value
}

function readTransaction(raw: string | null, registration: PublicOAuthRegistration, state: string,
  remove: () => void): AuthorizationTransaction | undefined {
  if (!raw) return undefined
  let parsed: unknown
  if (raw.length <= 32_768) {
    try { parsed = JSON.parse(raw) } catch { /* Remove malformed transaction below. */ }
  }
  if (!isObject(parsed) || typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= Date.now()) {
    remove()
    return undefined
  }
  if (parsed.state !== state) return undefined
  remove()
  if (parsed.binding !== binding(registration) || parsed.redirectUri !== registration.redirectUri
    || typeof parsed.nonce !== 'string' || !randomValue.test(parsed.nonce) || typeof parsed.verifier !== 'string' || !randomValue.test(parsed.verifier)
    || !Number.isSafeInteger(parsed.expiresAt) || parsed.expiresAt - Date.now() > TRANSACTION_TTL || typeof parsed.returnTo !== 'string'
    || (registration.browserBound ? typeof parsed.browserBinding !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.browserBinding) : parsed.browserBinding !== undefined)) return undefined
  try { checkedReturnPath(parsed.returnTo) } catch { return undefined }
  return parsed as unknown as AuthorizationTransaction
}

function callbackUrl(text: string): URL {
  const url = parseUrl(text)
  if (!url || text.length > 16_384 || url.protocol !== 'https:' || url.username || url.password || url.hash || url.href !== text) return fail('INVALID_CALLBACK')
  return url
}

function parseCallback(url: URL) {
  const params = url.searchParams
  const state = params.get('state')
  const code = params.get('code')
  const rejected = params.has('error')
  const names = ['code', 'state', 'iss', 'error', 'error_description', 'error_uri']
  if (!state || !randomValue.test(state) || [...params.keys()].some(key => !names.includes(key) || params.getAll(key).length !== 1)
    || (rejected ? params.has('code') : !isCode(code))) return fail('INVALID_CALLBACK')
  return { state, code: code ?? '', issuer: params.get('iss') ?? undefined, rejected }
}

function isCode(code: unknown): code is string {
  // Spring Authorization Server emits base64url authorization codes.
  return typeof code === 'string' && code.length > 0 && code.length <= 4096 && /^[A-Za-z0-9._~+/=-]+$/.test(code)
}

async function receivePopupCode(browser: NonNullable<PublicOAuthClientOptions['browserWindow']>, popup: Window,
  url: string, issuer: string, tx: AuthorizationTransaction, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const origin = new URL(tx.redirectUri).origin
  return new Promise((resolve, reject) => {
    const finish = () => {
      window.clearInterval(poll)
      browser.removeEventListener('message', receive)
      signal.removeEventListener('abort', abort)
    }
    const abort = () => { finish(); reject(signal.reason) }
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== popup || event.origin !== origin || !isObject(event.data)
        || event.data.type !== CODE_MESSAGE || event.data.state !== tx.state) return
      finish()
      if (event.data.issuer !== undefined && event.data.issuer !== issuer || Date.now() >= tx.expiresAt) reject(new PublicOAuthError('INVALID_CALLBACK'))
      else if (event.data.rejected === true) reject(new PublicOAuthError('AUTHORIZATION_REJECTED'))
      else if (event.data.rejected === false && isCode(event.data.code)) resolve(event.data.code)
      else reject(new PublicOAuthError('INVALID_CALLBACK'))
    }
    const poll = window.setInterval(() => {
      if (!popup.closed && Date.now() < tx.expiresAt) return
      finish()
      reject(new PublicOAuthError('POPUP_UNAVAILABLE'))
    }, 250)
    browser.addEventListener('message', receive)
    signal.addEventListener('abort', abort, { once: true })
    try { popup.location.replace(url) } catch { finish(); reject(new PublicOAuthError('POPUP_UNAVAILABLE')) }
  })
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) return fail('INVALID_TOKEN')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0
  let text = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 128 * 1024) fail('INVALID_TOKEN')
      text += decoder.decode(chunk.value, { stream: true })
    }
    return JSON.parse(text + decoder.decode()) as unknown
  } catch {
    void reader.cancel().catch(() => undefined)
    return fail('INVALID_TOKEN')
  } finally { reader.releaseLock() }
}

function tokenResponse(body: unknown): { access: string; id: string; expiresIn: number } {
  if (!isObject(body) || 'refresh_token' in body || typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer'
    || typeof body.expires_in !== 'number' || !Number.isSafeInteger(body.expires_in) || body.expires_in < 1 || body.expires_in > 600
    || typeof body.access_token !== 'string' || typeof body.id_token !== 'string') return fail('INVALID_TOKEN')
  return { access: body.access_token, id: body.id_token, expiresIn: body.expires_in }
}

interface VerifiedClaims extends Record<string, unknown> { readonly sub: string; readonly exp: number; readonly iat: number }

async function verifiedClaims(jwt: string, type: string, audience: string, issuer: string, jwks: unknown,
  keyCache: Map<string, CryptoKey>, crypto: Crypto): Promise<VerifiedClaims> {
  try {
    const parts = jwt.split('.')
    if (jwt.length > 24_576 || parts.length !== 3 || parts.some(part => !base64Value.test(part))) return fail('INVALID_TOKEN')
    const [head, payload, signature] = parts
    const json = (part: string): unknown => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(part)))
    const header = json(head)
    if (!isObject(header) || header.alg !== 'RS256' || header.typ !== type || typeof header.kid !== 'string' || !identifier.test(header.kid)
      || ['crit', 'jku', 'jwk', 'x5u', 'x5c', 'b64'].some(name => name in header)) return fail('INVALID_TOKEN')
    const key = keyCache.get(header.kid) ?? await importKey(jwks, header.kid, crypto)
    keyCache.set(header.kid, key)
    if (!await crypto.subtle.verify(RS256, key, decode(signature), new TextEncoder().encode(head + '.' + payload))) return fail('INVALID_TOKEN')
    const c = json(payload)
    const now = Math.floor(Date.now() / 1000)
    if (!isObject(c) || c.iss !== issuer || (c.aud !== audience && !(Array.isArray(c.aud) && c.aud.length === 1 && c.aud[0] === audience))
      || typeof c.sub !== 'string' || !c.sub || c.sub.length > 255 || [...c.sub].some(char => char.charCodeAt(0) <= 0x20 || char.charCodeAt(0) === 0x7f)
      || typeof c.exp !== 'number' || !Number.isSafeInteger(c.exp) || c.exp <= now
      || typeof c.iat !== 'number' || !Number.isSafeInteger(c.iat) || c.iat < 1 || c.iat > now + 30 || c.exp <= c.iat
      || (c.nbf !== undefined && (typeof c.nbf !== 'number' || !Number.isSafeInteger(c.nbf) || c.nbf > now))) return fail('INVALID_TOKEN')
    return c as VerifiedClaims
  } catch { return fail('INVALID_TOKEN') }
}

async function importKey(jwks: unknown, kid: string, crypto: Crypto): Promise<CryptoKey> {
  if (!isObject(jwks) || !Array.isArray(jwks.keys) || jwks.keys.length > 64) return fail('INVALID_TOKEN')
  const matches = jwks.keys.filter((key: unknown) => isObject(key) && key.kid === kid)
  const jwk: unknown = matches[0]
  if (matches.length !== 1 || !isObject(jwk) || jwk.kty !== 'RSA' || (jwk.use !== undefined && jwk.use !== 'sig')
    || (jwk.alg !== undefined && jwk.alg !== 'RS256') || 'd' in jwk
    || typeof jwk.n !== 'string' || !base64Value.test(jwk.n) || jwk.n.length < 342 || jwk.n.length > 683
    || typeof jwk.e !== 'string' || !base64Value.test(jwk.e) || jwk.e.length > 8) return fail('INVALID_TOKEN')
  const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e }, { name: RS256, hash: 'SHA-256' }, false, ['verify'])
  if ((key.algorithm as RsaHashedKeyAlgorithm).modulusLength < 2048) return fail('INVALID_TOKEN')
  return key
}

function equalScopes(value: unknown, expected: readonly string[]): boolean {
  if (typeof value !== 'string' || value.length > 8320) return false
  const scopes = value.split(' ').sort()
  return scopes.length === expected.length && expected.every((scope, index) => scopes[index] === scope)
}
