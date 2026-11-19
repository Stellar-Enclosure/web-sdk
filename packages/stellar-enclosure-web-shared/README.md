# @stellar-enclosure/stellar-enclosure-web-shared

Stellar Enclosure 平台前端公共层，供四个管理控制台（Tianshu / Yuheng / Tianquan-Shoubing /
Tianquan-Jianshen）以及 `stellar-enclosure-platform-admin-portal` 微前端宿主共享。

## 包含内容

- **Layout**：`EnterpriseLayout` / `EnterpriseHeader` / `EnterpriseFooter` 及完整 TypeScript 类型。平台通过 config 传入平台名、Logo、导航菜单、用户信息与全局操作区，Header 自动按当前路由高亮（最长前缀匹配），窄屏自动切换抽屉导航，Layout 保证最小高度与贴底 Footer。
- **Theme**：`AdminThemeProvider`、`designTokens`、`injectTokens`。
- **API**：`createHttpClient`、`ApiError`、`classifyApiError`。对于约定成功时返回空 HTTP 200 的接口，可调用 `client.request(path, init, {allowEmptyResponse: true})`；非法 JSON 和失败状态仍报错，默认仍要求 JSON 或 HTTP 204。
- **Auth** 使用 `createPublicOAuthClient`、`AuthRequestContext` 与 `PublicOAuthError`。每个 Resource 绑定租户 issuer、PUBLIC client、精确回调与 API 地址。授权码通过 S256 PKCE 交换，业务令牌留在当前页面内存。
- **Permissions**：独立 `/permissions` 入口提供类型化静态声明、`ResourceKey<T>` 与不依赖 React 的 `evaluateRequirement`。AST 导出和固定合同制品准备见 [离线工具说明](../../scripts/permissions/README.md)。
- **i18n**：`initI18n`、`I18nProvider`、`useT`、`changeLanguage`、`currentLanguage`，以及读取 Tianshu 已发布页面语言包的 `createPageI18nLoader`。
- **Components / Hooks**：`PageHeader`、`PageState`、`PageTemplate`、`ListTemplateSettings`、`ListColumnSettings`、`ListColumnSelector`、
  `AppErrorBoundary`、`usePermission`、`useFeatureQuery`。
- **Vite 插件**（`@stellar-enclosure/stellar-enclosure-web-shared/vite-plugin`）：`egonFaviconPlugin()`，统一为四个控制台与 Portal 宿主注入 `stellar-enclosure-platform/favicon.png`（dev/preview 中间件 + index.html 注入 + build 产物输出）。

## 使用

`ListTemplateSettings` 根据业务后端返回的模板提供选择、切换、系统/个人模板编辑和字段排序，通过 `actions` 与 `refresh` 回调访问业务服务。`ListColumnSettings` 可单独编辑可见列，`ListColumnSelector` 可嵌入其他编辑弹窗。调用方必须根据鉴神字段权限过滤候选字段，并负责通过自己的业务服务读取和保存天枢模板；组件不持有凭据、不自行决定权限。候选字段在编辑期间被撤销时，列选择器不会再将其返回。

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

## PUBLIC OAuth 登录与直连请求

从受控部署配置读取 `PublicOAuthRegistration`。配置包含准确的 HTTPS issuer、authorization endpoint、token endpoint、JWKS 地址、redirect URI、Resource、API base 和 scopes。启用授柄 `browser_binding` 的注册须设置 `browserBound: true`。

```ts
import { createPublicOAuthClient, createHttpClient, type PublicOAuthRegistration } from '@stellar-enclosure/stellar-enclosure-web-shared'

export function createConsoleAuth(registered: PublicOAuthRegistration) {
  const auth = createPublicOAuthClient({ registrations: [registered], activeResource: registered.id })
  const authority = auth.authority()
  const api = createHttpClient({ baseUrl: authority.apiBaseUrl, authority })
  return { auth, authority, api }
}
```

登录按钮调用 `auth.login('/dashboard')`。精确登记的回调页调用 `auth.completeRedirect()`，随后用返回的 `identity` 和 `returnTo` 更新应用并导航。SDK 从地址栏移除 code/state，校验授权事务、ID token 与 Resource access token。页面刷新后按需重新授权。退出时调用 `auth.logout()` 清理本地身份，调用 `auth.logout({ sso: true })` 同时进入授柄的 SSO 退出确认页。

其他资源使用各自的登记配置。用户动作可调用 `auth.authorizeInPopup(resourceId)`；该资源登记的弹窗回调页调用 `relayPublicOAuthPopupCode(popupRedirectUri)`。弹窗被拦截时，由应用提供 `auth.selectResource(resourceId)` 加 `auth.login()` 的顶层导航入口。仅在同一租户发行者下保留多个资源授权。

`createHttpClient` 用固定 `authority.apiBaseUrl` 发送当前资源的 Bearer 并保留调用方 `AbortSignal`。401 使该资源授权失效，403 交给权限视图处理，503 表示权威不可用。SSE 通过 `withEventStream` 传递 `Last-Event-ID` 和取消信号，调用方负责解析和断点续读。`new Rbac3ApiClient({ transport: api })` 使用同一客户端。应用保持自己的登录触发与权限 bootstrap，写请求由用户或应用显式发起。

## 权限视图、Guard 与字段体验

`PermissionSnapshot` wire 合同来自当前用户受权上下文：`issuer`、`subject`、完整 `catalogScope`、`catalogVersion/authVersion/policyVersion`、`activeRoleContext`、`permissionCodes` 和 `snapshotExpiresAt`。ID 与版本为十进制字符串，expiry 为 ISO Instant。浏览器不能通过该视图向后端证明自己具有权限。

`PermissionSnapshotContext` 只在客户端多带加载时捕获的 `requestEpoch`。host 先对照当前身份与受权 scope 核验服务端结果，再使用 `snapshotContext(snapshot, capturedEpoch)`；它不是从页面输入猜测身份的函数。`usePermissionSnapshot({binding, requestContext, fetchSnapshot})` 严格比较完整 tuple，失效/加载/失败时没有正向缓存回退，401/退出后的旧 epoch 不会自动形成重复请求。普通缓存最长 60 秒且不超过服务端 snapshotExpiresAt。

```tsx
import { PermissionGate, usePermission } from '@stellar-enclosure/stellar-enclosure-web-shared/react-permissions'

<PermissionGate snapshot={snapshot} binding={currentContext}
  requirement={{ mode: 'ALL', codes: ['order:read'] }}>
  <OrderDetails />
</PermissionGate>
```

`usePermission(snapshot, binding)` 的 `hasAll()`、空 ANY、未知/无效规则都返回 false。使用 `/permissions` 可获得无 React 的声明、求值器、快照/字段校验和缓存；`/react-permissions` 仅补充 React hooks/Gate，RBAC SDK 复用同一实现。

后端字段投影使用 `BackendFieldCatalog {catalogScope,catalogVersion,fields}`；每个 fieldKey 提供显式 `access`、原 Java `fieldPolicy` 和可信布尔值 `inputBinding`。后端只对实际可绑定且非 READ_ONLY 的输入字段返回 true。缺投影或 scope/version 不匹配时默认省略且不可写。PROTECTED 按 plainRead > maskedRead > omitted，write 独立；PUBLIC 只免字段权限表达式，响应字段默认只读，只有后端明确标注可绑定输入才能写。INTERNAL 对外拒绝。UI 只能展示服务端提供的 maskedValue，不能通过浏览器遮罩代替后端脱敏。

## Tianshu 页面语言包

`createPageI18nLoader` 接收应用已有的认证客户端适配函数，不接收 Token，不直接请求匿名接口。
适配函数调用 `GET /api/v1/tianshu/i18n/bundle`，将 `PageI18nQuery` 的八个字段（含 `catalogScopeId/catalogActivationVersion`）作为查询参数，
透传 `AbortSignal`，并使用应用已有的逻辑解包 `ResultRecord`，返回 `PageI18nBundle`。
服务端从认证上下文获取企业身份，客户端查询参数不包含 `tenantId`。

下面的初始化函数可放在应用的身份管理层；在同一身份生命周期内复用返回的 loader，避免在组件每次 render 时创建或请求：

```ts
import {
  createPageI18nLoader,
  type PageI18nLoader,
  type PageI18nLoaderOptions,
  type PageI18nIdentity,
  type AuthRequestContext,
} from '@stellar-enclosure/stellar-enclosure-web-shared'

export const createIdentityPageTexts = (
  fetchBundle: PageI18nLoaderOptions['fetchBundle'],
  identity: PageI18nIdentity,
  requestContext: AuthRequestContext,
): PageI18nLoader => {
  const loader = createPageI18nLoader({ fetchBundle, requestContext, cacheTtlMs: 60_000 })
  loader.setIdentity(identity)
  return loader
}

export const loadOrderTexts = (loader: PageI18nLoader, locale: string, refresh = false) => loader.load({
  bizCode: 'retail',
  namespaceCode: 'main',
  env: 'prod',
  appCode: 'shop',
  catalogScopeId: '500',
  catalogActivationVersion: '7',
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
  SDK 不重复合并，也不会修改现有 `initI18n` / `useT` 使用的全局 `common`。默认语言由页面配置，接口 locale 使用规范 BCP 47 格式；SDK 复用 RC/JDK 25 规则，将 `en-us` 规范成 `en-US`，不会把 `en-SU` 按 ICU 别名改成 `en-RU`。
- **缓存与更新**：默认缓存 60 秒，同一查询的普通并发请求会合并，语言与完整页面作用域各自缓存。
  `load(query, { refresh: true })` 绕过 TTL，并取消、替换同一查询中尚未完成的旧请求，防止发布前的迟到响应覆盖新文案。
  版本是包含公共包变更的 opaque 字符串，不做大小比较。
  版本变化时整包替换，已删除 key 不会残留。没有后台轮询或持久化存储。
- **失败行为**：401/403/版本冲突清除旧文本并拒绝，不使用旧缓存或默认消息掩盖授权失败；其他可用性错误只保留同身份、完整作用域及激活版本、页面和语言的最近成功资源，`source` 为 `stale`；
  没有成功资源时使用本次传入的 `fallbackMessages`，`source` 为 `fallback`、`version` 为 `null`。
  两种情况都会返回 `error` 供应用显示状态。没有资源也没有本地回退时 Promise 拒绝；身份变化导致的取消始终以 `AbortError` 拒绝。
- **身份生命周期**：身份上下文必须包含当前可信 issuer/subject、完整 `catalogScope`、catalog/auth/policy 版本、activeRoleContext、snapshotExpiresAt 与加载时捕获的 `requestEpoch`，不能使用 Token 或页面输入。
  企业切换、同企业重新登录时调用 `setIdentity(newContext)`，退出时调用 `setIdentity(null)`；调用会清缓存及资源、取消请求，迟到响应无法重新写入。
  旧结果的 `t` 在身份失效后只返回 key。`messages` 是已返回的只读快照，页面展示原始 JSON 时仍须校验结果身份与当前身份一致，
  并忽略旧 effect 的异步结果。`clear()` 清资源并允许当前身份重新加载；身份上下文拥有者最终卸载时调用 `dispose()`，销毁后不可复用。
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
