# @stellar-enclosure/stellar-enclosure-web-shared

Stellar Enclosure 平台前端公共层，供四个管理控制台（Tianshu / Yuheng / Tianquan-Shoubing /
Tianquan-Jianshen）以及 `stellar-enclosure-platform-admin-portal` 微前端宿主共享。

## 包含内容

- **Layout**：`EnterpriseLayout` / `EnterpriseHeader` / `EnterpriseFooter` 及完整 TypeScript 类型。平台通过 config 传入平台名、Logo、导航菜单、用户信息与全局操作区，Header 自动按当前路由高亮（最长前缀匹配），窄屏自动切换抽屉导航，Layout 保证最小高度与贴底 Footer。
- **Theme**：`AdminThemeProvider`、`designTokens`、`injectTokens`。
- **API**：`createHttpClient`、`ApiError`、`classifyApiError`。
- **Auth**：`createGatewayAuthClient` 与 `GatewayAuthError`。它只导航到配置的 Edge OIDC
  registration，并读取 `/bff/session`、`/bff/csrf`、`/bff/logout` 和 `bootstrap(path?)`
  授权引导（默认 `/api/v1/auth/bootstrap`）。浏览器只持 Edge 的 `HttpOnly` 会话 Cookie；包内不接收凭据、不读写 AT/RT，
  也没有 `createOAuthClient` / `createTokenStore` / `decodeTokenPayload` 之类的导出。
- **i18n**：`initI18n`、`I18nProvider`、`useT`、`changeLanguage`、`currentLanguage`。
- **Components / Hooks**：`PageHeader`、`PageState`、`PageTemplate`、
  `AppErrorBoundary`、`usePermission`、`useFeatureQuery`。
- **Vite 插件**（`@stellar-enclosure/stellar-enclosure-web-shared/vite-plugin`）：`egonFaviconPlugin()`，统一为四个控制台与 Portal 宿主注入 `stellar-enclosure-platform/favicon.png`（dev/preview 中间件 + index.html 注入 + build 产物输出）。

## 使用

```tsx
import { EnterpriseLayout, type EnterpriseLayoutConfig } from '@stellar-enclosure/stellar-enclosure-web-shared'
import { egonFaviconPlugin } from '@stellar-enclosure/stellar-enclosure-web-shared/vite-plugin'

const config: EnterpriseLayoutConfig = {
  platformName: 'Yuheng Admin',
  navigation: [{ key: 'dashboard', label: '总览', path: '/dashboard' }],
  user: { name: 'admin', menu: [{ key: 'logout', label: '退出登录' }] },
  footer: { version: '5.4.1' },
}
```

## 发布

实际 npm 包为 `@stellar-enclosure/stellar-enclosure-web-shared`，初始版本为 `0.0.1`。
在 `web-sdk` 仓库根目录执行：

```bash
npm ci
npm run release:shared -- --dry-run
npm run release:shared
```

实际发布前需完成 npm 登录并具有 `@stellar-enclosure` 组织发布权限。发布执行包内测试，打包重建 `dist/`，固定使用 npmjs 公共仓库。后续版本单独通过 `npm version patch --workspace @stellar-enclosure/stellar-enclosure-web-shared --no-git-tag-version` 更新。
完整校验、两种独立包的命令和精确 tarball 发布方式见 [仓库发布说明](https://github.com/Stellar-Enclosure/web-sdk#publish-to-npmjs)。
