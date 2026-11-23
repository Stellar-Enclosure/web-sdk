# @stellar-enclosure/stellar-enclosure-tianquan-jianshen-react-sdk

本包提供当前用户权限视图、角色激活流程、资源导航和字段体验。它通过真实依赖复用 `@stellar-enclosure/stellar-enclosure-web-shared` 的纯求值器与请求取消代次；构建顺序为 Shared → React SDK，打包时 external 保留 Shared 导入。

## 身份和权限接入

```tsx
import { createHttpClient } from '@stellar-enclosure/stellar-enclosure-web-shared'
import { snapshotContext } from '@stellar-enclosure/stellar-enclosure-web-shared/permissions'
import { Rbac3ApiClient, Rbac3Provider } from '@stellar-enclosure/stellar-enclosure-tianquan-jianshen-react-sdk'

// Reuse the application client that completed the registered OAuth callback.
import { auth } from './consoleAuth'
const identity = auth.identity()
if (!identity) throw new Error('Authorization is required')
const authority = auth.authority()
const api = createHttpClient({ baseUrl: authority.apiBaseUrl, authority })
const client = new Rbac3ApiClient({ transport: api })
const captured = authority.context.capture()
const snapshot = await client.getPermissionSnapshot(captured.signal)
captured.assertCurrent()
// Host must verify issuer/subject and the complete authorized catalogScope against its current bootstrap.
verifyCurrentIdentityAndScope(identity, snapshot)
const binding = snapshotContext(snapshot, captured.epoch)

<Rbac3Provider client={client} binding={binding} requestContext={authority.context}
  resources={resources} resourceReferences={fieldReferences} fieldCatalog={trustedBackendFields}
  onContextChange={updateHostPermissionAndTextContext}>
  <Console />
</Rbac3Provider>
```

API008 固定为 `GET /api/v1/authorization/effective-permissions`，只读取当前受权上下文，没有任意 subject/tenant 查询参数。返回完整快照，版本/ID 字段为十进制字符串。旧 About 的 `permissions/resourceCodes/fieldPolicies` 不再作为 Guard 输入；About 仅提供当前用户/角色/落地页元数据，旧角色管理 DTO 仍按其各自既有 wire 类型传输，不把其数字版本当作权限证明。

Provider 初始加载严格核对 host 提供的完整 binding。自然续期在服务器 `snapshotExpiresAt` 前 15 秒启动；首次快照到手已不足 15 秒时立即启动，并行读取 About 与 API008。只接受同一 verified issuer、subject、完整 scope、request epoch，catalog/auth/policy 版本均不得回退，角色上下文变化必须伴随 authVersion 推进；About 的 auth/policy 版本必须与新快照一致。有效期内续期不会进入 loading 或卸载仍获准显示的组件，因此本地草稿可继续保留；`onContextChange(context, snapshot)` 会传递新版本和服务器到期时间，host 回写同一组已验证事实不会触发重新初始化。

自然续期不会延长服务器 TTL。旧快照到期立即关闭授权；同一身份下仍在途的有效新快照可恢复视图。有效响应中的新授权事实、撤权及更早的到期时间立即采用；若 expiresAt 未前移，后续读取与网络错误、可重试 5xx 一样按 1/2/4/5/5 秒退避，最多重试 5 次，并且不在首轮续期的 30 秒窗口后发起新重试；仍有效的旧视图保留到自身到期。401、403、无效响应、版本或身份/scope 不匹配立即关闭授权，不自动重试。注销、身份/epoch 切换、卸载和显式角色变更会取消续期及已排队的重试，后台只重试上述 GET，绝不重放写入。角色变更仍先清旧视图，成功后重新读取 API008 并校验同 issuer/subject/完整 scope/catalog，失败不恢复旧授权。host 应把 `{...context, snapshotExpiresAt: snapshot.snapshotExpiresAt}` 传给文本 loader。

## 代码声明和 Guard

`resources` 使用 Shared `/permissions` 的 `defineResources`，通过 `key/type/target/requirement/i18n` 描述 MENU/PAGE/COMPONENT/BUTTON；API/FIELD 由 Java owner 定义，前端只传 `defineResourceReferences`。构建扫描与固定合同准备见 [离线工具](../../scripts/permissions/README.md)。

```tsx
<PermissionGuard requirement={{ mode: 'ANY', codes: ['order:read', 'order:approve'] }}>
  <OrderList />
</PermissionGuard>
<ActionGuard resourceKey="order.button.approve"><ApproveButton /></ActionGuard>
<FieldGuard fieldKey="order.field.accountNo" value={response.accountNo}
  maskedValue={response.maskedAccountNo} />
```

resourceKey 只查找源声明中的表达式，不是授予记录。ALL/ANY、组外 AND 和显式 PUBLIC 均使用 Shared 唯一求值器；空 ALL 不放行。`FrontendResourceRegistry.navigation` 和 `resolveDefaultRoute` 接收 snapshot + 当前 binding，不再使用 `about.resourceCodes.includes`。未知资源、未声明引用、重复 key、父节点缺失/循环均拒绝。

后端字段投影是独立只读 `BackendFieldCatalog`，必须与快照同完整 scope/catalogVersion。`useFieldAccess(fieldKey)` 返回 `{read:'PLAIN'|'MASKED'|'OMITTED',writable:boolean}`。plainRead 优先于 maskedRead，write 独立；缺少显式可信 inputBinding 时不可写，PUBLIC 响应字段也默认只读。浏览器不产生脱敏结果，也不把字段可见当成可提交依据；原 API、tenant 和业务校验始终在后端执行。

## 验证和分发

在 workspace 根完成固定 RC JAR 准备后执行 `npm test`、`npm run lint`，构建和测试不启动服务或浏览器。当前本地 lock 为 `LOCAL_UNCOMMITTED`，只支持本地源码/离线扫描/安装验证。`npm pack` 可生成安装包；实际 npm 发布必须通过固定 SDK commit 的 production toolchain 分发门禁。本次不发布 npm，不修改六个前端应用。
