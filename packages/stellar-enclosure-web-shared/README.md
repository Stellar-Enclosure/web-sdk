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
- **i18n**：`initI18n`、`I18nProvider`、`useT`、`changeLanguage`、`currentLanguage`，以及读取 Tianshu 已发布页面语言包的 `createPageI18nLoader`。
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

## Tianshu 页面语言包

`createPageI18nLoader` 接收应用已有的认证客户端适配函数，不接收 Token，不直接请求匿名接口。
适配函数调用 `GET /api/v1/tianshu/i18n/bundle`，将 `PageI18nQuery` 的六个字段作为查询参数，
透传 `AbortSignal`，并使用应用已有的逻辑解包 `ResultRecord`，返回 `PageI18nBundle`。
服务端从认证上下文获取企业身份，客户端查询参数不包含 `tenantId`。

下面的初始化函数可放在应用的会话管理层；在同一身份生命周期内复用返回的 loader，避免在组件每次 render 时创建或请求：

```ts
import {
  createPageI18nLoader,
  type PageI18nLoader,
  type PageI18nLoaderOptions,
} from '@stellar-enclosure/stellar-enclosure-web-shared'

export const createSessionPageTexts = (
  fetchBundle: PageI18nLoaderOptions['fetchBundle'],
  trustedTenantSessionKey: string,
): PageI18nLoader => {
  const loader = createPageI18nLoader({ fetchBundle, cacheTtlMs: 60_000 })
  loader.setIdentity(trustedTenantSessionKey)
  return loader
}

export const loadOrderTexts = (loader: PageI18nLoader, locale: string, refresh = false) => loader.load({
  bizCode: 'retail',
  namespaceCode: 'main',
  env: 'prod',
  appCode: 'shop',
  pageCode: 'order.list',
  locale,
}, {
  refresh,
  fallbackMessages: { title: '订单列表', 'actions.create': '新建订单' },
})
```

在页面的 scope、语言或认证身份变化时调用 `loadOrderTexts`，保存返回结果，通过
`page.t('title')`、`page.t('actions.create')` 渲染。插值使用 `page.t('greeting', { name: userName })`。
`t` 固定当前 scope、页面和语言；插值参数不能修改语言或 namespace。点号是 key 的一部分，
例如 `actions.create` 不要求 JSON 嵌套。返回值同时提供 `messages`、`version`、`defaultLocale`，方便显示版本和预览。

- **发布与回退**：服务端返回合并后的有效文案：公共默认语言 → 公共目标语言 → 页面默认语言 → 页面目标语言。
  SDK 不重复合并，也不会修改现有 `initI18n` / `useT` 使用的全局 `common`。默认语言由页面配置，接口 locale 使用规范 BCP 47 格式；SDK 会将 `en-us` 规范成 `en-US`。
- **缓存与更新**：默认缓存 60 秒，同一查询的普通并发请求会合并，语言与完整页面作用域各自缓存。
  `load(query, { refresh: true })` 绕过 TTL，并取消、替换同一查询中尚未完成的旧请求，防止发布前的迟到响应覆盖新文案。
  版本是包含公共包变更的 opaque 字符串，不做大小比较。
  版本变化时整包替换，已删除 key 不会残留。没有后台轮询或持久化存储。
- **失败行为**：请求失败时优先保留同身份、作用域、页面和语言的最近成功资源，`source` 为 `stale`；
  没有成功资源时使用本次传入的 `fallbackMessages`，`source` 为 `fallback`、`version` 为 `null`。
  两种情况都会返回 `error` 供应用显示状态。没有资源也没有本地回退时 Promise 拒绝；身份变化导致的取消始终以 `AbortError` 拒绝。
- **身份生命周期**：身份 key 必须来自可信的企业和会话状态，例如 `tenantId:sessionGeneration`，不能使用 Token 或页面输入。
  企业切换、同企业重新登录时调用 `setIdentity(newKey)`，退出时调用 `setIdentity(null)`；调用会清缓存及资源、取消请求，迟到响应无法重新写入。
  旧结果的 `t` 在身份失效后只返回 key。`messages` 是已返回的只读快照，页面展示原始 JSON 时仍须校验结果身份与当前身份一致，
  并忽略旧 effect 的异步结果。`clear()` 清资源并允许当前身份重新加载；会话拥有者最终卸载时调用 `dispose()`，销毁后不可复用。
- **文本渲染**：将 `t` 结果放入 React 文本节点，例如 `<h1>{page.t('title')}</h1>`。
  文案和插值返回普通字符串，不解析 HTML，不使用 `dangerouslySetInnerHTML` 或将文案作为 HTML 模板。
  React 负责文本转义；SDK 禁用 i18next 的翻译嵌套，远程内容不能借嵌套读取其他页面 namespace。

`EnterpriseLayoutConfig.labels` 可注入当前企业语言包提供的 `mainMenu`、`userMenu`、`openNavigation` 和
`version` 文案，导航项本身仍由宿主提供已翻译的 label。未提供时沿用共享组件原有默认文案，
不会修改其他应用的全局语言。Tianshu 通过此入口接入中心，同时在自己的 ConfigProvider 中设置组件 locale。

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
