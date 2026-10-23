import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18next from 'i18next'
import { createPageI18nLoader, type PageI18nBundle, type PageI18nQuery } from './pageI18n'

const query: PageI18nQuery = {
  bizCode: 'retail', namespaceCode: 'main', env: 'prod', appCode: 'shop', pageCode: 'order.list', locale: 'en-US',
}

const bundle = (messages: Record<string, string>, overrides: Partial<PageI18nBundle> = {}): PageI18nBundle => ({
  pageCode: query.pageCode, locale: query.locale, defaultLocale: 'zh-CN', version: 'v1', messages, ...overrides,
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  return { promise, resolve, reject }
}

afterEach(() => { vi.restoreAllMocks() })

describe('createPageI18nLoader', () => {
  it('caches within the TTL, refreshes explicitly and replaces deleted keys on a new version', async () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const fetchBundle = vi.fn()
      .mockResolvedValueOnce(bundle({ title: 'Orders', removed: 'Old' }))
      .mockResolvedValueOnce(bundle({ title: 'New orders' }, { version: 'v2' }))
      .mockResolvedValueOnce(bundle({ title: 'Latest orders' }, { version: 'v3' }))
    const loader = createPageI18nLoader({ fetchBundle })
    loader.setIdentity('tenant-a:session-1')

    const first = await loader.load(query)
    expect(first.source).toBe('remote')
    expect((await loader.load(query)).source).toBe('cache')
    expect(fetchBundle).toHaveBeenCalledTimes(1)
    const refreshed = await loader.load(query, { refresh: true })
    expect(refreshed.version).toBe('v2')
    expect(refreshed.messages).toEqual({ title: 'New orders' })
    expect(refreshed.t('removed')).toBe('removed')
    expect(first.t('removed')).toBe('removed')
    now += 60_000
    expect((await loader.load(query)).t('title')).toBe('Latest orders')
    expect(fetchBundle).toHaveBeenCalledTimes(3)
    loader.dispose()
  })

  it('deduplicates in-flight loads and keeps the published content for the same opaque version', async () => {
    const response = deferred<PageI18nBundle>()
    const fetchBundle = vi.fn().mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(bundle({ title: 'Unexpected mutation' }))
    const loader = createPageI18nLoader({ fetchBundle })
    loader.setIdentity('tenant-a:session-1')
    const first = loader.load(query)
    const second = loader.load(query)
    response.resolve(bundle({ title: 'Orders' }))
    expect((await first).t('title')).toBe('Orders')
    expect((await second).t('title')).toBe('Orders')
    expect(fetchBundle).toHaveBeenCalledTimes(1)
    expect((await loader.load(query, { refresh: true })).t('title')).toBe('Orders')
    loader.dispose()
  })

  it('replaces an in-flight request on refresh and ignores its late pre-publication response', async () => {
    const oldResponse = deferred<PageI18nBundle>()
    const newResponse = deferred<PageI18nBundle>()
    const fetchBundle = vi.fn().mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise)
    const loader = createPageI18nLoader({ fetchBundle })
    loader.setIdentity('tenant-a:session-1')
    const oldRequest = loader.load(query)
    const cancelled = expect(oldRequest).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    const oldSignal = fetchBundle.mock.calls[0]?.[1].signal as AbortSignal

    const refresh = loader.load(query, { refresh: true })
    await Promise.resolve()
    expect(fetchBundle).toHaveBeenCalledTimes(2)
    expect(oldSignal.aborted).toBe(true)
    newResponse.resolve(bundle({ title: 'New publication' }, { version: 'v2' }))
    const published = await refresh
    oldResponse.resolve(bundle({ title: 'Before publication', removed: 'Old key' }))
    await cancelled

    expect(published.version).toBe('v2')
    expect(published.t('title')).toBe('New publication')
    expect(published.t('removed')).toBe('removed')
    expect((await loader.load(query)).messages).toEqual({ title: 'New publication' })
    loader.dispose()
  })

  it('does not clear a replacement request or install fallback when the cancelled request fails', async () => {
    const oldResponse = deferred<PageI18nBundle>()
    const newResponse = deferred<PageI18nBundle>()
    const fetchBundle = vi.fn().mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise)
    const loader = createPageI18nLoader({ fetchBundle })
    loader.setIdentity('tenant-a:session-1')
    const oldRequest = loader.load(query, { fallbackMessages: { title: 'Old local fallback' } })
    const cancelled = expect(oldRequest).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    const refresh = loader.load(query, { refresh: true })
    oldResponse.reject(new Error('Late network failure'))
    await cancelled

    const concurrent = loader.load(query)
    await Promise.resolve()
    expect(fetchBundle).toHaveBeenCalledTimes(2)
    newResponse.resolve(bundle({ title: 'New publication' }, { version: 'v2' }))
    expect((await refresh).t('title')).toBe('New publication')
    expect((await concurrent).t('title')).toBe('New publication')
    loader.dispose()
  })

  it('preserves only the same scope and locale on failure and exposes the failure', async () => {
    const failure = new Error('Gateway unavailable')
    const fetchBundle = vi.fn().mockResolvedValueOnce(bundle({ title: 'Orders' })).mockRejectedValue(failure)
    const loader = createPageI18nLoader({ fetchBundle })
    loader.setIdentity('tenant-a:session-1')
    await loader.load(query)

    const stale = await loader.load(query, { refresh: true, fallbackMessages: { title: 'Local' } })
    expect(stale.source).toBe('stale')
    expect(stale.error).toBe(failure)
    expect(stale.t('title')).toBe('Orders')
    const local = await loader.load({ ...query, locale: 'zh-CN' }, { fallbackMessages: { title: '本地订单' } })
    expect(local.source).toBe('fallback')
    expect(local.version).toBeNull()
    expect(local.t('title')).toBe('本地订单')
    await expect(loader.load({ ...query, appCode: 'other' })).rejects.toBe(failure)
    expect(stale.t('title')).toBe('Orders')
    loader.dispose()
  })

  it('clears old resources on a tenant switch even when the old client ignores abort', async () => {
    const oldResponse = deferred<PageI18nBundle>()
    const fetchBundle = vi.fn()
      .mockResolvedValueOnce(bundle({ title: 'Tenant A' }))
      .mockReturnValueOnce(oldResponse.promise)
      .mockResolvedValueOnce(bundle({ title: 'Tenant B' }))
    const loader = createPageI18nLoader({ fetchBundle })
    loader.setIdentity('tenant-a:session-1')
    const oldResult = await loader.load(query)
    const oldRequest = loader.load(query, { refresh: true })
    const rejected = expect(oldRequest).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    const oldSignal = fetchBundle.mock.calls[1]?.[1].signal as AbortSignal

    loader.setIdentity('tenant-b:session-1')
    expect(oldSignal.aborted).toBe(true)
    expect(oldResult.t('title')).toBe('title')
    const current = await loader.load(query)
    oldResponse.resolve(bundle({ title: 'Late tenant A' }, { version: 'v2' }))
    await rejected
    expect(current.t('title')).toBe('Tenant B')
    expect((await loader.load(query)).messages.title).toBe('Tenant B')
    loader.dispose()
  })

  it('does not reuse resources after session rotation, clear, logout or dispose', async () => {
    const fetchBundle = vi.fn().mockResolvedValue(bundle({ title: 'Orders' }))
    const loader = createPageI18nLoader({ fetchBundle })
    await expect(loader.load(query)).rejects.toMatchObject({ name: 'AbortError' })
    loader.setIdentity('tenant-a:session-1')
    const first = await loader.load(query)
    loader.setIdentity('tenant-a:session-1')
    await loader.load(query)
    expect(fetchBundle).toHaveBeenCalledTimes(1)
    loader.setIdentity('tenant-a:session-2')
    expect(first.t('title')).toBe('title')
    const second = await loader.load(query)
    loader.clear()
    expect(second.t('title')).toBe('title')
    await loader.load(query)
    expect(fetchBundle).toHaveBeenCalledTimes(3)
    loader.setIdentity(null)
    await expect(loader.load(query)).rejects.toMatchObject({ name: 'AbortError' })
    loader.dispose()
    expect(() => loader.setIdentity('tenant-a:session-3')).toThrow('disposed')
    await expect(loader.load(query)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('keeps concurrent locales and different page scopes separate', async () => {
    const english = deferred<PageI18nBundle>()
    const chinese = deferred<PageI18nBundle>()
    const fetchBundle = vi.fn().mockReturnValueOnce(english.promise).mockReturnValueOnce(chinese.promise)
      .mockResolvedValueOnce(bundle({ title: 'Different namespace' }))
      .mockResolvedValueOnce(bundle({ title: 'Different page' }, { pageCode: 'customer.list' }))
    const loader = createPageI18nLoader({ fetchBundle })
    loader.setIdentity('tenant-a:session-1')
    const enRequest = loader.load(query)
    const zhRequest = loader.load({ ...query, locale: 'zh-CN' })
    chinese.resolve(bundle({ title: '订单' }, { locale: 'zh-CN' }))
    const zh = await zhRequest
    english.resolve(bundle({ title: 'Orders' }))
    const en = await enRequest
    const otherNamespace = await loader.load({ ...query, namespaceCode: 'other' })
    const otherPage = await loader.load({ ...query, pageCode: 'customer.list' })
    expect(en.t('title')).toBe('Orders')
    expect(zh.t('title')).toBe('订单')
    expect(otherNamespace.t('title')).toBe('Different namespace')
    expect(otherPage.t('title')).toBe('Different page')
    loader.dispose()
  })

  it('does not overwrite global common resources or another loader', async () => {
    await i18next.init({ lng: 'en-US', resources: { 'en-US': { common: { title: 'Global common' } } } })
    const first = createPageI18nLoader({ fetchBundle: async () => bundle({ title: 'First' }) })
    const second = createPageI18nLoader({ fetchBundle: async () => bundle({ title: 'Second' }) })
    first.setIdentity('tenant-a:session-1')
    second.setIdentity('tenant-b:session-1')
    const [a, b] = await Promise.all([first.load(query), second.load(query)])
    expect(a.t('title')).toBe('First')
    expect(b.t('title')).toBe('Second')
    expect(i18next.t('title', { ns: 'common' })).toBe('Global common')
    first.dispose()
    expect(b.t('title')).toBe('Second')
    second.dispose()
  })

  it('keeps flat dotted keys and renders interpolation and remote markup as React text', async () => {
    const loader = createPageI18nLoader({ fetchBundle: async () => bundle({
      'actions.create': 'Create {{name}}',
      markup: '<img src=x onerror=alert(1)>',
      nesting: '$t(title, {"ns":"common"})',
      language: '{{lng}} / {{ns}}',
    }) })
    loader.setIdentity('tenant-a:session-1')
    const page = await loader.load(query)
    const injected = '<script>alert(1)</script>'
    const { container } = render(<div>
      <span>{page.t('actions.create', { name: injected })}</span>
      <span>{page.t('markup')}</span>
    </div>)
    expect(screen.getByText(`Create ${injected}`)).toBeInTheDocument()
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(container.querySelector('script, img')).toBeNull()
    expect(page.t('nesting')).toBe('$t(title, {"ns":"common"})')
    expect(page.t('language', { lng: 'zh-CN', ns: 'common' })).toBe('zh-CN / common')
    loader.dispose()
  })

  it('normalizes locale tags and rejects mismatched or malformed remote bundles', async () => {
    const fetchBundle = vi.fn().mockResolvedValueOnce(bundle({ title: 'Orders' }))
      .mockResolvedValueOnce(bundle({ title: 'Wrong page' }, { pageCode: 'wrong' }))
      .mockResolvedValueOnce(bundle({ title: 'Wrong locale' }, { locale: 'zh-CN' }))
      .mockResolvedValueOnce(bundle({ title: 12 } as unknown as Record<string, string>))
    const loader = createPageI18nLoader({ fetchBundle, cacheTtlMs: 0 })
    loader.setIdentity('tenant-a:session-1')
    await loader.load({ ...query, locale: 'en-us' })
    expect(fetchBundle.mock.calls[0]?.[0].locale).toBe('en-US')
    loader.clear()
    await expect(loader.load(query)).rejects.toThrow('does not match')
    await expect(loader.load(query)).rejects.toThrow('does not match')
    await expect(loader.load(query)).rejects.toThrow('flat string map')
    await expect(loader.load({ ...query, locale: 'en_US' })).rejects.toThrow()
    await expect(loader.load({ ...query, appCode: '' })).rejects.toThrow('required')
    expect(() => createPageI18nLoader({ fetchBundle, cacheTtlMs: Infinity })).toThrow('finite')
    loader.dispose()
  })
})
