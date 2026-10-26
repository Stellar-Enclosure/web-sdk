export interface AuthRequestSnapshot {
  readonly epoch: number
  readonly signal: AbortSignal
  assertCurrent(): void
}

/** Local cancellation generations contain no server session id or credential. */
export class AuthRequestContext {
  private generation = 0
  private controller = new AbortController()
  private identityKey: string | undefined
  private readonly listeners = new Set<() => void>()

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get epoch(): number { return this.generation }

  capture(signal?: AbortSignal): AuthRequestSnapshot {
    const epoch = this.generation
    const combined = signal ? AbortSignal.any([this.controller.signal, signal]) : this.controller.signal
    return {
      epoch,
      signal: combined,
      assertCurrent: () => {
        if (epoch !== this.generation || combined.aborted) {
          throw new DOMException('Authentication request was cancelled or superseded', 'AbortError')
        }
      },
    }
  }

  invalidate(): void {
    this.controller.abort()
    this.controller = new AbortController()
    this.identityKey = undefined
    this.generation += 1
    this.listeners.forEach(listener => listener())
  }

  acceptIdentity(identityKey: string): void {
    if (this.identityKey !== undefined && this.identityKey !== identityKey) this.invalidate()
    this.identityKey = identityKey
  }
}

/** Preserve the fixed application prefix; URL('/api', base) would silently discard it. */
export const appendApiPath = (baseUrl: string, path: string): string => {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\#]/.test(path) || hasControlOrSpace(path)) {
    throw new TypeError('API path must be a local absolute path')
  }
  let pathname: string
  try { pathname = decodeURIComponent(path.split('?')[0]) }
  catch { throw new TypeError('API path encoding is invalid') }
  if (pathname.includes('\\') || pathname.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new TypeError('API path traversal is forbidden')
  }
  return normalizeApiBase(baseUrl) + path
}

export const normalizeApiBase = (value: string): string => {
  if (value !== value.trim() || /[\\?#]/.test(value) || hasControlOrSpace(value)) throw new TypeError('API base is invalid')
  const base = value.endsWith('/') ? value.slice(0, -1) : value
  if (base === '') return base
  const relative = base.startsWith('/') && !base.startsWith('//')
  const url = new URL(base, relative ? 'https://relative.invalid' : undefined)
  if (url.protocol !== 'https:' || url.username || url.password || (relative && url.origin !== 'https://relative.invalid')
    || (relative ? url.pathname !== base : url.origin + url.pathname.replace(/\/$/, '') !== base)) {
    throw new TypeError('API base must be a canonical HTTPS origin or local prefix')
  }
  return base
}

const hasControlOrSpace = (value: string): boolean => [...value].some(character => character.charCodeAt(0) <= 0x20)
