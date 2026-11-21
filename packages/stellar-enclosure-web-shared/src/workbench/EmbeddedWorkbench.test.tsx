import { act, cleanup, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WORKBENCH_PROTOCOL_VERSION,
  bridgeFail,
  bridgeOk,
  validateAppCatalogUpdate,
  type AppCatalogUpdate,
  type AppPageDescriptor,
  type BridgeResult,
  type LeaveCheck,
  type Presentation,
  type RouteRequest,
  type WorkbenchHost,
  type WorkbenchPort,
} from './contracts'
import { EmbeddedWorkbench, useEmbeddedWorkbench, useWorkbenchLeaveGuard } from './EmbeddedWorkbench'

const pagesFixture: readonly AppPageDescriptor[] = [
  {
    pageId: 'tianshu.page.publishTasks',
    pattern: '/publish-tasks',
    label: '发布任务',
    groupKey: 'runtime',
    groupLabel: '运行与发布',
    identityParams: [],
    queryKeys: ['changeId'],
  },
  {
    pageId: 'tianshu.page.aiEditor',
    pattern: '/ai/resources/:id',
    label: 'AI 资源编辑',
    identityParams: ['id'],
    queryKeys: [],
  },
]

function createHostSpy() {
  let attachedPort: WorkbenchPort | undefined
  const attachCalls: WorkbenchPort[] = []
  const catalogUpdates: AppCatalogUpdate[] = []
  const navRequests: RouteRequest[] = []

  const host: WorkbenchHost = {
    attach: vi.fn((port: WorkbenchPort): BridgeResult => {
      attachCalls.push(port)
      if (port.version !== WORKBENCH_PROTOCOL_VERSION) {
        return { ok: false, code: 'VERSION_MISMATCH' }
      }
      if (attachedPort && attachedPort !== port) {
        return { ok: false, code: 'INVALID_INPUT' }
      }
      attachedPort = port
      return { ok: true }
    }),
    reportCatalog: vi.fn((update: AppCatalogUpdate): BridgeResult => {
      catalogUpdates.push(update)
      return { ok: true }
    }),
    requestNavigation: vi.fn((request: RouteRequest): BridgeResult => {
      navRequests.push(request)
      return { ok: true }
    }),
  }

  return {
    host,
    getPort: () => attachedPort,
    attachCalls,
    catalogUpdates,
    navRequests,
  }
}

function ProbeChild({
  tabKey,
  dirty = false,
  pendingMutation = false,
  onNavReady,
}: {
  readonly tabKey: string
  readonly dirty?: boolean
  readonly pendingMutation?: boolean
  readonly onNavReady?: (requestNav: (path: string, search?: string) => BridgeResult) => void
}) {
  const ctx = useEmbeddedWorkbench()
  useWorkbenchLeaveGuard(tabKey, { dirty, pendingMutation })
  useEffect(() => {
    if (onNavReady) {
      onNavReady((path, search = '') => ctx.requestNavigation('push', { path, search }))
    }
  }, [ctx, onNavReady])
  return (
    <div data-testid="probe">
      <span>{ctx.embedded ? 'embedded' : 'standalone'}</span>
      <span>{ctx.active ? 'active' : 'suspended'}</span>
      <span>{ctx.activeTabKey ?? 'none'}</span>
    </div>
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('EmbeddedWorkbench protocol and instance lifecycle', () => {
  it('renders children directly in standalone mode without initiating port handshake', () => {
    render(
      <EmbeddedWorkbench status="ready" pages={pagesFixture}>
        <ProbeChild tabKey="tianshu:publishTasks" />
      </EmbeddedWorkbench>,
    )

    expect(screen.getByText('standalone')).toBeInTheDocument()
    expect(screen.getByText('active')).toBeInTheDocument()
  })

  it('isolates two mounted instances with independent hosts, catalogs, and presentation sequences', async () => {
    const spyA = createHostSpy()
    const spyB = createHostSpy()
    const onPresentA = vi.fn(async (): Promise<BridgeResult> => ({ ok: true }))
    const onPresentB = vi.fn(async (): Promise<BridgeResult> => ({ ok: true }))

    const mountedA = render(
      <EmbeddedWorkbench host={spyA.host} status="ready" pages={pagesFixture} onPresent={onPresentA}>
        <ProbeChild tabKey="tianshu:publishTasks" />
      </EmbeddedWorkbench>,
    )
    const mountedB = render(
      <EmbeddedWorkbench host={spyB.host} status="authorizing" pages={pagesFixture} onPresent={onPresentB}>
        <ProbeChild tabKey="yuheng:dashboard" />
      </EmbeddedWorkbench>,
    )

    expect(spyA.attachCalls).toHaveLength(1)
    expect(spyB.attachCalls).toHaveLength(1)
    expect(spyA.getPort()).not.toBe(spyB.getPort())

    expect(spyA.catalogUpdates.at(-1)).toMatchObject({
      catalogRevision: 1,
      status: 'ready',
      pages: pagesFixture,
    })
    // Non-ready status must emit an empty page list per Spec §9.2.2
    expect(spyB.catalogUpdates.at(-1)).toMatchObject({
      catalogRevision: 1,
      status: 'authorizing',
      pages: [],
    })

    const controller = new AbortController()
    const showRes = await spyA.getPort()!.present({
      mode: 'show',
      navigationId: 1,
      target: { path: '/publish-tasks', search: '?changeId=chg-1' },
      tabKey: 'tianshu:publishTasks',
      signal: controller.signal,
    })
    expect(showRes).toEqual({ ok: true })
    expect(onPresentA).toHaveBeenCalledTimes(1)
    expect(onPresentB).not.toHaveBeenCalled()

    // Duplicate/replayed navigationId is idempotent and does not re-invoke onPresent
    const replayRes = await spyA.getPort()!.present({
      mode: 'show',
      navigationId: 1,
      target: { path: '/publish-tasks', search: '?changeId=chg-1' },
      tabKey: 'tianshu:publishTasks',
      signal: controller.signal,
    })
    expect(replayRes).toEqual({ ok: true })
    expect(onPresentA).toHaveBeenCalledTimes(1)

    // Lower navigationId is rejected as SUPERSEDED
    const staleNavRes = await spyA.getPort()!.present({
      mode: 'suspend',
      navigationId: 0,
      signal: controller.signal,
    })
    expect(staleNavRes).toEqual({ ok: false, code: 'INVALID_INPUT' })

    const newerShow = await spyA.getPort()!.present({
      mode: 'show',
      navigationId: 3,
      target: { path: '/ai/resources/42', search: '' },
      tabKey: 'tianshu:aiEditor:42',
      signal: controller.signal,
    })
    expect(newerShow).toEqual({ ok: true })

    const olderNav = await spyA.getPort()!.present({
      mode: 'suspend',
      navigationId: 2,
      signal: controller.signal,
    })
    expect(olderNav).toEqual({ ok: false, code: 'SUPERSEDED' })

    mountedA.unmount()
    mountedB.unmount()
  })

  it('rejects all calls after unmount (STALE_INSTANCE) and aborts pending read work', async () => {
    const spy = createHostSpy()
    let capturedSignal: AbortSignal | undefined
    const onPresent = vi.fn(
      (presentation: Presentation) =>
        new Promise<BridgeResult>((resolve) => {
          capturedSignal = presentation.signal
          presentation.signal.addEventListener('abort', () => resolve({ ok: false, code: 'SUPERSEDED' }), { once: true })
        }),
    )

    const { unmount } = render(
      <EmbeddedWorkbench host={spy.host} status="ready" pages={pagesFixture} onPresent={onPresent}>
        <ProbeChild tabKey="tianshu:publishTasks" />
      </EmbeddedWorkbench>,
    )

    const port = spy.getPort()!
    const controller = new AbortController()
    const pending = port.present({
      mode: 'show',
      navigationId: 1,
      target: { path: '/publish-tasks', search: '' },
      tabKey: 'tianshu:publishTasks',
      signal: controller.signal,
    })

    expect(capturedSignal?.aborted).toBe(false)
    unmount()

    expect(capturedSignal?.aborted).toBe(true)
    await expect(pending).resolves.toEqual({ ok: false, code: 'STALE_INSTANCE' })
    expect(port.checkLeave({ reason: 'logout' })).toEqual({ ok: false, code: 'STALE_INSTANCE' })
    await expect(
      port.present({
        mode: 'suspend',
        navigationId: 2,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ ok: false, code: 'STALE_INSTANCE' })
  })

  it('tracks dirty state, guardRevision changes on close, and rejects invalid navigation targets', async () => {
    const spy = createHostSpy()
    let requestNavFn: ((path: string, search?: string) => BridgeResult) | undefined

    const { rerender } = render(
      <EmbeddedWorkbench host={spy.host} status="ready" pages={pagesFixture}>
        <ProbeChild
          tabKey="tianshu:aiEditor:42"
          dirty={false}
          onNavReady={(fn) => {
            requestNavFn = fn
          }}
        />
      </EmbeddedWorkbench>,
    )

    const port = spy.getPort()!
    const initialLeave = port.checkLeave({ reason: 'close', tabKey: 'tianshu:aiEditor:42' } satisfies LeaveCheck)
    expect(initialLeave).toEqual({
      ok: true,
      dirty: false,
      pendingMutation: false,
      guardRevision: 0,
    })

    // Dirty state mutates -> guardRevision bumps
    rerender(
      <EmbeddedWorkbench host={spy.host} status="ready" pages={pagesFixture}>
        <ProbeChild
          tabKey="tianshu:aiEditor:42"
          dirty={true}
          pendingMutation={true}
          onNavReady={(fn) => {
            requestNavFn = fn
          }}
        />
      </EmbeddedWorkbench>,
    )

    const updatedLeave = port.checkLeave({ reason: 'close', tabKey: 'tianshu:aiEditor:42' })
    expect(updatedLeave).toMatchObject({
      ok: true,
      dirty: true,
      pendingMutation: true,
    })
    const currentRevision = updatedLeave.ok ? updatedLeave.guardRevision : -1
    expect(currentRevision).toBeGreaterThan(0)

    // Closing with stale guardRevision returns LEAVE_STATE_CHANGED
    const staleClose = await port.present({
      mode: 'close',
      navigationId: 1,
      tabKey: 'tianshu:aiEditor:42',
      guardRevision: 0,
      signal: new AbortController().signal,
    })
    expect(staleClose).toEqual({ ok: false, code: 'LEAVE_STATE_CHANGED' })

    // Invalid targets must be rejected locally before calling host.requestNavigation
    expect(requestNavFn?.('https://evil.example/phish')).toEqual({ ok: false, code: 'INVALID_INPUT' })
    expect(requestNavFn?.('//evil.example/path')).toEqual({ ok: false, code: 'INVALID_INPUT' })
    expect(requestNavFn?.('/ai/../secret')).toEqual({ ok: false, code: 'INVALID_INPUT' })
    expect(requestNavFn?.('/publish-tasks', '?q=%252e%252e')).toEqual({ ok: false, code: 'INVALID_INPUT' })
    expect(spy.navRequests).toHaveLength(0)

    // Valid target increments requestId monotonically
    act(() => {
      expect(requestNavFn?.('/publish-tasks', '?changeId=chg-9')).toEqual({ ok: true })
    })
    expect(spy.navRequests).toEqual([
      {
        requestId: 1,
        mode: 'push',
        target: { path: '/publish-tasks', search: '?changeId=chg-9' },
      },
    ])

    // Unknown tabKey checkLeave returns NOT_FOUND
    expect(port.checkLeave({ reason: 'close', tabKey: 'tianshu:missing' })).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    })
  })

  it('updates active/suspended state on show/suspend/close and validates catalog invariants', async () => {
    const spy = createHostSpy()

    render(
      <EmbeddedWorkbench host={spy.host} status="ready" pages={pagesFixture}>
        <ProbeChild tabKey="tianshu:publishTasks" />
      </EmbeddedWorkbench>,
    )

    expect(screen.getByText('suspended')).toBeInTheDocument()
    const port = spy.getPort()!

    await act(async () => {
      await port.present({
        mode: 'show',
        navigationId: 1,
        target: { path: '/publish-tasks', search: '' },
        tabKey: 'tianshu:publishTasks',
        signal: new AbortController().signal,
      })
    })
    expect(screen.getByText('active')).toBeInTheDocument()
    expect(screen.getByText('tianshu:publishTasks')).toBeInTheDocument()

    await act(async () => {
      await port.present({
        mode: 'suspend',
        navigationId: 2,
        signal: new AbortController().signal,
      })
    })
    expect(screen.getByText('suspended')).toBeInTheDocument()

    await act(async () => {
      const leave = port.checkLeave({ reason: 'close', tabKey: 'tianshu:publishTasks' })
      expect(leave.ok).toBe(true)
      const rev = leave.ok ? leave.guardRevision : 0
      await port.present({
        mode: 'close',
        navigationId: 3,
        tabKey: 'tianshu:publishTasks',
        guardRevision: rev,
        signal: new AbortController().signal,
      })
    })
    expect(screen.getByText('none')).toBeInTheDocument()

    // Catalog invariants per Spec §9.2.2
    expect(validateAppCatalogUpdate({ catalogRevision: 1, status: 'authorizing', pages: pagesFixture })).toBe(false)
    expect(validateAppCatalogUpdate({ catalogRevision: 1, status: 'ready', pages: [pagesFixture[0], pagesFixture[0]] })).toBe(false)
    expect(validateAppCatalogUpdate({ catalogRevision: 1, status: 'ready', pages: pagesFixture })).toBe(true)
  })

  it('does not deduplicate a subsequent present after onPresent fails', async () => {
    const spy = createHostSpy()
    let allowShow = false
    const onPresent = vi.fn(async () => (allowShow ? bridgeOk() : bridgeFail('DENIED')))

    render(
      <EmbeddedWorkbench host={spy.host} status="authorizing" pages={[]} onPresent={onPresent}>
        <ProbeChild tabKey="tianshu:publishTasks" />
      </EmbeddedWorkbench>,
    )

    const port = spy.getPort()!
    const first = await port.present({
      mode: 'show',
      navigationId: 1,
      target: { path: '/publish-tasks', search: '' },
      tabKey: '["tianshu","tianshu.page.publishTasks"]',
      signal: new AbortController().signal,
    })
    expect(first).toEqual({ ok: false, code: 'DENIED' })

    allowShow = true
    const retry = await port.present({
      mode: 'show',
      navigationId: 2,
      target: { path: '/publish-tasks', search: '' },
      tabKey: '["tianshu","tianshu.page.publishTasks"]',
      signal: new AbortController().signal,
    })
    expect(retry).toEqual({ ok: true })
    expect(onPresent).toHaveBeenCalledTimes(2)
  })
})
