import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGatewayAuthClient, GatewayAuthError } from './gatewayAuthClient'

const id = '00000000-0000-4000-8000-000000000001'
const proof = () => ({ headerName: 'X-CSRF-TOKEN', token: 'csrf-proof', expiresAt: new Date(Date.now() + 60_000).toISOString() })
const identity = (subject = 'alice') => ({
    issuer: 'https://idp.example/tenants/1001', tenantId: '1001', subject, appAlias: 'edge-ui', clientId: 'ui-client',
    authorizationExpiresAt: 1_900_000_000, authenticationExpiresAt: 1_900_000_100,
    securityVersion: { realm: '1', client: '2', subject: '9223372036854775807' }, ssoLogoutUri: 'https://idp.example/tenants/1001/logout',
})
const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
afterEach(() => vi.restoreAllMocks())

describe('createGatewayAuthClient', () => {
    it('uses one fixed application and never accepts issuer or resource selection in login', () => {
        const fetcher = vi.fn(); const navigate = vi.fn()
        const client = createGatewayAuthClient({ baseUrl: 'https://edge.example/', appAlias: 'edge-ui', fetch: fetcher, navigate })
        client.login('/xingyuan/tianshu/registry')
        expect(navigate).toHaveBeenCalledWith('https://edge.example/apps/edge-ui/auth/login?returnTo=%2Fxingyuan%2Ftianshu%2Fregistry')
        expect(fetcher).not.toHaveBeenCalled()
        expect(() => client.login('//evil.example')).toThrow(GatewayAuthError)
        expect(() => createGatewayAuthClient({ baseUrl: 'https://edge.example/path' })).toThrow()
    })

    it('reads minimal identity with decimal versions and preserves the application prefix for bootstrap', async () => {
        const fetcher = vi.fn().mockResolvedValueOnce(response({ ...identity(), accessToken: 'must-not-return' }))
            .mockResolvedValueOnce(response({ success: true, data: { ready: true } }))
        const client = createGatewayAuthClient({ baseUrl: 'https://edge.example', fetch: fetcher })
        await expect(client.identity()).resolves.toEqual(identity())
        await expect(client.bootstrap('/api/v1/auth/bootstrap')).resolves.toEqual({ ready: true })
        expect(fetcher.mock.calls.map(call => call[0])).toEqual([
            'https://edge.example/apps/edge-ui/auth/identity', 'https://edge.example/apps/edge-ui/api/v1/auth/bootstrap',
        ])
        for (const call of fetcher.mock.calls) expect(call[1]).toMatchObject({ credentials: 'include', redirect: 'error', cache: 'no-store' })
    })

    it('requests explicit reauthentication without allowing raw OIDC selectors or replaying an action', () => {
        const fetcher = vi.fn(); const navigate = vi.fn()
        const client = createGatewayAuthClient({ appAlias: 'edge-jianshen', fetch: fetcher, navigate })
        client.login(undefined, { reauthenticate: true })
        expect(navigate).toHaveBeenCalledWith('/apps/edge-jianshen/auth/login?reauthenticate=true')
        expect(fetcher).not.toHaveBeenCalled()
        expect(() => client.login(undefined, { prompt: 'none' } as never)).toThrow(GatewayAuthError)
    })

    it('keeps refresh explicit and status retries return no recovered credentials', async () => {
        const state = { operationId: id, status: 'SUCCEEDED', accessExpiresAt: 1_900_000_000, authorizationExpiresAt: 1_900_000_100, failureCode: null }
        const fetcher = vi.fn().mockResolvedValueOnce(response(proof())).mockResolvedValueOnce(response(state)).mockResolvedValueOnce(response(state))
        const client = createGatewayAuthClient({ fetch: fetcher })
        await expect(client.refresh(id)).resolves.toEqual(state)
        await expect(client.refreshStatus(id)).resolves.toEqual(state)
        expect(fetcher).toHaveBeenCalledTimes(3)
        expect(fetcher.mock.calls[1]?.[0]).toBe('/apps/edge-ui/auth/refresh')
        expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ operationId: id }) })
        expect(new Headers(fetcher.mock.calls[1]?.[1].headers).get('X-CSRF-TOKEN')).toBe('csrf-proof')
        expect(fetcher.mock.calls[2]?.[0]).toBe('/apps/edge-ui/auth/refresh-operations/' + id)
    })

    it('does not replay a refresh whose response is lost', async () => {
        const fetcher = vi.fn().mockResolvedValueOnce(response(proof())).mockRejectedValueOnce(new TypeError('connection lost'))
        const client = createGatewayAuthClient({ fetch: fetcher })
        await expect(client.refresh(id)).rejects.toMatchObject({ code: 'NETWORK_OR_TIMEOUT' })
        expect(fetcher).toHaveBeenCalledTimes(2)
    })

    it('clears local requests before logout and only follows the validated IdP SSO URI when requested', async () => {
        const result = { operationId: id, status: 'LOCAL_CLOSED', remoteState: 'PENDING', ssoLogoutUri: identity().ssoLogoutUri }
        const fetcher = vi.fn().mockResolvedValueOnce(response(proof())).mockResolvedValueOnce(response(result, 202))
        const navigate = vi.fn(); const client = createGatewayAuthClient({ fetch: fetcher, navigate })
        const previous = client.context.capture()
        await expect(client.logout({ sso: true })).resolves.toEqual(result)
        expect(previous.signal.aborted).toBe(true)
        expect(navigate).toHaveBeenCalledWith(result.ssoLogoutUri)
        expect(fetcher.mock.calls[1]?.[0]).toBe('/apps/edge-ui/auth/logout')
    })

    it('discards an identity response arriving after local logout begins', async () => {
        let finish: (response: Response) => void = () => undefined
        const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
            .mockResolvedValueOnce(response(proof())).mockResolvedValueOnce(response({ operationId: id, status: 'LOCAL_CLOSED', remoteState: 'CONFIRMED', ssoLogoutUri: identity().ssoLogoutUri }))
        const client = createGatewayAuthClient({ fetch: fetcher })
        const old = client.identity().catch(error => error)
        await client.logout()
        finish(response(identity()))
        expect(await old).toMatchObject({ name: 'AbortError' })
    })

    it.each([401, 403, 503])('classifies status %s without forwarding private response text or automatically refreshing', async status => {
        const fetcher = vi.fn().mockResolvedValue(response({ error_description: 'secret token details' }, status))
        const client = createGatewayAuthClient({ fetch: fetcher })
        const error = await client.identity().catch(failure => failure)
        expect(error).toMatchObject({ code: 'HTTP_ERROR', status, path: '/auth/identity' })
        expect(error.message).not.toContain('secret')
        expect(fetcher).toHaveBeenCalledTimes(1)
        expect(client.context.epoch).toBe(status === 401 ? 1 : 0)
    })

    it('rejects a forged refresh operation response and unsafe logout URI', async () => {
        const fetcher = vi.fn().mockResolvedValueOnce(response({ operationId: 'different', status: 'SUCCEEDED' }))
            .mockResolvedValueOnce(response(proof())).mockResolvedValueOnce(response({ operationId: id, status: 'LOCAL_CLOSED', remoteState: 'PENDING', ssoLogoutUri: 'javascript:alert(1)' }))
        const navigate = vi.fn(); const client = createGatewayAuthClient({ fetch: fetcher, navigate })
        await expect(client.refreshStatus(id)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
        await expect(client.logout({ sso: true })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
        expect(navigate).not.toHaveBeenCalled()
    })
})
