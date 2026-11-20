import { Button, Card, Pagination, Space } from 'antd'
import type { ReactNode } from 'react'
import { PageState, type PageStateProps } from './PageState'

export type WorkspaceListPagination =
  | {
      readonly mode: 'page'
      readonly current: number
      readonly pageSize: number
      readonly total: number
      readonly onChange: (page: number, pageSize: number) => void
      readonly showSizeChanger?: boolean
      readonly pageSizeOptions?: readonly number[]
    }
  | {
      readonly mode: 'cursor'
      readonly hasMore: boolean
      readonly hasPrevious?: boolean
      readonly loadingMore?: boolean
      readonly pageSize?: number
      readonly onNext: () => void
      readonly onPrevious?: () => void
      readonly onFirst?: () => void
    }

export interface WorkspaceListProps {
  readonly ariaLabel?: string
  readonly filters?: ReactNode
  readonly toolbar?: ReactNode
  readonly table: ReactNode
  readonly pageState: Omit<PageStateProps, 'children'>
  readonly pagination?: WorkspaceListPagination
  readonly footer?: ReactNode
}

export type PureDateValidationResult =
  | { readonly valid: true; readonly dateFrom?: string; readonly dateTo?: string }
  | { readonly valid: false; readonly reason: 'INVALID_FORMAT' | 'RANGE_REVERSED' }

const PURE_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

const isValidPureCalendarDate = (value: string): boolean => {
  const match = PURE_DATE_PATTERN.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const utc = new Date(Date.UTC(year, month - 1, day))
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  )
}

export function validatePureDateRange(dateFrom?: string, dateTo?: string): PureDateValidationResult {
  const normalizedFrom = dateFrom?.trim() || undefined
  const normalizedTo = dateTo?.trim() || undefined
  if (normalizedFrom !== undefined && !isValidPureCalendarDate(normalizedFrom)) {
    return { valid: false, reason: 'INVALID_FORMAT' }
  }
  if (normalizedTo !== undefined && !isValidPureCalendarDate(normalizedTo)) {
    return { valid: false, reason: 'INVALID_FORMAT' }
  }
  if (normalizedFrom !== undefined && normalizedTo !== undefined && normalizedFrom > normalizedTo) {
    return { valid: false, reason: 'RANGE_REVERSED' }
  }
  return { valid: true, dateFrom: normalizedFrom, dateTo: normalizedTo }
}

export function WorkspaceList({
  ariaLabel,
  filters,
  toolbar,
  table,
  pageState,
  pagination,
  footer,
}: WorkspaceListProps) {
  return (
    <section
      aria-label={ariaLabel}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        minWidth: 0,
        minHeight: 0,
        height: '100%',
      }}
    >
      {filters !== undefined && filters !== null && (
        <div data-region="query">
          <Card size="small">{filters}</Card>
        </div>
      )}

      {toolbar !== undefined && toolbar !== null && toolbar !== false && (
        <div
          data-region="toolbar"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          {toolbar}
        </div>
      )}

      <div
        data-region="table"
        style={{
          flex: '1 1 auto',
          minWidth: 0,
          minHeight: 0,
          overflowX: 'auto',
          overflowY: 'auto',
        }}
      >
        <Card size="small" styles={{ body: { padding: 12 } }}>
          <PageState {...pageState}>{table}</PageState>
        </Card>
      </div>

      {(pagination !== undefined || footer !== undefined) && (
        <div
          data-region="pagination"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <div>{footer}</div>
          {pagination?.mode === 'page' && (
            <Pagination
              current={pagination.current}
              pageSize={pagination.pageSize}
              total={pagination.total}
              onChange={pagination.onChange}
              showSizeChanger={pagination.showSizeChanger ?? false}
              pageSizeOptions={pagination.pageSizeOptions ? [...pagination.pageSizeOptions] : undefined}
              size="small"
            />
          )}
          {pagination?.mode === 'cursor' && (
            <Space size="small">
              {pagination.onFirst && (
                <Button size="small" onClick={pagination.onFirst} disabled={pagination.loadingMore}>
                  返回首批
                </Button>
              )}
              {pagination.onPrevious && (
                <Button
                  size="small"
                  onClick={pagination.onPrevious}
                  disabled={!pagination.hasPrevious || pagination.loadingMore}
                >
                  上一页
                </Button>
              )}
              <Button
                size="small"
                type="primary"
                onClick={pagination.onNext}
                disabled={!pagination.hasMore}
                loading={pagination.loadingMore}
              >
                下一页
              </Button>
            </Space>
          )}
        </div>
      )}
    </section>
  )
}
