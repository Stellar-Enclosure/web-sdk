export const designTokens = {
  color: {
    primary: '#315ACB',
    primaryHover: '#2447B8',
    text: '#18253C',
    textSecondary: '#64748B',
    background: '#F3F6FB',
    backgroundAlt: '#FFFFFF',
    border: '#E3E8F1',
    error: '#DC2626',
    warning: '#F59E0B',
    success: '#16A34A',
  },
  layout: {
    brandBarHeight: 60,
    tabBarHeight: 47,
    sidebarWidth: 233,
    sidebarCollapsedWidth: 54,
    mobileRailWidth: 44,
    mobileBreakpoint: 760,
  },
  radius: { sm: 4, md: 8, lg: 12 },
  spacing: { xs: 8, sm: 12, md: 16, lg: 24, xl: 32 },
  font: {
    family: 'Inter, "PingFang SC", "Microsoft YaHei", ui-sans-serif, system-ui, -apple-system, sans-serif',
  },
} as const

export type DesignTokens = typeof designTokens

const CSS_VAR_PREFIX = '--egon-'
const BASE_STYLE_ATTR = 'data-egon-tokens'

export const injectTokens = (targetDocument: Document = document): void => {
  const root = targetDocument.documentElement
  root.style.setProperty(`${CSS_VAR_PREFIX}color-primary`, designTokens.color.primary)
  root.style.setProperty(`${CSS_VAR_PREFIX}color-primary-hover`, designTokens.color.primaryHover)
  root.style.setProperty(`${CSS_VAR_PREFIX}color-text`, designTokens.color.text)
  root.style.setProperty(`${CSS_VAR_PREFIX}color-text-secondary`, designTokens.color.textSecondary)
  root.style.setProperty(`${CSS_VAR_PREFIX}color-background`, designTokens.color.background)
  root.style.setProperty(`${CSS_VAR_PREFIX}color-background-alt`, designTokens.color.backgroundAlt)
  root.style.setProperty(`${CSS_VAR_PREFIX}color-border`, designTokens.color.border)
  root.style.setProperty(`${CSS_VAR_PREFIX}color-error`, designTokens.color.error)
  root.style.setProperty(`${CSS_VAR_PREFIX}color-warning`, designTokens.color.warning)
  root.style.setProperty(`${CSS_VAR_PREFIX}color-success`, designTokens.color.success)
  root.style.setProperty(`${CSS_VAR_PREFIX}brand-bar-height`, `${designTokens.layout.brandBarHeight}px`)
  root.style.setProperty(`${CSS_VAR_PREFIX}tab-bar-height`, `${designTokens.layout.tabBarHeight}px`)
  root.style.setProperty(`${CSS_VAR_PREFIX}sidebar-width`, `${designTokens.layout.sidebarWidth}px`)
  root.style.setProperty(`${CSS_VAR_PREFIX}sidebar-collapsed-width`, `${designTokens.layout.sidebarCollapsedWidth}px`)
  root.style.setProperty(`${CSS_VAR_PREFIX}mobile-rail-width`, `${designTokens.layout.mobileRailWidth}px`)
  root.style.setProperty(`${CSS_VAR_PREFIX}font-family`, designTokens.font.family)
  root.style.fontFamily = designTokens.font.family
  root.style.color = designTokens.color.text
  root.style.background = designTokens.color.background

  if (!targetDocument.head.querySelector(`style[${BASE_STYLE_ATTR}="true"]`)) {
    const style = targetDocument.createElement('style')
    style.setAttribute(BASE_STYLE_ATTR, 'true')
    style.textContent = `
      body { margin: 0; min-height: 100vh; background: ${designTokens.color.background}; color: ${designTokens.color.text}; }
    `
    targetDocument.head.appendChild(style)
  }
}
