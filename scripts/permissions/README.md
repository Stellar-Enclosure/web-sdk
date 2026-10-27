# Permission Manifest 工具

本目录实现 S13 的静态扫描/离线校验，以及 S30 的受控 `diff`、`sync`、`status`、`activate`。唯一数据合同来自固定 RC JAR 的 `permission-manifest/schema-v1.json` 与四组 `permission-contract/*-v1.json` 样例（Manifest、canonical、requirements、locales），不读兄弟仓库源码、不下载浮动版本，也不执行应用模块。工具使用 Node 24、已有 TypeScript Compiler API、固定 Ajv 8.20.0 的 draft 2020-12 实现及系统 `unzip`。Ajv、TypeScript、文件系统和 CLI 不进入浏览器 `/permissions` 包。

## 合同准备与构建证据

当前 `permission-toolchain.local.lock.json` 是明确的 `LOCAL_UNCOMMITTED` 证据：包含工具源码摘要、npm lock 摘要、整个 RC JAR SHA-256 和逐资源 SHA-256，`sdk.commit` 为 null。它允许本地构建、测试、离线扫描和打包检查；不代表已提交/发布的工具，也禁止在线注册和生产分发。

由操作者显式提供与 lock 摘要一致的制品路径后，在 SDK 根目录执行：

```sh
npm ci
node scripts/permission-manifest.mjs prepare \
  --lock permission-toolchain.local.lock.json \
  --artifact "$PAC_CONTRACT_ARTIFACT"
PAC_TOOLCHAIN_LOCK="$PWD/permission-toolchain.local.lock.json" npm run permissions:verify
npm test
npm run build
npm run lint
```

`prepare` 先验证整个 JAR，再只提取五个已知资源到忽略目录 `.generated/permission-contract`；每次工具运行重新核对资源摘要和 Java canonical 样例。缺失文件或摘要不一致直接失败。`npm test` 包含 React SDK、Shared SDK 和 Node AST/CLI 测试，不启动应用、数据库或浏览器。生成副本不能作为第二份手工维护的 schema。locale 规则明确复现 RC/JDK 25 Locale.Builder 的规范化，不用 ICU/Intl 的额外别名折叠；110 条实际 Java 生成样例同时由 RC 与 Node 消费，包含 en-SU、旧语言码、extlang、variant、extension 和 private-use。

工具源码、依赖或固定合同变化后，原 lock 会按预期拒绝运行。复核变更后创建新的本地 lock；工具不自动接受新摘要、不覆盖已有 lock：

```sh
node scripts/permission-manifest.mjs lock \
  --mode LOCAL_UNCOMMITTED \
  --artifact "$PAC_CONTRACT_ARTIFACT" \
  --artifact-sha256 "$PAC_CONTRACT_SHA256" \
  --output permission-toolchain.reviewed.lock.json \
  --contract-directory .generated/permission-contract
```

`PAC_CONTRACT_SHA256` 必须是已经核对的固定制品摘要。当前任务没有生成生产固定 commit；本地验证报告中的 artifact commit 只作为所填构建元数据，真实 sourceDigest 同时记录实际扫描源码，不得将本地报告当作不可变部署证明。

## 消费者的固定工具 checkout

生产/CI 分发使用单独的、完整 commit 固定的 SDK checkout，在该 checkout 执行 `npm ci`。每个消费者保存自己的非秘密 `permission-toolchain.lock.json`，其 mode 为 `PINNED_COMMIT`，记录实际 SDK commit、Node 主版本、npm lock 摘要及 RC 制品/逐资源摘要。工具会核对自身 HEAD 和干净状态，扫描生产者时还要求其 HEAD 与 artifact.commit 相等且工作区干净。没有 `main/latest` 回退，不依赖 `STELLAR_USE_SOURCE_BOOTSTRAP`，也没有第三个 npm 包。

```sh
node "$PAC_CLI" lock --mode PINNED_COMMIT \
  --sdk-commit "$PAC_SDK_COMMIT" \
  --artifact "$PAC_CONTRACT_ARTIFACT" \
  --artifact-sha256 "$PAC_CONTRACT_SHA256" \
  --output permission-toolchain.lock.json \
  --contract-directory .permission-contract
node "$PAC_CLI" prepare --artifact "$PAC_CONTRACT_ARTIFACT"
node "$PAC_CLI" verify --purpose distribution
```

SDK 自己进行发布检查时，可将实际生产 lock 放在 SDK 根的忽略路径 `permission-toolchain.lock.json`，避免 commit 引用自身造成循环。两个包的 `prepublishOnly` 都先执行分发门禁；本地 `npm pack` 可以用于源码检查，不会据此绕过发布门禁。

## 静态声明与配置

应用从 `@stellar-enclosure/stellar-enclosure-web-shared/permissions` 导入 `definePermissions`、`definePermissionReferences`、`defineResources`、`defineResourceReferences` 和 `defineMessages`。这些函数仅提供类型和静态标记。浏览器纯函数 `evaluateRequirement` 支持非空 ALL/ANY、至多一层组外 AND 和显式 PUBLIC；缺失、空组、非法 mode、嵌套 allOf、大小写冲突均拒绝。

```ts
import { definePermissionReferences, defineResources } from '@stellar-enclosure/stellar-enclosure-web-shared/permissions'

export const permissions = definePermissionReferences(['order:read'] as const)
export const resources = defineResources([{
  key: 'order.page.list',
  type: 'PAGE',
  target: { route: '/orders' },
  requirement: { mode: 'ALL', codes: ['order:read'] },
  i18n: { pageCode: 'order.list', labelKey: 'title' },
}] as const)
```

每个受管模块必须显式列出入口；`artifact.commit` 填真实完整生产者 commit，下面的占位值不能直接用于验证：

```json
{
  "schemaVersion": 1,
  "application": { "businessCode": "trade", "applicationCode": "order" },
  "producerId": "order-web",
  "ownedKeyPrefixes": ["order."],
  "expectedModules": ["orders"],
  "modules": { "orders": { "entryPoints": ["src/permissions.ts", "src/resources.ts"] } },
  "artifact": {
    "repository": "order-web",
    "commit": "FULL_PRODUCER_COMMIT",
    "buildId": "EXPLICIT_BUILD_ID",
    "version": "0.0.1"
  },
  "toolchainLock": "permission-toolchain.lock.json"
}
```

可选项为 `tsconfig`、`snapshotMode`（默认 FULL）和显式 `clearIntent`。FULL 必须覆盖 expectedModules 全集；PARTIAL 必须显式声明且不会被升级为 FULL。整份 FULL 为空只有在显式 clearIntent 时允许。字段/API 归后端权威声明，前端使用 `defineResourceReferences` 的 FORM_FIELD/TABLE_FIELD/DETAIL_FIELD/CALLS 等用途引用，不重新定义 FIELD/API，也不因为 calls 关系授予权限。

支持命名 import（含别名）、静态 const 引用、字面量对象/数组、静态 spread/member、`as const` 和 `satisfies`。支持的值必须在受管源码根内可解析；循环/缺失 import、重复或大小写冲突、越界资源前缀、未声明权限引用会失败。函数、类、运行期条件/字符串拼接、任意调用、namespace/default import、re-export、计算属性、顶层副作用不在允许语法内，都会明确拒绝。扫描器不会执行这些代码，也不以正则猜测权限。

## 离线命令

在生产者目录执行：

```sh
node "$PAC_CLI" scan --config permission-manifest.config.json --output "$PAC_MANIFEST"
node "$PAC_CLI" validate --manifest "$PAC_MANIFEST"
node "$PAC_CLI" diff --manifest "$PAC_MANIFEST" --baseline "$PAC_BASELINE" --output "$PAC_REPORT"
```

本地未提交验证显式加 `--lock /absolute/path/to/permission-toolchain.local.lock.json`；该文件的 contractDirectory 相对 lock 所在目录解析。`scan` 同时输出 `<manifest>.report.json`，记录 mode、完整性、源码与工具/依赖/合同摘要以及 policy/metadata/manifest 三个摘要。扫描失败会删除本次指定的旧 Manifest 输出，并写 `FAILED/UNCONFIRMED` 报告，不能误用前次 FULL 结果。

离线 diff 展示资源、权限定义和消息的新增/删除/修改以及两个摘要是否变化。`diff --target`、`sync`、`status`、`activate` 使用下面的固定目标合同。LOCAL_UNCOMMITTED 在任何在线/分发门禁处拒绝；`--dry-run true` 只验证输入并输出请求摘要，不读取凭据文件、不发送 HTTP。

## 固定目标与在线命令

非秘密 target 文件的键必须等于目标的 environment；下面仅展示字段形状，ID、地址和 producerId 需要替换为已配置的真实目标，不能把样例当成已存在的授权：

```json
{
  "schemaVersion": 1,
  "targets": {
    "test": {
      "baseUrl": "https://rbac.example",
      "target": {"catalogScopeId":"101","tenantId":"201","businessCode":"xingyuan","applicationCode":"order","namespaceCode":"default","environment":"test"},
      "producerId": "order-web",
      "authentication": {
        "issuer": "https://identity.example/tenants/201",
        "clientId": "order-web-ci",
        "resource": "https://rbac.example",
        "scopes": ["tianquan-jianshen:permission-manifest:register"],
        "clientSecretFileEnv": "PAC_CLIENT_SECRET_FILE"
      }
    }
  }
}
```

`clientSecretFileEnv` 指向环境变量的名字，其值是 owner-only 凭据文件路径；secret 不出现在 argv、target JSON、日志或产物中。客户端只向固定 `issuer + /oauth2/token` 发送原生 Client Credentials 表单，并使用固定 resource/scopes。只接受 HTTPS，不跟随重定向。SERVICE Scope 和数据库中精确 scope/producer/capability 授予仍由服务端独立校验。命令不创建账号、授予角色、提供部署资格或启动环境。本地写入只允许显式 `--target test`；其他环境还要求 CI 运行上下文，这只是防误用措施，不替代受保护流水线和服务端授权。

```sh
node "$PAC_CLI" diff --manifest "$PAC_MANIFEST" --lock permission-toolchain.lock.json \
  --target test --target-file permission-targets.json \
  --expected-producer-revision "$PAC_PRODUCER_REVISION" --expected-active-revision "$PAC_ACTIVE_REVISION" --output plan.json
node "$PAC_CLI" sync --plan plan.json --operation-id "$PAC_OPERATION_ID" \
  --lock permission-toolchain.lock.json --target test --target-file permission-targets.json --output registration.json
node "$PAC_CLI" status --operation-id "$PAC_OPERATION_ID" --kind registration --wait-seconds 120 \
  --lock permission-toolchain.lock.json --target test --target-file permission-targets.json --output status.json
# 外部受信部署与 readiness 已完成之后，显式选择全部生产者的已有 qualificationId：
node "$PAC_CLI" activate --selection activation-selection.json \
  --lock permission-toolchain.lock.json --target test --target-file permission-targets.json --output activation.json
```

`diff` 在线对应 POST plans，返回不可变、有期限的 planId/digests/expected versions；不是直接改目录。`sync` 只应用该计划，发送一次注册请求。写请求超时、断线、服务端错误或响应不能绑定时保留原 operationId/完整请求并报告 UNKNOWN，不能换 operationId 重试。`status` 只读取原操作；`--kind activation` 查询原激活描述符。metadata PENDING 不会输出 completed，也不会自动激活。`activate` 只接受现有 `CatalogActivationRequest`（完整 target、operationId、expectedActiveRevision、完整 producers/qualificationIds），既有资格仍会在服务端重验。

退出码：0 当前命令成功；2 输入/schema/目标配置错误；3 CAS 或所有权冲突；4 认证授权拒绝；5 目标不可用或明确失败；6 结果未知、仍 pending 或等待超时（携带原 operationId）。发送出去的写请求不会自动重放；状态等待最长 3600 秒，使用单调时钟。

## Java 与前端共用 CI 入口

从生产者 Git 仓库目录执行固定 checkout 中的 `scripts/permissions/ci.mjs`。它校验当前仓库 HEAD、最终制品字节/文件集、唯一 FULL Manifest 及内部标识；不读取浮动源码，不把当前未提交目录当作生产固定 commit。Java evidence 来自 RC manifest-cli 对最终 exec.jar 的核验；前端 evidence 来自本次 buildConsumer 的 `.generated/permissions/artifact-record.json`。

```sh
node "$PAC_SDK_DIR/scripts/permissions/ci.mjs" --phase validate \
  --manifest "$PAC_MANIFEST" --evidence "$PAC_ARTIFACT_EVIDENCE" --artifact "$PAC_FINAL_ARTIFACT" \
  --lock permission-toolchain.lock.json --output-dir target/permission-ci
node "$PAC_SDK_DIR/scripts/permissions/ci.mjs" --phase register \
  --manifest "$PAC_MANIFEST" --evidence "$PAC_ARTIFACT_EVIDENCE" --artifact "$PAC_FINAL_ARTIFACT" \
  --lock permission-toolchain.lock.json --target test --target-file permission-targets.json \
  --expected-producer-revision "$PAC_PRODUCER_REVISION" --expected-active-revision "$PAC_ACTIVE_REVISION" \
  --operation-id "$PAC_OPERATION_ID" --wait-seconds 120 --output-dir target/permission-ci
node "$PAC_SDK_DIR/scripts/permissions/ci.mjs" --phase activate --selection activation-selection.json \
  --lock permission-toolchain.lock.json --target test --target-file permission-targets.json --output-dir target/permission-ci
```

`register` 共用同一套 diff→sync→status 客户端，未知结果只查询原操作。`activate` 必须由外部受信部署阶段明确调用；普通 build、PR 和注册成功都不会触发激活。前端 `--artifact` 是本次 dist 目录，Java 是最终 exec.jar；两者都验证各自 evidence 并要求完整 Manifest 与实际字节一致。单测使用严格 HTTP fixture、真实 ZIP 文件及实际固定 RC 资源；不代表真实服务、数据库、Outbox、CI 或部署已验收。

Jianshen 和 Shoubing 前端的 Python CI 适配逻辑共用本目录 `consumer-ci.py`。消费者的薄启动脚本仅在获取 SDK 前读取并校验固定 commit；获取后必须匹配干净的 SDK checkout，才执行公共适配器。SDK 源摘要包含该 Python 文件。更新消费者前需先在受信流水线发布包含该文件的 SDK commit，再更新各自锁；不能把未提交源码或旧 commit 当作正式工具链。

## 固定后端 Manifest 的类型化引用

消费者可在 `permission-manifest.config.json` 设置 `backendReferences: {producerId, manifestDigest}`，并通过 `PAC_BACKEND_MANIFEST` 指向该完整 Java Manifest。SDK 在每次扫描之前验证合同、应用、producer、FULL 和规范化 Manifest 摘要，并在 `.generated/permissions/backend-references.ts` 生成只读的命名常量；字段、API 和权限定义仍由后端所有。生成失败会删除旧输出，扫描不能退回旧结果。命名导出可由打包器删除未使用常量，生成文件不应手工维护。

前端仍须显式声明自己的资源、按钮、字段用途和权限引用；生成常量只替换重复字符串，运行时仍使用当前字段目录和授权快照。摘要固定输入内容，并不证明制品已部署或取得资格；受信制品、READY、完整 producer 集合和显式激活仍由现有服务端验证。

```sh
node "$PAC_CLI" backend-references --lock "$PAC_TOOLCHAIN_LOCK" \
  --manifest "$PAC_BACKEND_MANIFEST" --manifest-digest "$PAC_BACKEND_MANIFEST_DIGEST" \
  --producer-id "$PAC_BACKEND_PRODUCER" --business-code "$PAC_BUSINESS" \
  --application-code "$PAC_APPLICATION" --output .generated/permissions/backend-references.ts
```

## 离线发布计划

`release-plan` 读取只读清单，不注册、不部署、不激活。清单可以引用已保存的服务端 descriptor、producer 列表、当前各 FULL Manifest、候选注册结果/最终制品 evidence 和资格回执文件；路径相对于清单文件。候选版本取自注册回执，旧版本取自 descriptor，无需逐项填写激活版本。

```json
{
  "schemaVersion": 1,
  "descriptor": "descriptor.json",
  "producerList": "producers.json",
  "currentManifests": ["api-manifest.json", "web-manifest.json"],
  "candidates": [{"manifest": "candidate-manifest.json", "registration": "registration.json", "evidence": "artifact-evidence.json", "diff": "server-diff.json"}],
  "qualifications": ["api-qualification.json", "web-qualification.json"],
  "roleSnapshots": "reviewed-role-snapshots.json"
}
```

```sh
node "$PAC_CLI" release-plan --lock "$PAC_TOOLCHAIN_LOCK" \
  --inventory release-inventory.json --output release-plan.json
```

计划核对当前集合与摘要、目标作用域、候选回执、引用闭包以及资格的制品和到期时间。候选需带绑定到当前激活修订的服务端 Diff；缺失、冲突或报告授权扩大时为 `BLOCKED`（命令退出码 3），有变更且资料完整时为 `REVIEW_REQUIRED`，无变更时为 `NO_CHANGES`。本地文件本身不是服务器真实性证明，计划不会声称未受影响的 API wire 合同兼容，也不会替代服务端基于实际角色的 Diff、资格重验、显式激活及可信部署证明。任一输入或修订变化时重新生成并审查。

可选 `roleSnapshots` 为同一作用域和当前激活修订下经授权取得或显式构造的角色有效权限集合：`{target, expectedActiveRevision, roles:[{roleId, permissionCodes}]}`。计划仅对发生变化的 API/页面/按钮及 FIELD 计算表达式前后结果，并列出受影响权限字符在选定 Manifest 中引用它的资源及提供的角色集合；它不执行操作，也不计算 OAuth Scope、数据范围、字段实际 inputBinding 或当前角色事实。结果是待复核的影响估计，不保证输入角色集合完整，更不是 Runtime 授权决定；未提供时明确标为 `NOT_PROVIDED`。计划输出在支持 POSIX 权限的文件系统中以 0600 创建，输入文件及其目录也应按权限审计数据保护。

