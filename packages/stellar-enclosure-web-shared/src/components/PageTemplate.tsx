import { Card } from 'antd'
import type { ReactNode } from 'react'
import { PageHeader } from './PageHeader'
import { PageState, type PageStateProps } from './PageState'

export interface BreadcrumbItem {
  readonly title: string
  readonly path?: string
}

export interface PageTemplateProps {
  readonly title: string
  readonly subtitle?: string
  readonly breadcrumbs?: readonly BreadcrumbItem[]
  readonly extra?: ReactNode
  readonly mode?: 'default' | 'content'
  readonly hideHeader?: boolean
  readonly pageState: Omit<PageStateProps, 'children'>
  readonly children: ReactNode
}

export const PageTemplate = ({
  title,
  subtitle,
  breadcrumbs,
  extra,
  mode = 'default',
  hideHeader = false,
  pageState,
  children,
}: PageTemplateProps) => {
  const omitHeader = hideHeader || mode === 'content'
  return (
    <section aria-label={title} data-page-mode={mode}>
      {!omitHeader && (
        <PageHeader title={title} subtitle={subtitle} breadcrumbs={breadcrumbs} extra={extra} />
      )}
      <Card>
        <PageState {...pageState}>{children}</PageState>
      </Card>
    </section>
  )
}
