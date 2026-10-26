import { describe, expect, it, vi } from 'vitest'
import { Rbac3ApiClient } from './Rbac3ApiClient'
import { snapshot } from '../test/permissionFixtures'

describe('Rbac3ApiClient shared transport', () => {
  it('uses the injected Cookie/CSRF transport and unwraps domain envelopes', async () => {
    const request = vi.fn().mockResolvedValue({ success: true, data: { active: [] } })
    const client = new Rbac3ApiClient({ transport: { request } })
    await expect(client.getActiveRoles()).resolves.toEqual({ active: [] })
    expect(request).toHaveBeenCalledWith('/api/tianquan-jianshen/v1/auth/role-activations', { signal: undefined })
  })

  it('retains authoritative status codes without replaying', async () => {
    const request = vi.fn().mockRejectedValue({ status: 403, code: 'PERMISSION_DENIED' })
    const client = new Rbac3ApiClient({ transport: { request } })
    await expect(client.getActiveRoles()).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED', retryable: false })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('preserves cancellation and rejects malformed envelopes', async () => {
    const request = vi.fn().mockRejectedValueOnce(new DOMException('superseded', 'AbortError')).mockResolvedValueOnce({ success: false, data: [] })
    const client = new Rbac3ApiClient({ transport: { request } })
    await expect(client.getActiveRoles()).rejects.toMatchObject({ name: 'AbortError' })
    await expect(client.getActiveRoles()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('uses the fixed effective-permissions endpoint and rejects numeric versions', async () => {
    const request = vi.fn().mockResolvedValueOnce({ success: true, data: snapshot() })
      .mockResolvedValueOnce({ success: true, data: { ...snapshot(), authVersion: 11 } })
    const client = new Rbac3ApiClient({ transport: { request } })
    await expect(client.getPermissionSnapshot()).resolves.toMatchObject({ authVersion: '11' })
    expect(request).toHaveBeenCalledWith('/api/v1/authorization/effective-permissions', { signal: undefined })
    await expect(client.getPermissionSnapshot()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

})
