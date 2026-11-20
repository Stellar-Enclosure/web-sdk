import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { useCallback, type PropsWithChildren } from 'react'
import { designTokens } from './tokens'

export interface AdminThemeProviderProps extends PropsWithChildren {
  readonly getPopupContainer?: (triggerNode?: HTMLElement) => HTMLElement
  readonly overlayContainer?: HTMLElement | null
}

export const AdminThemeProvider = ({
  children,
  getPopupContainer,
  overlayContainer,
}: AdminThemeProviderProps) => {
  const resolvePopupContainer = useCallback(
    (triggerNode?: HTMLElement): HTMLElement => {
      if (getPopupContainer) {
        return getPopupContainer(triggerNode)
      }
      if (overlayContainer) {
        return overlayContainer
      }
      const scopedRoot = triggerNode?.closest?.('[data-workbench-overlay-root="true"]')
      if (scopedRoot instanceof HTMLElement) {
        return scopedRoot
      }
      return document.body
    },
    [getPopupContainer, overlayContainer],
  )

  return (
    <ConfigProvider
      locale={zhCN}
      getPopupContainer={resolvePopupContainer}
      theme={{
        token: {
          colorPrimary: designTokens.color.primary,
          colorText: designTokens.color.text,
          colorTextSecondary: designTokens.color.textSecondary,
          colorBgContainer: designTokens.color.backgroundAlt,
          colorBorder: designTokens.color.border,
          colorError: designTokens.color.error,
          colorWarning: designTokens.color.warning,
          colorSuccess: designTokens.color.success,
          borderRadius: designTokens.radius.md,
          fontFamily: designTokens.font.family,
        },
      }}
    >
      {children}
    </ConfigProvider>
  )
}
