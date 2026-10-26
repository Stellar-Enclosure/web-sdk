import { appendApiPath, AuthRequestContext, normalizeApiBase } from './authRequestContext'

export interface GatewayAuthClientOptions {
    readonly baseUrl?: string
    readonly appAlias?: string
    readonly fetch?: typeof globalThis.fetch
    readonly navigate?: (url: string) => void
    readonly context?: AuthRequestContext
    readonly timeout?: number
}

export interface GatewayIdentityResult {
    readonly issuer: string
    readonly tenantId: string
    readonly subject: string
    readonly appAlias: string
    readonly clientId: string
    readonly authorizationExpiresAt: number
    readonly authenticationExpiresAt: number
    readonly securityVersion: Readonly<{ realm: string; client: string; subject: string }>
    readonly ssoLogoutUri: string
}

export interface GatewayCsrfResult {
    readonly headerName: 'X-CSRF-TOKEN'
    readonly token: string
    readonly expiresAt: string
}

export type GatewayLogoutRemoteState = 'CONFIRMED' | 'PENDING' | 'UNKNOWN'
export interface GatewayLogoutResult {
    readonly operationId: string
    readonly status: 'LOCAL_CLOSED'
    readonly remoteState: GatewayLogoutRemoteState
    readonly ssoLogoutUri: string
}

export interface GatewayRefreshResult {
    readonly operationId: string
    readonly status: 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CLOSED'
    readonly accessExpiresAt: number | null
    readonly authorizationExpiresAt: number
    readonly failureCode: string | null
}

export type GatewayAuthErrorCode = 'NETWORK_OR_TIMEOUT' | 'HTTP_ERROR' | 'CSRF_FAILED' | 'INVALID_RESPONSE' | 'INVALID_INPUT'

export class GatewayAuthError extends Error {
    constructor(readonly code: GatewayAuthErrorCode, readonly path: string, message: string, readonly status?: number) {
        super(message)
        this.name = 'GatewayAuthError'
    }
}

/** HttpOnly credential cookies belong to EDGE; only minimal identity and short-lived CSRF reach JS. */
export interface GatewayAuthClient {
    readonly context: AuthRequestContext
    readonly applicationBaseUrl: string
    login(returnTo?: string, options?: {readonly reauthenticate?: boolean}): void
    identity(signal?: AbortSignal): Promise<GatewayIdentityResult>
    csrf(signal?: AbortSignal): Promise<GatewayCsrfResult>
    refresh(operationId: string, signal?: AbortSignal): Promise<GatewayRefreshResult>
    refreshStatus(operationId: string, signal?: AbortSignal): Promise<GatewayRefreshResult>
    logout(options?: { readonly sso?: boolean; readonly signal?: AbortSignal }): Promise<GatewayLogoutResult>
    bootstrap<T>(path?: string, signal?: AbortSignal): Promise<T>
}

export const createGatewayAuthClient = (options: GatewayAuthClientOptions = {}): GatewayAuthClient => {
    const origin = normalizeApiBase(options.baseUrl ?? '')
    if (origin !== '' && new URL(origin).pathname !== '/') throw invalidInput('EDGE base must be an origin')
    const alias = options.appAlias ?? 'edge-ui'
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(alias)) throw invalidInput('Application alias is invalid')
    const applicationBaseUrl = origin + '/apps/' + alias
    const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
    const navigate = options.navigate ?? ((url: string) => window.location.assign(url))
    const context = options.context ?? new AuthRequestContext()
    const timeout = options.timeout ?? 15_000
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 60_000) throw invalidInput('Request timeout is invalid')

    const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
        const capture = context.capture(init.signal ?? undefined)
        const timer = new AbortController()
        const deadline = setTimeout(() => timer.abort(), timeout)
        const headers = new Headers(init.headers)
        headers.set('Accept', 'application/json')
        headers.set('Cache-Control', 'no-store')
        if (headers.has('Authorization')) throw invalidInput('Browser authentication does not accept Authorization headers')
        try {
            let response: Response
            try {
                response = await fetcher(appendApiPath(applicationBaseUrl, path), {
                    ...init, credentials: 'include', cache: 'no-store', redirect: 'error', headers,
                    signal: AbortSignal.any([capture.signal, timer.signal]),
                })
            } catch {
                capture.assertCurrent()
                throw new GatewayAuthError('NETWORK_OR_TIMEOUT', path, 'EDGE authentication service is unreachable')
            }
            capture.assertCurrent()
            if (!response.ok) {
                if (response.status === 401) context.invalidate()
                throw new GatewayAuthError('HTTP_ERROR', path, `EDGE authentication request failed (${response.status})`, response.status)
            }
            let payload: unknown
            try { payload = await response.json() as unknown }
            catch { throw invalidResponse(path, response.status) }
            capture.assertCurrent()
            return payload as T
        } finally { clearTimeout(deadline) }
    }

    const csrf = async (signal?: AbortSignal): Promise<GatewayCsrfResult> => {
        const value = await request<unknown>('/auth/csrf', { signal })
        if (!record(value) || value.headerName !== 'X-CSRF-TOKEN' || typeof value.token !== 'string'
            || !/^[A-Za-z0-9._~-]{1,2048}$/.test(value.token) || typeof value.expiresAt !== 'string'
            || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) {
            throw new GatewayAuthError('CSRF_FAILED', '/auth/csrf', 'EDGE security proof is invalid')
        }
        return { headerName: 'X-CSRF-TOKEN', token: value.token, expiresAt: value.expiresAt }
    }

    const refreshResult = (value: unknown, operationId: string): GatewayRefreshResult => {
        if (!record(value) || value.operationId !== operationId
            || !['IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'CLOSED'].includes(String(value.status))
            || !numericDate(value.authorizationExpiresAt) || !(value.accessExpiresAt === null || numericDate(value.accessExpiresAt))
            || !(value.failureCode === null || (typeof value.failureCode === 'string' && /^[A-Z0-9_]{1,128}$/.test(value.failureCode)))) {
            throw invalidResponse('/auth/refresh')
        }
        return { operationId, status: value.status as GatewayRefreshResult['status'], accessExpiresAt: value.accessExpiresAt,
            authorizationExpiresAt: value.authorizationExpiresAt, failureCode: value.failureCode }
    }

    return {
        context,
        applicationBaseUrl,
        login: (returnTo, loginOptions = {}) => {
            if (returnTo !== undefined && (!/^\/[A-Za-z0-9/._~-]{0,2047}$/.test(returnTo) || returnTo.startsWith('//')
                || returnTo.split('/').some(segment => segment === '.' || segment === '..'))) throw invalidInput('Return path is invalid')
            if (!record(loginOptions) || Object.keys(loginOptions).some(key => key !== 'reauthenticate')
                || (loginOptions.reauthenticate !== undefined && typeof loginOptions.reauthenticate !== 'boolean')) throw invalidInput('Login options are invalid')
            const query = new URLSearchParams()
            if (returnTo !== undefined) query.set('returnTo', returnTo)
            if (loginOptions.reauthenticate === true) query.set('reauthenticate', 'true')
            context.invalidate()
            navigate(applicationBaseUrl + '/auth/login' + (query.size ? '?' + query.toString() : ''))
        },
        identity: async (signal) => {
            const value = await request<unknown>('/auth/identity', { signal })
            if (!record(value) || !text(value.issuer) || !text(value.tenantId) || !text(value.subject) || value.appAlias !== alias
                || !text(value.clientId) || !numericDate(value.authorizationExpiresAt) || !numericDate(value.authenticationExpiresAt)
                || !record(value.securityVersion) || !version(value.securityVersion.realm) || !version(value.securityVersion.client)
                || !version(value.securityVersion.subject) || !logoutUri(value.ssoLogoutUri) || value.ssoLogoutUri !== value.issuer + '/logout') {
                throw invalidResponse('/auth/identity')
            }
            const identity: GatewayIdentityResult = {
                issuer: value.issuer, tenantId: value.tenantId, subject: value.subject, appAlias: alias, clientId: value.clientId,
                authorizationExpiresAt: value.authorizationExpiresAt, authenticationExpiresAt: value.authenticationExpiresAt,
                securityVersion: { realm: value.securityVersion.realm, client: value.securityVersion.client, subject: value.securityVersion.subject },
                ssoLogoutUri: value.ssoLogoutUri,
            }
            context.acceptIdentity(JSON.stringify(identity))
            return identity
        },
        csrf,
        refresh: async (operationId, signal) => {
            requireOperationId(operationId)
            const capture = context.capture(signal)
            const proof = await csrf(capture.signal)
            capture.assertCurrent()
            const value = await request<unknown>('/auth/refresh', { method: 'POST', signal: capture.signal,
                headers: { 'Content-Type': 'application/json', [proof.headerName]: proof.token }, body: JSON.stringify({ operationId }) })
            return refreshResult(value, operationId)
        },
        refreshStatus: async (operationId, signal) => {
            requireOperationId(operationId)
            return refreshResult(await request<unknown>('/auth/refresh-operations/' + operationId, { signal }), operationId)
        },
        logout: async (requestOptions = {}) => {
            context.invalidate()
            const capture = context.capture(requestOptions.signal)
            const proof = await csrf(capture.signal)
            capture.assertCurrent()
            const value = await request<unknown>('/auth/logout', { method: 'POST', signal: capture.signal,
                headers: { [proof.headerName]: proof.token } })
            if (!record(value) || typeof value.operationId !== 'string' || !operationIdValid(value.operationId)
                || value.status !== 'LOCAL_CLOSED' || !['CONFIRMED', 'PENDING', 'UNKNOWN'].includes(String(value.remoteState))
                || !logoutUri(value.ssoLogoutUri)) throw invalidResponse('/auth/logout')
            const result: GatewayLogoutResult = { operationId: value.operationId, status: 'LOCAL_CLOSED',
                remoteState: value.remoteState as GatewayLogoutRemoteState, ssoLogoutUri: value.ssoLogoutUri }
            if (requestOptions.sso === true) navigate(result.ssoLogoutUri)
            return result
        },
        bootstrap: async <T>(path = '/api/v1/auth/bootstrap', signal?: AbortSignal): Promise<T> => {
            if (!path.startsWith('/api/')) throw invalidInput('Bootstrap must use an application API path')
            const value = await request<unknown>(path, { signal })
            if (record(value) && 'success' in value && 'data' in value) {
                if (value.success !== true || value.data === null) throw invalidResponse(path)
                return value.data as T
            }
            return value as T
        },
    }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048
const version = (value: unknown): value is string => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(value)
const numericDate = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const operationIdValid = (value: string): boolean => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
const requireOperationId = (value: string): void => { if (!operationIdValid(value)) throw invalidInput('Operation id is invalid') }
const invalidInput = (message: string) => new GatewayAuthError('INVALID_INPUT', '/auth', message)
const invalidResponse = (path: string, status?: number) => new GatewayAuthError('INVALID_RESPONSE', path, 'EDGE authentication response is invalid', status)
const logoutUri = (value: unknown): value is string => {
    if (typeof value !== 'string') return false
    try {
        const uri = new URL(value)
        return uri.protocol === 'https:' && !uri.username && !uri.password && !uri.search && !uri.hash
            && /^\/(?:platform|tenants\/[1-9][0-9]{0,18})\/logout$/.test(uri.pathname) && uri.href === value
    } catch { return false }
}
