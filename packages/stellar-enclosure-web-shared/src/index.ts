// Theme
export { designTokens, injectTokens, type DesignTokens } from './theme/tokens'
export { AdminThemeProvider } from './theme/ThemeProvider'

// API
export { createHttpClient, type HttpClient, type HttpClientConfig } from './api/httpClient'
export { ApiError, classifyApiError, type ErrorClassification } from './api/errors'

// Auth
export {
    createGatewayAuthClient,
    GatewayAuthError,
    type GatewayAuthClient,
    type GatewayAuthErrorCode,
    type GatewayAuthClientOptions,
    type GatewayCsrfResult,
    type GatewayLogoutRemoteState,
    type GatewayLogoutResult,
    type GatewayIdentityResult,
    type GatewayRefreshResult,
} from './auth/gatewayAuthClient'
export { AuthRequestContext, type AuthRequestSnapshot } from './auth/authRequestContext'

// i18n
export { initI18n, I18nProvider, useT, changeLanguage, currentLanguage, type I18nInitOptions } from './i18n'
export {
  createPageI18nLoader,
  type PageI18nQuery,
  type PageI18nBundle,
  type PageI18nValues,
  type PageI18nResult,
  type PageI18nLoaderOptions,
  type PageI18nIdentity,
  type PageI18nLoadOptions,
  type PageI18nLoader,
} from './i18n/pageI18n'

// Components
export { PageHeader, type PageHeaderProps } from './components/PageHeader'
export { PageState, type PageStateProps } from './components/PageState'
export { AppErrorBoundary, type AppErrorBoundaryProps } from './components/AppErrorBoundary'
export { PageTemplate, type PageTemplateProps, type BreadcrumbItem } from './components/PageTemplate'

// Layout
export { EnterpriseHeader, type EnterpriseHeaderProps } from './layout/EnterpriseHeader'
export { EnterpriseFooter, type EnterpriseFooterProps } from './layout/EnterpriseFooter'
export { EnterpriseLayout, type EnterpriseLayoutProps } from './layout/EnterpriseLayout'
export type {
  EnterpriseNavigationItem,
  EnterpriseUser,
  EnterpriseHeaderConfig,
  EnterpriseFooterConfig,
  EnterpriseLayoutConfig,
  EnterpriseLayoutLabels,
} from './layout/types'

// Hooks
export { usePermission } from './hooks/usePermission'
export { useFeatureQuery, type FeatureQueryDeps } from './hooks/useFeatureQuery'

// Permission declarations and pure evaluation (also available without React at /permissions).
export * from './permissions'

export { usePermissionSnapshot } from './permissions/usePermissionSnapshot'
export { PermissionGate, type PermissionGateProps } from './components/PermissionGate'
