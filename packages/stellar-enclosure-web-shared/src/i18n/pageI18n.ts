import { createInstance } from 'i18next'

export interface PageI18nQuery {
  readonly bizCode: string
  readonly namespaceCode: string
  readonly env: string
  readonly appCode: string
  readonly pageCode: string
  readonly locale: string
}

export interface PageI18nBundle {
  readonly pageCode: string
  readonly locale: string
  readonly defaultLocale: string
  readonly version: string
  readonly messages: Readonly<Record<string, string>>
}

export type PageI18nValues = Readonly<Record<string, string | number>>

export interface PageI18nResult {
  readonly pageCode: string
  readonly locale: string
  readonly defaultLocale: string
  readonly version: string | null
  readonly messages: Readonly<Record<string, string>>
  readonly source: 'remote' | 'cache' | 'stale' | 'fallback'
  readonly error?: unknown
  readonly t: (key: string, values?: PageI18nValues) => string
}

export interface PageI18nLoaderOptions {
  readonly fetchBundle: (query: PageI18nQuery, options: { readonly signal: AbortSignal }) => Promise<PageI18nBundle>
  readonly cacheTtlMs?: number
}

export interface PageI18nLoadOptions {
  readonly refresh?: boolean
  readonly fallbackMessages?: Readonly<Record<string, string>>
}

export interface PageI18nLoader {
  /** Use an authenticated tenant/session identity, never a token or a page-supplied tenant. */
  readonly setIdentity: (identity: string | null) => void
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
    || Object.values(messages).some((value) => typeof value !== 'string')) {
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
  let identity: string | null = null
  let generation = 0
  let namespaceSequence = 0
  let disposed = false

  const assertActive = (expectedGeneration: number): void => {
    if (disposed || identity === null || generation !== expectedGeneration) {
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
      if (disposed || generation !== expectedGeneration || identity === null) return key
      return i18n.t(key, { lng: bundle.locale, ns: namespace, replace: values, nest: false })
    },
  })

  const load: PageI18nLoader['load'] = async (query, loadOptions = {}) => {
    const expectedGeneration = generation
    assertActive(expectedGeneration)
    if ([query.bizCode, query.namespaceCode, query.env, query.appCode, query.pageCode]
      .some((value) => typeof value !== 'string' || !value.trim())) {
      throw new Error('Page i18n scope and pageCode are required')
    }
    const locale = Intl.getCanonicalLocales(query.locale)[0]
    if (!locale) throw new Error('Page i18n locale is required')
    const normalizedQuery = { ...query, locale }
    const scopeKey = JSON.stringify([query.bizCode, query.namespaceCode, query.env, query.appCode, query.pageCode])
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
          || Intl.getCanonicalLocales(bundle.defaultLocale)[0] !== bundle.defaultLocale) {
          throw new Error('Page i18n bundle does not match the requested page and locale')
        }
        const previous = cache.get(cacheKey)
        const checkedBundle = Object.freeze({ ...bundle, messages: copyMessages(bundle.messages) })
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
      const previous = cache.get(cacheKey)
      if (previous) return result(previous.bundle, namespace, 'stale', expectedGeneration, error)
      if (loadOptions.fallbackMessages === undefined) throw error
      await ready
      assertRequestActive(expectedGeneration, cacheKey, request.controller)
      const messages = copyMessages(loadOptions.fallbackMessages)
      install(namespace, locale, messages)
      return result({ pageCode: query.pageCode, locale, defaultLocale: locale, version: null, messages },
        namespace, 'fallback', expectedGeneration, error)
    }
  }

  return {
    setIdentity: (nextIdentity) => {
      if (disposed) throw new Error('Page i18n loader has been disposed')
      if (nextIdentity !== null && !nextIdentity.trim()) throw new Error('Page i18n identity must not be empty')
      if (identity === nextIdentity) return
      clear()
      identity = nextIdentity
    },
    load,
    clear,
    dispose: () => {
      clear()
      identity = null
      disposed = true
    },
  }
}
