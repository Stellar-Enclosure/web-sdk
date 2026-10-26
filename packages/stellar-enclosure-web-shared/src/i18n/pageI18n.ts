import { createInstance } from 'i18next'
import type { AuthRequestContext } from '../auth/authRequestContext'
import { catalogScopeKey, copyPermissionBinding, isCatalogScope, isPermissionSnapshotContext, permissionBindingKey, snapshotExpiry, type CatalogScope, type PermissionSnapshotContext } from '../permissions/permissionSnapshot'
import { canonicalJdk25Locale, isCanonicalJdk25Locale } from './jdk25Locale'

export interface PageI18nQuery {
  readonly bizCode: string
  readonly namespaceCode: string
  readonly env: string
  readonly appCode: string
  readonly catalogScopeId: string
  readonly catalogActivationVersion: string
  readonly pageCode: string
  readonly locale: string
}

export interface PageI18nBundle {
  readonly pageCode: string
  readonly locale: string
  readonly defaultLocale: string
  readonly version: string
  readonly messages: Readonly<Record<string, string>>
  readonly catalogScope: CatalogScope
  readonly catalogActivationVersion: string
  readonly sourceVersions: Readonly<Record<string, string>>
  readonly publishedOverrideRevisions: Readonly<Record<string, string>>
  readonly diagnostics: readonly { readonly pageCode: string; readonly key: string; readonly reason: string }[]
}

export type PageI18nValues = Readonly<Record<string, string | number>>

export interface PageI18nResult extends Omit<PageI18nBundle, 'version'> {
  readonly version: string | null
  readonly source: 'remote' | 'cache' | 'stale' | 'fallback'
  readonly error?: unknown
  readonly t: (key: string, values?: PageI18nValues) => string
}

export interface PageI18nIdentity extends PermissionSnapshotContext { readonly snapshotExpiresAt: string }

export interface PageI18nLoaderOptions {
  readonly requestContext: AuthRequestContext
  readonly fetchBundle: (query: PageI18nQuery, options: { readonly signal: AbortSignal }) => Promise<PageI18nBundle>
  readonly cacheTtlMs?: number
}

export interface PageI18nLoadOptions {
  readonly refresh?: boolean
  readonly fallbackMessages?: Readonly<Record<string, string>>
}

export interface PageI18nLoader {
  /** Use verified issuer/tenant/subject facts and the local request epoch, never a token or page-supplied tenant. */
  readonly setIdentity: (identity: PageI18nIdentity | null) => void
  readonly load: (query: PageI18nQuery, options?: PageI18nLoadOptions) => Promise<PageI18nResult>
  readonly clear: () => void
  readonly dispose: () => void
}

interface CachedBundle {
  readonly bundle: PageI18nBundle
  readonly namespace: string
  readonly loadedAt: number
}

interface PendingBundle {
  readonly controller: AbortController
  readonly promise: Promise<CachedBundle>
}

const copyMessages = (messages: Readonly<Record<string, string>>): Readonly<Record<string, string>> => {
  if (!messages || typeof messages !== 'object' || Array.isArray(messages)
    || Object.entries(messages).some(([key, value]) => typeof value !== 'string'
      || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(key) || key.split('.').some(part => ['__proto__', 'constructor', 'prototype'].includes(part)))) {
    throw new Error('Page i18n messages must be a flat string map')
  }
  return Object.freeze({ ...messages })
}

/** Loads published page bundles without changing the application's global i18next instance. */
export const createPageI18nLoader = (options: PageI18nLoaderOptions): PageI18nLoader => {
  const cacheTtlMs = options.cacheTtlMs ?? 60_000
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 0) {
    throw new Error('Page i18n cacheTtlMs must be a finite non-negative number')
  }
  const i18n = createInstance()
  const ready = i18n.init({
    lng: 'zh-CN',
    fallbackLng: false,
    load: 'currentOnly',
    ns: [],
    resources: {},
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false, skipOnVariables: true },
    returnNull: false,
    returnEmptyString: false,
  })
  const cache = new Map<string, CachedBundle>()
  const pending = new Map<string, PendingBundle>()
  const latestRequests = new Map<string, AbortController>()
  const namespaces = new Map<string, string>()
  const resources = new Map<string, Set<string>>()
  let identity: PageI18nIdentity | null = null
  let identityKey: string | null = null
  let identityTimer: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  let namespaceSequence = 0
  let disposed = false

  const assertActive = (expectedGeneration: number): void => {
    if (disposed || identity === null || generation !== expectedGeneration || identity.requestEpoch !== options.requestContext.epoch
      || snapshotExpiry(identity.snapshotExpiresAt) <= Date.now()) {
      throw new DOMException('Page i18n identity is no longer active', 'AbortError')
    }
  }

  const assertRequestActive = (expectedGeneration: number, key: string, controller: AbortController): void => {
    assertActive(expectedGeneration)
    if (controller.signal.aborted || latestRequests.get(key) !== controller) {
      throw new DOMException('Page i18n request has been superseded', 'AbortError')
    }
  }

  const clear = (): void => {
    generation += 1
    pending.forEach(({ controller }) => controller.abort())
    pending.clear()
    latestRequests.clear()
    cache.clear()
    resources.forEach((locales, namespace) => {
      locales.forEach((locale) => i18n.removeResourceBundle(locale, namespace))
    })
    resources.clear()
    namespaces.clear()
  }

  const install = (namespace: string, locale: string, messages: Readonly<Record<string, string>>): void => {
    // Replacement is intentional: merging would retain keys removed by a later publication.
    i18n.removeResourceBundle(locale, namespace)
    i18n.addResourceBundle(locale, namespace, { ...messages })
    const locales = resources.get(namespace) ?? new Set<string>()
    locales.add(locale)
    resources.set(namespace, locales)
  }

  const result = (
    bundle: Omit<PageI18nBundle, 'version'> & { readonly version: string | null },
    namespace: string,
    source: PageI18nResult['source'],
    expectedGeneration: number,
    error?: unknown,
  ): PageI18nResult => ({
    ...bundle,
    source,
    ...(error === undefined ? {} : { error }),
    t: (key, values) => {
      // A component may retain an old result after logout or a tenant switch.
      if (disposed || generation !== expectedGeneration || identity === null || identity.requestEpoch !== options.requestContext.epoch
        || snapshotExpiry(identity.snapshotExpiresAt) <= Date.now()) return key
      return i18n.t(key, { lng: bundle.locale, ns: namespace, replace: values, nest: false })
    },
  })

  const load: PageI18nLoader['load'] = async (query, loadOptions = {}) => {
    const expectedGeneration = generation
    assertActive(expectedGeneration)
    const owner = identity
    if (owner === null) throw new DOMException('Page i18n identity is no longer active', 'AbortError')
    if ([query.bizCode, query.namespaceCode, query.env, query.appCode, query.pageCode]
      .some((value) => typeof value !== 'string' || !value.trim())) {
      throw new Error('Page i18n scope and pageCode are required')
    }
    const locale = canonicalJdk25Locale(query.locale)
    if (!isCanonicalJdk25Locale(locale)) throw new Error('Page i18n locale is invalid')
    if (query.catalogScopeId !== owner.catalogScope.catalogScopeId || query.catalogActivationVersion !== owner.catalogVersion
      || query.bizCode !== owner.catalogScope.businessCode || query.namespaceCode !== owner.catalogScope.namespaceCode
      || query.env !== owner.catalogScope.environment || query.appCode !== owner.catalogScope.applicationCode) {
      throw new Error('Page i18n query does not match the current catalog scope and version')
    }
    const normalizedQuery = { ...query, locale }
    const scopeKey = JSON.stringify([identityKey, query.catalogScopeId, query.catalogActivationVersion, query.bizCode, query.namespaceCode, query.env, query.appCode, query.pageCode])
    const cacheKey = JSON.stringify([scopeKey, locale])
    const namespace = namespaces.get(scopeKey) ?? `page-${++namespaceSequence}`
    namespaces.set(scopeKey, namespace)
    const cached = cache.get(cacheKey)
    if (!loadOptions.refresh && cached && Date.now() - cached.loadedAt < cacheTtlMs) {
      return result(cached.bundle, namespace, 'cache', expectedGeneration)
    }

    let request = pending.get(cacheKey)
    if (loadOptions.refresh && request) {
      request.controller.abort()
      request = undefined
    }
    if (!request) {
      const controller = new AbortController()
      latestRequests.set(cacheKey, controller)
      const promise = (async (): Promise<CachedBundle> => {
        await ready
        assertRequestActive(expectedGeneration, cacheKey, controller)
        const bundle = await options.fetchBundle(normalizedQuery, { signal: controller.signal })
        assertRequestActive(expectedGeneration, cacheKey, controller)
        if (!bundle || bundle.pageCode !== query.pageCode || bundle.locale !== locale
          || typeof bundle.version !== 'string' || !bundle.version
          || typeof bundle.defaultLocale !== 'string'
          || !isCanonicalJdk25Locale(bundle.defaultLocale) || !isCatalogScope(bundle.catalogScope)
          || catalogScopeKey(bundle.catalogScope) !== catalogScopeKey(owner.catalogScope) || bundle.catalogActivationVersion !== owner.catalogVersion
          || !versionMap(bundle.sourceVersions, /^[a-f0-9]{64}$/) || !versionMap(bundle.publishedOverrideRevisions, /^(?:0|[1-9][0-9]{0,18})$/)) {
          throw new Error('Page i18n bundle does not match the requested page and locale')
        }
        const previous = cache.get(cacheKey)
        if (previous?.bundle.version === bundle.version && (mapKey(previous.bundle.sourceVersions) !== mapKey(bundle.sourceVersions)
          || mapKey(previous.bundle.publishedOverrideRevisions) !== mapKey(bundle.publishedOverrideRevisions))) throw new Error('Page i18n version metadata is inconsistent')
        const checkedBundle = Object.freeze({ ...bundle, catalogScope: Object.freeze({ ...bundle.catalogScope }),
          sourceVersions: Object.freeze({ ...bundle.sourceVersions }), publishedOverrideRevisions: Object.freeze({ ...bundle.publishedOverrideRevisions }),
          diagnostics: Object.freeze([...(bundle.diagnostics ?? [])]), messages: copyMessages(bundle.messages) })
        const entry = {
          bundle: previous?.bundle.version === bundle.version ? previous.bundle : checkedBundle,
          namespace,
          loadedAt: Date.now(),
        }
        if (previous?.bundle.version !== bundle.version) install(namespace, locale, entry.bundle.messages)
        cache.set(cacheKey, entry)
        return entry
      })().finally(() => {
        if (pending.get(cacheKey)?.controller === controller) pending.delete(cacheKey)
      })
      request = { controller, promise }
      pending.set(cacheKey, request)
    }

    try {
      const entry = await request.promise
      assertRequestActive(expectedGeneration, cacheKey, request.controller)
      return result(entry.bundle, namespace, 'remote', expectedGeneration)
    } catch (error) {
      assertRequestActive(expectedGeneration, cacheKey, request.controller)
      const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined
      if (status === 401 || status === 403 || status === 409) {
        clear(); clearTimeout(identityTimer)
        if (status !== 403) { identity = null; identityKey = null }
        throw error
      }
      assertRequestActive(expectedGeneration, cacheKey, request.controller)
      const previous = cache.get(cacheKey)
      if (previous) return result(previous.bundle, namespace, 'stale', expectedGeneration, error)
      if (loadOptions.fallbackMessages === undefined) throw error
      await ready
      assertRequestActive(expectedGeneration, cacheKey, request.controller)
      const messages = copyMessages(loadOptions.fallbackMessages)
      install(namespace, locale, messages)
      return result({ pageCode: query.pageCode, locale, defaultLocale: locale, version: null, messages, catalogScope: owner.catalogScope,
        catalogActivationVersion: owner.catalogVersion, sourceVersions: {}, publishedOverrideRevisions: {}, diagnostics: [] },
        namespace, 'fallback', expectedGeneration, error)
    }
  }

  const unsubscribe = options.requestContext.subscribe(() => { clear(); clearTimeout(identityTimer); identity = null; identityKey = null })

  return {
    setIdentity: (nextIdentity) => {
      if (disposed) throw new Error('Page i18n loader has been disposed')
      if (nextIdentity !== null && (!isPermissionSnapshotContext(nextIdentity) || nextIdentity.requestEpoch !== options.requestContext.epoch
        || !(snapshotExpiry(nextIdentity.snapshotExpiresAt) > Date.now()))) throw new Error('Page i18n identity context is invalid or expired')
      const nextKey = nextIdentity === null ? null : JSON.stringify([permissionBindingKey(nextIdentity), nextIdentity.requestEpoch, nextIdentity.snapshotExpiresAt])
      if (identityKey === nextKey) return
      clear(); clearTimeout(identityTimer)
      identityKey = nextKey
      identity = nextIdentity === null ? null : Object.freeze({ ...copyPermissionBinding(nextIdentity),
        requestEpoch: nextIdentity.requestEpoch, snapshotExpiresAt: nextIdentity.snapshotExpiresAt })
      if (identity !== null) identityTimer = setTimeout(() => {
        clear(); identity = null; identityKey = null
      }, Math.max(1, Math.min(snapshotExpiry(identity.snapshotExpiresAt) - Date.now(), 2_147_483_647)))
    },
    load,
    clear,
    dispose: () => {
      clear(); clearTimeout(identityTimer); unsubscribe()
      identity = null; identityKey = null
      disposed = true
    },
  }
}

const versionMap = (value: unknown, pattern: RegExp): value is Readonly<Record<string, string>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
  && Object.entries(value).every(([key, version]) => key.length > 0 && key.length <= 128 && !['__proto__', 'constructor', 'prototype'].includes(key)
    && typeof version === 'string' && pattern.test(version))
const mapKey = (value: Readonly<Record<string, string>>): string => JSON.stringify(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
