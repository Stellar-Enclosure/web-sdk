import { isPermissionSnapshot, type PermissionSnapshot } from '@stellar-enclosure/stellar-enclosure-web-shared/permissions'
import { Rbac3RequestError, TIANQUAN_JIANSHEN_ERROR_DEFINITIONS, type Rbac3ErrorCode } from '../errors'
import type {
  ActiveRoleSetView,
  Rbac3AboutView,
  ResultRecord,
  Rbac3Client,
  ReplaceActiveRolesRequest,
  ReplaceActiveRolesResult,
  RoleActivationCandidateView,
} from '../types'

export interface Rbac3ApiClientOptions {
  /** Pass shared createHttpClient with the fixed application base, CSRF and request context. */
  readonly transport: { request<T>(path: string, init?: RequestInit): Promise<T> }
}

/** Domain envelope adapter; shared browser transport owns Cookie, CSRF and cancellation. */
export class Rbac3ApiClient implements Rbac3Client {
  constructor(private readonly options: Rbac3ApiClientOptions) {}

  getActivationCandidates(signal?: AbortSignal): Promise<RoleActivationCandidateView> {
    return this.request('/api/tianquan-jianshen/v1/auth/role-activation-candidates', { signal })
  }

  getActiveRoles(signal?: AbortSignal): Promise<ActiveRoleSetView> {
    return this.request('/api/tianquan-jianshen/v1/auth/role-activations', { signal })
  }

  replaceActiveRoles(request: ReplaceActiveRolesRequest, signal?: AbortSignal): Promise<ReplaceActiveRolesResult> {
    return this.request('/api/tianquan-jianshen/v1/auth/role-activations', { method: 'PUT', body: JSON.stringify(request), signal })
  }

  getAbout(signal?: AbortSignal): Promise<Rbac3AboutView> { return this.request('/api/v1/auth/about', { signal }) }

  async getPermissionSnapshot(signal?: AbortSignal): Promise<PermissionSnapshot> {
    const value = await this.request<unknown>('/api/v1/authorization/effective-permissions', { signal })
    if (!isPermissionSnapshot(value)) throw new Rbac3RequestError({ status: 200, code: 'INVALID_RESPONSE', message: 'Permission snapshot is invalid', retryable: false })
    return value
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let envelope: ResultRecord<T>
    try { envelope = await this.options.transport.request<ResultRecord<T>>(path, init) }
    catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
      const error = cause as { status?: unknown; code?: unknown; message?: unknown }
      const status = typeof error?.status === 'number' ? error.status : 0
      const code = typeof error?.code === 'string' && Object.hasOwn(TIANQUAN_JIANSHEN_ERROR_DEFINITIONS, error.code)
        ? error.code as Rbac3ErrorCode : status === 0 ? 'NETWORK_ERROR' : 'INVALID_RESPONSE'
      throw new Rbac3RequestError({ status, code, message: 'Authorization request failed', retryable: status === 0 || status >= 500 })
    }
    if (envelope === null || typeof envelope !== 'object' || envelope.success !== true || !('data' in envelope) || envelope.data === null) {
      throw new Rbac3RequestError({ status: 200, code: 'INVALID_RESPONSE', message: 'Authorization response envelope is invalid', retryable: false })
    }
    return envelope.data
  }
}
