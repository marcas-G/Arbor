# UI 新建项目的资源授权 — 治理决策候选 v3

状态：**DRAFT v3 / 待独立复审与治理决定**

缺口：`FT-DG-01`

本轮范围：**只修订提案供独立复审；不直接落地 docs/design / 生产代码 / 测试**

建议接受标识：`ACCEPT_UI_PROJECT_RESOURCE_ADMISSION`

## 1. 要解决的问题

浏览器新建项目目前只要求项目名，提交的根 Workspace 资源边界是空数组。用户随后可以
聊天、创建 Work、批准动作，但独立 Verifier 读取 `proof.txt` 时得到
`workspace filesystem mount is missing or ambiguous`，Work 无法走到验收。

F21 已在生产构建、真实后台进程、空数据库、隔离目录和浏览器中复现。测试进程提供了
`ARBOR_PROJECT_ROOT`，当前创建流程仍没有使用它。证据：
`planning/results/F21-failing-browser-evidence.result.md`。

## 2. 建议决定

引入**宿主登记的项目资源目录**，作为创建项目的可信来源。它是进程内配置与对外选择项，
不新增 Project、Workspace、Agent 或 GitWorktree 聚合。

```text
Project       产品容器
Workspace     长期责任身份
资源登记项    宿主允许项目使用的目录
GitWorktree   独立的具体资源生命周期
```

首版宿主通过 `ARBOR_PROJECT_ROOT` 登记一个目录。启动时检查其存在且为目录，解析
真实路径，并产生不透明 `resourceProfileRef` 与配置版本。浏览器只看到友好名称、
可用状态和 ref，不获得“任意填写服务器绝对路径”的输入框。未来桌面宿主可以提供
文件夹选择器，仍走同一登记接口。配置版本绑定规范真实路径；重启后同一配置可重建
相同 ref，路径或指向变化必须产生新版本。ref 只是选择符，不是能力凭证。

创建项目不会自动创建 Git worktree。根 Workspace 获得由登记项解析出的
`FileTree ResourceBoundary`；子 Workspace 的边界仍受父级 ceiling 约束。

## 3. 用户流程

1. `GET /project-resources` 返回已认证用户可选的登记项：
   `{ resourceProfileRef, displayName, version, available }`。不返回原始绝对路径。
2. 首页只有一个可用项时自动选中，并显示它的友好名称；用户输入项目名即可创建。
3. 没有登记目录时，页面明确说明该项目只能对话，不能使用文件工具或完成需要文件
   证据的 Work。用户若要创建这种项目，必须明确选择“仅对话”。
4. 目录配置无效时，后台报告配置错误，不能把无效项伪装成可用项。

## 4. 命令与授权边界

公开 `/commands` 的新写入使用 `CreateProject` v2。外部 payload 保留项目/根 Workspace
的非资源字段，但资源字段只能是一个封闭联合：

```text
resourceSelection = Profile { resourceProfileRef, version }
                  | ConversationOnly
```

外部 payload **不接受** `rootWorkspace.resourceBoundary.addresses`、绝对路径或与
`resourceSelection` 并存的旧资源字段。浏览器和远程客户端都不能通过自由路径扩权。
认证主体必须与声明的 `actor` 精确绑定，不能靠客户端自称 `user:*` 获得权限。

v2 的 `semanticRequestFingerprint` 覆盖 commandType、projectId、认证后确定的 actor、
schemaVersion=2，以及**完整的资源选择符与其他语义 payload**，不把当前宿主路径
重新计算进同一请求的指纹。Authority Resolver 仍负责 CreateProject 命令权限；
P1 02 声明的只读 Profile Port 由 P12 host composition 装配。登记表在进程启动时
检查目录、解析 canonical real path 并冻结为不可变快照；请求处理期间只按 ref/version
做纯内存精确匹配，不在 Gateway 事务内执行 filesystem I/O。handler 从该可信快照
构造唯一规范的 FileTree ResourceBoundary；ConversationOnly 明确产生空边界。Profile
不是 capability，CreateProject authority 仍完全由 P12 Resolver 决定。

外部请求必须严格保留 DID v1.34 §4.1B / P12 02 / P1 01、03 顺序：认证、wire-v1
闭合解码、ID 校验、当前 Handler schema/fingerprint、Actor 与 Principal 精确绑定、
Resolver visibility，随后才进入 Gateway 的 BEGIN IMMEDIATE receipt tuple 线性化点。
tuple mismatch 先走既有 IdempotencyConflict；exact tuple 才解码/重放；absent 才执行
handler。不得由 Composition、HTTP/WS/CLI shell 或 Profile API 在 Resolver/Gateway
外按 commandId 预读收据，也不得按 stored schema 重算旧指纹或解码旧 result/error。

CreateProject v2 新写入由当前 registered handler 计算 schemaVersion=2；wire codec
仍为 server-selected v1。完整资源选择符进入 semantic fingerprint。只有 Gateway 已
确认没有收据时，handler 才查询进程内不可变的 ProjectResourceProfile Port。该 Port
是确定性内存映射，不做 filesystem I/O；Profile 存在且 version 精确匹配时产生唯一
canonical FileTree ResourceBoundary。Profile 不存在、外来或版本过期时返回
ProjectResourceUnavailable typed terminal rejection，不创建 Project/Workspace/Session、
Event 或 ownership claim；按现有 P1 收据规则固定该 CommandId 的终态，修正选择需用新
CommandId。

生产注册表只允许 v2 CreateProject 新写入；v1 raw-address payload 不得以 External、
ExecutionOrigin 或 System 身份继续进入生产创建 handler。历史 v1 rows/payloads
preserve-only：原始旧 payload 被当前 strict codec 拒绝为 InvalidCommandPayload；当前
合法 v2 候选完成现有认证、Actor binding 与 Resolver visibility 后，若复用一个存储
v1 receipt 的 CommandId，则由 Gateway tuple mismatch 返回 IdempotencyConflict；不
披露、不改写旧行，也不创建第二个项目。此方案不提供旧
v1 same-ID replay；如果产品要求升级后无缝恢复该旧请求，必须单独治理证明，不得用
Composition pre-read 或按 stored schema 解码绕过 F23。

Project/Workspace/Session 仍在同一个 Gateway 语义事务中创建，root Workspace 持久化
canonical boundary。提交后 ownership activation 必须重读持久化的根 Workspace
ResourceBoundary，而不能从原始 payload 或当前 Profile ref 重新挑路径。首次提交、
exact receipt replay、进程重启都使用同一持久化边界；若文件系统已变化，解析结果必须
与 durable boundary 比较，失败关闭且不得 fallback 到另一登记项。

## 5. 失败语义与安全约束

- 缺失、过期、外来且结构合法的 ref：返回非披露的
  ProjectResourceUnavailable terminal rejection，不写 Project/Workspace/Session/Event
  或 ownership claim；同一失败 CommandId 不可改选后复用。
- 外部 payload 的格式/未知字段错误：现有 InvalidCommandPayload；未授权主体仍由
  Resolver 拒绝，两类错误不泄露路径。
- 客户端同时提交 ref 与未经批准的非空地址：拒绝，不能取客户端地址作为替代。
- 宿主目录真实路径变化：产生新的配置版本，旧 ref 不再适用。
- 资源边界不能由模型文本、Plan、普通浏览器字段或审批动作扩大。
- 持久化的 ResourceBoundary 保持真实规范地址；公开 bootstrap 列表和错误信息不
  泄露没有必要暴露的宿主绝对路径。
- 资源登记项与 PermissionGrant、一次性 ActionApproval、Git worktree 分属不同
  语义，不互相代替。
- 新建 Workspace 的 canonical ResourceBoundary 是持久化资源真相；本候选不在事件中
  增加 Profile ref/version 或地址摘要。P1 05 的 eventVersion=1 compatibility 和
  Profile 来源审计 OPEN 见 §8。

## 6. F21 验收合同

必须让 `tests/functional/pending/ui-project-resource.spec.ts` 原样走通：

```text
宿主登记一个临时目录，目录内有 proof.txt
→ 从空数据库打开首页
→ 浏览器创建项目
→ 浏览器提交目标并批准
→ Agent/Verifier 在登记目录读取文件
→ 独立 Verification PASS
→ 浏览器记录 Acceptance
```

已验收 Work 的终态可见性由 F22 / `FT-DG-02` 单独证明；F21 不以“待处理项消失”
替代 Completed 生命周期的公开读取。

该测试不能用直接 `/commands`、SQLite、内部 Layer/Repository 预建项目，
也不能标记 skip、fixme 或预期失败。修复后将 F21 移入默认 Playwright 功能门禁，
删除独立 pending 配置。

还需要负例：伪造 ref、未登记绝对路径、ref 与自由地址同时提交、旧版本 ref、目录
不存在、无目录时的明确“仅对话”选择、伪造 actor、无权主体、同 id 同请求重放、
同 id 改 ref 冲突、v2 候选命中历史 v1 receipt、profile 撤销/版本变化后的 exact
receipt replay、无 receipt 时的过期 Profile rejection、daemon 重启后 ownership 从
durable Workspace boundary 恢复、路径/symlink 被替换时不 fallback，以及 Project 与
Git worktree 仍为不同对象。
其中“未登记绝对路径”已有独立失败测试：
`tests/functional/pending/resource-admission.functional.test.ts`，使用真实后台和公开
`/commands`，当前错误地得到 Committed；接受后应迁入默认功能门禁。

## 7. 治理落点

若接受此决策，只修改各自拥有语义的文档：

```text
docs/design/02-system-design.md                 资源登记、信任与对象边界
docs/design/03-detailed-implementation-design.md  命令/指纹/权限/错误合同
docs/design/implementation/P1/01-command-contracts.md  CreateProject v2 payload/schema/rejection/Event owner
docs/design/implementation/P1/02-port-contracts.md     Profile Port and tx/I/O boundary
docs/design/implementation/P12/**                     host Profile catalog + transport; keep 02 Resolver pure
docs/design/implementation/P13/02-command-exposure-matrix.md
docs/design/implementation/MAC/03-golden-paths-and-fulfillment.md
```

P1 05 eventVersion policy remains unchanged in this candidate. Any source-audit field on
ProjectCreated requires a separately accepted P1 01/P1 05 event-version and reader-ceiling
package; do not add EventVersion=2 under the current reader ceiling.

## 8. OPEN 与完成边界

### OPEN-1：Profile 来源是否必须长期可审计

F21 的功能性验收只要求用户明确选择 Profile、持久化 canonical Workspace
ResourceBoundary、之后能从该边界读取 proof.txt；它不要求重启后查询原始 Profile
ref/version。因此本 OPEN 不阻止“浏览器新建项目可访问所选资源”的 F21 黑盒资格，
但阻止声称 Profile 来源审计闭合。

Workspace ResourceBoundary 持久化了实际 canonical 地址，却无法区分“同一地址、不同
Profile ref/version”。现有 ProjectCreated v1 payload 无来源字段。P1 04 规定 commands
永不 hard-delete，理论上 v2 CreateProject receipt result 可以保存选择符；但现有
receipt 查找按 CommandId，ProjectCreated 事件经过 retention 后不再提供稳定的
projectId→commandId 查询链接，单独扩展 resultJson 不足以构成按 Project 可用的长期审计
读面。

如产品要求长期 source attribution，必须由治理选择并落地主人/兼容矩阵：

1. ProjectCreated 增加 EventVersion 2：修改 P1 01 / P1 05 writer-reader 合同并同步
   所有 consumer reader ceiling。当前 packages/application consumer ceiling=1，
   SQLite projection consumer 对 eventVersion>1 quarantine；不得只升级 writer 或
   对旧消费者宣称向前兼容。旧 v1 events 保持原样，新增消费者明确支持 v1/v2。
2. Project 持久化 Profile ref/version：更新 P1 Project 合同、P1 04 SQLite schema 与
   forward-only migration；旧项目标为 Unknown/Legacy，不从旧 raw path 猜测回填；增加
   按 Project 查询该来源的 owned view/port。
3. CreateProject v2 receipt 保存带明确 discriminator 的选择符：更新 P1 01 result
   decode schema，并新增可信 Project→CreateProject receipt 查找合同。commands 虽不
   hard-delete，当前 CommandStore 只按 CommandId 查找，不能仅凭“有 resultJson”宣称
   来源在现有 Project read surface 可审计。

本候选把以上长期审计选择留为 OPEN-1；不在 v3 静默添加 EventVersion 2、Project 列或
未查询的 receipt 元数据。

### OPEN-2：旧 v1 same-ID 请求的升级后恢复体验

本候选有意将旧 v1 receipt/payload preserve-only，与当前 F23 tuple 规则兼容，但不保证
应用升级后旧客户端能用同一个 v1 payload/CommandId 成功重放。若产品要求该成功路径，需
另行提出 F23 兼容治理，并证明它不预读、不泄露且不绕过当前 schema/fingerprint tuple；
本候选不包含此行为。

### OPEN-3：提交后 ownership activation 的持久用户信号

CreateProject canonical Project/Workspace/Session 先由 Gateway 原子提交，ownership claim
随后激活。如果 path 在期间消失，命令仍是 Committed；重试必须从 durable Workspace
boundary 重试相同 activation，绝不把它报告为 rollback 或改绑到别的目录。若产品还要求
独立于 HTTP convergence Problem 的 durable Attention/修复入口，需由 P1/P12 owner 明确其
持久事实和查询，不由本候选发明新 attention 状态。

本文件仍是 DRAFT。它不修改 docs/design/**、production 或 pending tests，不声称 F21 已
关闭；用户要求的宽泛后续实现授权不等于本候选已接受、已落地或已资格化。
