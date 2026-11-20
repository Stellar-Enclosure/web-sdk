import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Select } from 'antd'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../i18n'
import { AdminThemeProvider } from '../theme/ThemeProvider'
import { designTokens } from '../theme/tokens'
import { PageTemplate } from './PageTemplate'
import { WorkspaceList, validatePureDateRange } from './WorkspaceList'

beforeAll(async () => {
  await initI18n({ lng: 'zh-CN', resources: { 'zh-CN': {} } })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('WorkspaceList four-region layout and pagination variants', () => {
  it('renders query, toolbar, scrollable table, and page-mode pagination in order without leaking bulk controls', () => {
    const onPageChange = vi.fn()
    const { container } = render(
      <AdminThemeProvider>
        <WorkspaceList
          ariaLabel="发布任务列表"
          filters={<form aria-label="筛选条件"><button type="submit">查询</button></form>}
          table={<div data-testid="table-body">任务行-1</div>}
          pageState={{ loading: false, error: null, empty: false }}
          pagination={{
            mode: 'page',
            current: 2,
            pageSize: 20,
            total: 45,
            onChange: onPageChange,
          }}
        />
      </AdminThemeProvider>,
    )

    const regions = Array.from(container.querySelectorAll('[data-region]')).map((el) =>
      el.getAttribute('data-region'),
    )
    expect(regions).toEqual(['query', 'table', 'pagination'])
    expect(container.querySelector('[data-region="toolbar"]')).toBeNull()
    expect(screen.getByText('任务行-1')).toBeInTheDocument()

    const tableRegion = container.querySelector('[data-region="table"]') as HTMLElement
    expect(tableRegion.style.overflowX).toBe('auto')
    expect(tableRegion.style.overflowY).toBe('auto')

    fireEvent.click(screen.getByTitle('1'))
    expect(onPageChange).toHaveBeenCalledWith(1, 20)
  })

  it('renders cursor pagination without fabricating a total row count', () => {
    const onNext = vi.fn()
    const onFirst = vi.fn()
    const { container } = render(
      <WorkspaceList
        ariaLabel="审计日志列表"
        filters={<div>过滤表单</div>}
        toolbar={<button type="button">导出</button>}
        table={<div>审计行</div>}
        pageState={{ loading: false, error: null, empty: false }}
        pagination={{
          mode: 'cursor',
          hasMore: true,
          onNext,
          onFirst,
        }}
      />,
    )

    const regions = Array.from(container.querySelectorAll('[data-region]')).map((el) =>
      el.getAttribute('data-region'),
    )
    expect(regions).toEqual(['query', 'toolbar', 'table', 'pagination'])
    expect(screen.queryByText(/共\s*\d+\s*条/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(onNext).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '返回首批' }))
    expect(onFirst).toHaveBeenCalledTimes(1)
  })

  it('preserves filters and prior results on partial error while exposing retry', () => {
    const onRetry = vi.fn()
    render(
      <WorkspaceList
        ariaLabel="配置列表"
        filters={<input aria-label="关键字" defaultValue="alpha" />}
        table={<div>已有旧数据</div>}
        pageState={{
          loading: false,
          error: new Error('network timeout'),
          empty: false,
          showPartial: true,
          onRetry,
        }}
      />,
    )

    expect(screen.getByDisplayValue('alpha')).toBeInTheDocument()
    expect(screen.getByText('已有旧数据')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('supports PageTemplate content mode without duplicate header and scopes overlays to sandbox root', () => {
    const { container } = render(
      <div data-workbench-overlay-root="true" data-testid="sandbox-root">
        <AdminThemeProvider>
          <PageTemplate
            title="发布任务"
            mode="content"
            pageState={{ loading: false, error: null, empty: false }}
          >
            <Select
              aria-label="状态筛选"
              open
              options={[{ value: 'OPEN', label: '进行中' }]}
            />
          </PageTemplate>
        </AdminThemeProvider>
      </div>,
    )

    expect(screen.getByRole('region', { name: '发布任务' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '发布任务' })).not.toBeInTheDocument()
    const sandboxRoot = container.querySelector('[data-testid="sandbox-root"]')!
    expect(sandboxRoot.querySelector('.ant-select-dropdown')).not.toBeNull()
  })

  it('validates pure ISO calendar date ranges without timezone shifts (TIME-002) and exposes V1.0 tokens', () => {
    expect(designTokens.color.primary).toBe('#315ACB')
    expect(designTokens.color.text).toBe('#18253C')
    expect(designTokens.color.background).toBe('#F3F6FB')
    expect(designTokens.color.border).toBe('#E3E8F1')

    expect(validatePureDateRange('2026-11-01', undefined)).toEqual({
      valid: true,
      dateFrom: '2026-11-01',
      dateTo: undefined,
    })
    expect(validatePureDateRange('2026-11-10', '2026-11-10')).toEqual({
      valid: true,
      dateFrom: '2026-11-10',
      dateTo: '2026-11-10',
    })
    expect(validatePureDateRange('2026-11-15', '2026-11-10')).toEqual({
      valid: false,
      reason: 'RANGE_REVERSED',
    })
    expect(validatePureDateRange('2026-02-30', '2026-03-01')).toEqual({
      valid: false,
      reason: 'INVALID_FORMAT',
    })
  })
})
