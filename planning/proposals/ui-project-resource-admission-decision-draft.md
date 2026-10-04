# UI 新建项目的资源授权 — 治理决策稿

状态：**DRAFT v2 / 等待人工治理接受**

缺口：`FT-DG-01`

实施：**尚未授权**

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
Application 内的可信资源登记 Port 在首次命令执行时再次校验主体、ref、版本、
当前真实路径和宿主策略，构造唯一规范的 FileTree ResourceBoundary。该边界与
Project/Workspace/Session 在同一 CommandGateway 语义事务中持久化；handler 不
从客户端 payload 拷贝任何资源地址。`ConversationOnly` 明确产生空边界。
宿主登记表在单个进程内不可变；若目录在校验后、激活前消失或被替换，激活按规范
地址失败并产生可恢复的可见问题，不能重新挑选另一个目录。

命令收据查询先于“当前资源配置是否仍可用”的判断，但不先于身份校验和 actor 绑定：

- 同一已解决 `commandId`、同一 v2 指纹、同一已认证主体返回原 Committed 或
  TerminalRejected 收据，不重新解析 ref，也不创建第二个项目；
- 同一 `commandId`、不同选择符或其他语义字段返回 `IdempotencyConflict`；
- 尚无收据时必须使用**当前仍有效**的 ref/version。配置已变化则返回类型化
  `ProjectResourceStale`，绝不将旧 ref 悄悄映射到新目录；
- 若第一次尝试仅发生可重试故障、没有权威收据，重试仍是同一语义请求；当期间
  配置失效时可终结为 `ProjectResourceStale`，不会出现半创建 Project；
- 对已提交项目，资源登记项的撤销不隐式撤销既有 Workspace 边界；修改既有边界
  必须走独立治理。收据重放无需当前目录仍在登记列表中。

生产注册表只接收 `CreateProject` v2 新写入；v1 原始路径 payload 不论 External、
ExecutionOrigin 还是 System，都不能在生产注册表形成新写入。旧 handler 可以留作
历史单元/迁移夹具，但没有生产新写入口。现有公开进程测试迁移到 v2 登记项。

读取已有收据时，Composition 在权限求值前按 `commandId` 查询不可变 CommandStore，
按**收据中持久化的 schemaVersion** 比对请求指纹，不用当前 v2 handler 重新解释
v1 payload：

- v2：已认证 principal 必须等于 actor，且 `projectId`、指纹、算法版本均与收据
  一致，才返回原收据；不一致返回 `IdempotencyConflict`，不泄露原结果；
- v1：只允许进程仍处于 localhost 单用户认证形态、principal 和 actor 都精确为
  `user:local` 时，对同一 v1 指纹执行**只读**收据重放；其他部署或无法证明来源
  均返回类型化 `LegacyReceiptProvenanceUnknown`，不创建新项目；
- 没有收据：v1 外部请求一律拒绝，v2 才走 Authority Resolver、可信登记 Port 和
  CommandGateway。并发两次同 id v2 请求仍由 Gateway 的收据唯一性裁决。

这个兼容分支不升级 v1 payload、不替 v1 生成新版本指纹，也不把 `actor` 自称
当作认证证明。现有直接 Gateway 单元测试可以保留作为历史合同测试；生产流程
和公开进程测试必须使用 v2。

提交后资源所有权激活必须**重读已持久化的根 Workspace ResourceBoundary**，不能
再从原始外部 payload 取地址。这样首次提交、网络断开后的收据重放和进程重启后的
恢复都使用同一事实；激活失败可以按既有幂等恢复机制重试。

## 5. 失败语义与安全约束

- 缺失、过期、外来 ref：返回可见的类型化问题，不写 Project/Workspace。
- 未授权主体或被撤销的目录配置：权限拒绝，不写状态。
- 客户端同时提交 ref 与未经批准的非空地址：拒绝，不能取客户端地址作为替代。
- 宿主目录真实路径变化：产生新的配置版本，旧 ref 不再适用。
- 资源边界不能由模型文本、Plan、普通浏览器字段或审批动作扩大。
- 持久化的 ResourceBoundary 保持真实规范地址；公开 bootstrap 列表和错误信息不
  泄露没有必要暴露的宿主绝对路径。
- 资源登记项与 PermissionGrant、一次性 ActionApproval、Git worktree 分属不同
  语义，不互相代替。
- `ProjectCreated` 的新版本记录 Profile ref/version 或 ConversationOnly 及规范
  地址摘要作为审计来源；不把宿主绝对路径放进公开事件或错误。规范地址仍属于
  Workspace 的 canonical ResourceBoundary。

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
同 id 改 ref 冲突、提交后登记项变更的收据重放、无收据时登记项变更的失败关闭、
后台重启后 ownership 恢复，以及 Project 与 Git worktree 仍为不同对象。
其中“未登记绝对路径”已有独立失败测试：
`tests/functional/pending/resource-admission.functional.test.ts`，使用真实后台和公开
`/commands`，当前错误地得到 Committed；接受后应迁入默认功能门禁。

## 7. 治理落点

若接受此决策，只修改各自拥有语义的文档：

```text
docs/design/02-system-design.md                 资源登记、信任与对象边界
docs/design/03-detailed-implementation-design.md  命令/指纹/权限/错误合同
docs/design/implementation/P12/02-authority-resolver.md
docs/design/implementation/P13/**
docs/design/implementation/MAC/03-golden-paths-and-fulfillment.md
```

用户此前仅授权 Codex 在**人工治理明确接受后**代为更新 `docs/design/**`。
在接受前，此稿和 F21 失败测试只提供决策证据，不授权实施。
