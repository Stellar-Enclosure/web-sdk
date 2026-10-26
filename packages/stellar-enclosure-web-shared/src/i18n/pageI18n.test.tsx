import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18next from 'i18next'
import { AuthRequestContext } from '../auth/authRequestContext'
import { permissionBinding } from '../test/permissionFixtures'
import { createPageI18nLoader, type PageI18nBundle, type PageI18nIdentity, type PageI18nQuery } from './pageI18n'

const query: PageI18nQuery = { bizCode: 'trade', namespaceCode: 'main', env: 'test', appCode: 'orders', catalogScopeId: '500', catalogActivationVersion: '7', pageCode: 'order.list', locale: 'en-US' }
const identity = (overrides: Partial<PageI18nIdentity> = {}): PageI18nIdentity => ({ ...permissionBinding(), snapshotExpiresAt: new Date(Date.now() + 60_000).toISOString(), ...overrides })
const bundle = (messages: Record<string, string>, overrides: Partial<PageI18nBundle> = {}): PageI18nBundle => ({
  pageCode: query.pageCode, locale: query.locale, defaultLocale: 'zh-CN', version: 'v1', messages,
  catalogScope: permissionBinding().catalogScope, catalogActivationVersion: '7', sourceVersions: { 'order-api': 'a'.repeat(64) },
  publishedOverrideRevisions: { common: '0', 'order.list': '1' }, diagnostics: [], ...overrides,
})
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed }); return { promise, resolve, reject } }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('version-bound page i18n', () => {
  it('caches only the bound view and replaces messages on a translation-only publication', async () => {
    vi.useFakeTimers()
    const fetchBundle = vi.fn().mockResolvedValueOnce(bundle({ title: 'Orders', removed: 'Old' }))
      .mockResolvedValueOnce(bundle({ title: 'New orders' }, { version: 'v2', publishedOverrideRevisions: { common: '0', 'order.list': '2' } }))
      .mockResolvedValueOnce(bundle({ title: 'Latest' }, { version: 'v3', publishedOverrideRevisions: { common: '0', 'order.list': '3' } }))
    const loader = createPageI18nLoader({ fetchBundle, requestContext: new AuthRequestContext(), cacheTtlMs: 1000 })
    loader.setIdentity(identity())
    const first = await loader.load(query)
    expect((await loader.load(query)).source).toBe('cache')
    const next = await loader.load(query, { refresh: true })
    expect(next.version).toBe('v2'); expect(next.messages).toEqual({ title: 'New orders' })
    expect(first.t('removed')).toBe('removed')
    await vi.advanceTimersByTimeAsync(1001)
    expect((await loader.load(query)).t('title')).toBe('Latest')
    expect(fetchBundle).toHaveBeenCalledTimes(3)
    loader.dispose()
  })

  it('deduplicates current loads and rejects a late failed request without clearing the replacement', async () => {
    const old = deferred<PageI18nBundle>(); const current = deferred<PageI18nBundle>()
    const fetchBundle = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const loader = createPageI18nLoader({ fetchBundle, requestContext: new AuthRequestContext() })
    loader.setIdentity(identity())
    const first = loader.load(query).catch(error => error)
    await Promise.resolve()
    const replacement = loader.load(query, { refresh: true })
    const concurrent = loader.load(query)
    await Promise.resolve()
    old.reject({ status: 401 })
    expect(await first).toMatchObject({ name: 'AbortError' })
    current.resolve(bundle({ title: 'Published' }, { version: 'v2' }))
    expect((await replacement).t('title')).toBe('Published')
    expect((await concurrent).t('title')).toBe('Published')
    expect(fetchBundle).toHaveBeenCalledTimes(2)
    loader.dispose()
  })

  it('drops late responses and all old translations immediately when auth requests are invalidated', async () => {
    const delayed = deferred<PageI18nBundle>()
    const requestContext = new AuthRequestContext()
    const fetchBundle = vi.fn().mockResolvedValueOnce(bundle({ title: 'Alice' })).mockReturnValueOnce(delayed.promise)
    const loader = createPageI18nLoader({ fetchBundle, requestContext })
    loader.setIdentity(identity())
    const shown = await loader.load(query)
    const old = loader.load(query, { refresh: true }).catch(error => error)
    await Promise.resolve()
    requestContext.invalidate()
    expect(shown.t('title')).toBe('title')
    delayed.resolve(bundle({ title: 'Late Alice' }))
    expect(await old).toMatchObject({ name: 'AbortError' })
    await expect(loader.load(query)).rejects.toMatchObject({ name: 'AbortError' })
    expect(() => loader.setIdentity(identity())).toThrow('invalid or expired')
    loader.dispose()
  })

  it('isolates identity, authorization facts and catalog activation while retaining same-scope locale concurrency', async () => {
    const fetchBundle = vi.fn().mockResolvedValueOnce(bundle({ title: 'First' }))
      .mockResolvedValueOnce(bundle({ title: 'Second' }, { catalogActivationVersion: '8' }))
      .mockResolvedValueOnce(bundle({ title: '中文' }, { catalogActivationVersion: '8', locale: 'zh-CN' }))
    const loader = createPageI18nLoader({ fetchBundle, requestContext: new AuthRequestContext() })
    loader.setIdentity(identity())
    const first = await loader.load(query)
    loader.setIdentity(identity({ subject: 'bob', authVersion: '12', catalogVersion: '8' }))
    expect(first.t('title')).toBe('title')
    await expect(loader.load(query)).rejects.toThrow('catalog scope and version')
    const nextQuery = { ...query, catalogActivationVersion: '8' }
    expect((await loader.load(nextQuery)).t('title')).toBe('Second')
    expect((await loader.load({ ...nextQuery, locale: 'zh-CN' })).t('title')).toBe('中文')
    await expect(loader.load({ ...nextQuery, namespaceCode: 'other' })).rejects.toThrow('catalog scope and version')
    loader.dispose()
  })

  it.each([401, 403, 409])('never falls back to private cached translations after status %s', async status => {
    const fetchBundle = vi.fn().mockResolvedValueOnce(bundle({ title: 'Private' })).mockRejectedValueOnce({ status })
    const loader = createPageI18nLoader({ fetchBundle, requestContext: new AuthRequestContext() })
    loader.setIdentity(identity())
    const previous = await loader.load(query)
    await expect(loader.load(query, { refresh: true, fallbackMessages: { title: 'Code default' } })).rejects.toMatchObject({ status })
    expect(previous.t('title')).toBe('title')
    loader.dispose()
  })

  it('allows only same-context display fallbacks on availability failure without changing permissions', async () => {
    const fetchBundle = vi.fn().mockResolvedValueOnce(bundle({ title: 'Last published' })).mockRejectedValue({ status: 503 })
    const loader = createPageI18nLoader({ fetchBundle, requestContext: new AuthRequestContext() })
    loader.setIdentity(identity())
    await loader.load(query)
    const stale = await loader.load(query, { refresh: true })
    expect(stale.source).toBe('stale'); expect(stale.error).toEqual({ status: 503 })
    const fallback = await loader.load({ ...query, pageCode: 'order.other' }, { fallbackMessages: { title: 'Code default' } })
    expect(fallback.source).toBe('fallback'); expect(fallback.version).toBeNull()
    expect(stale.t('title')).toBe('Last published')
    loader.dispose()
  })

  it('expires text context and rejects a late bundle after its authoritative snapshot deadline', async () => {
    vi.useFakeTimers()
    const delayed = deferred<PageI18nBundle>()
    const loader = createPageI18nLoader({ fetchBundle: () => delayed.promise, requestContext: new AuthRequestContext() })
    loader.setIdentity(identity({ snapshotExpiresAt: new Date(Date.now() + 1000).toISOString() }))
    const pending = loader.load(query).catch(error => error)
    await vi.advanceTimersByTimeAsync(1001)
    delayed.resolve(bundle({ title: 'Too late' }))
    expect(await pending).toMatchObject({ name: 'AbortError' })
    loader.dispose()
  })

  it('uses JDK locale rules and rejects mismatched remote scope, versions and default locales', async () => {
    const fetchBundle = vi.fn().mockResolvedValueOnce(bundle({ title: 'Orders' }))
      .mockResolvedValueOnce(bundle({ title: 'Soviet tag preserved' }, { locale: 'en-SU' }))
      .mockResolvedValueOnce(bundle({ title: 'Wrong' }, { catalogActivationVersion: '6' }))
      .mockResolvedValueOnce(bundle({ title: 'Wrong' }, { defaultLocale: 'iw-IL' }))
    const loader = createPageI18nLoader({ fetchBundle, requestContext: new AuthRequestContext(), cacheTtlMs: 0 })
    loader.setIdentity(identity())
    await loader.load({ ...query, locale: 'en-us' })
    expect(fetchBundle.mock.calls[0][0].locale).toBe('en-US')
    await loader.load({ ...query, locale: 'en-SU' })
    expect(fetchBundle.mock.calls[1][0].locale).toBe('en-SU')
    loader.clear()
    await expect(loader.load(query)).rejects.toThrow('does not match')
    await expect(loader.load(query)).rejects.toThrow('does not match')
    await expect(loader.load({ ...query, locale: 'en_US' })).rejects.toThrow('locale is invalid')
    loader.dispose()
  })

  it('renders remote markup and interpolation as text without modifying global i18next resources', async () => {
    await i18next.init({ lng: 'en-US', resources: { 'en-US': { common: { title: 'Global' } } } })
    const loader = createPageI18nLoader({ requestContext: new AuthRequestContext(), fetchBundle: async () => bundle({
      'actions.create': 'Create {{name}}', markup: '<img src=x onerror=alert(1)>', nesting: '$t(title, {"ns":"common"})',
    }) })
    loader.setIdentity(identity())
    const page = await loader.load(query)
    const { container } = render(<div>{page.t('actions.create', { name: '<script>alert(1)</script>' })}{page.t('markup')}</div>)
    expect(screen.getByText('Create <script>alert(1)</script><img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(container.querySelector('script,img')).toBeNull()
    expect(page.t('nesting')).toContain('$t(')
    expect(i18next.t('title', { ns: 'common' })).toBe('Global')
    loader.dispose()
  })
})
