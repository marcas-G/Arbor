# UI 新建项目的资源授权 — 治理决策稿

状态：**DRAFT / 等待人工治理接受**

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
真实路径，并产生稳定的不透明 `resourceProfileRef` 与配置版本。浏览器只看到友好
名称、可用状态和 ref，不获得“任意填写服务器绝对路径”的输入框。未来桌面宿主可以
提供文件夹选择器，仍走同一登记接口。

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

浏览器向公开 `/commands` 提交 `CreateProject`，附带
`resourceProfileRef`。普通浏览器和远程外部客户端不得用
`rootWorkspace.resourceBoundary.addresses` 中的自由路径扩大权限。

Composition/Application 边界根据当前认证主体、ref 和配置版本解析目录，生成**唯一的
规范 CreateProject payload**：根 Workspace 的 ResourceBoundary 含宿主批准的
FileTree 地址。然后才计算语义请求指纹、调用 Authority Resolver 和 CommandGateway。
数据库写入与后续 ownership activation 都使用同一份规范 payload。

现有 `makeExternalSubmission` 在解析权限之前直接对原始 payload 计算指纹，这一
顺序必须调整。对相同 commandId，如果宿主目录配置在重试前改变，旧 ref 应拒绝或
产生指纹冲突；不能静默换目录。已经提交的旧命令收据如何重放，也必须由同一版本化
规则明确处理。

`resourceProfileRef` 是选择符，不能仅凭持有它获得权限。仍需验证人类主体、
Project bootstrap 权限和宿主目录策略。原有直接 raw-path CreateProject 调用仅能留在
明确的宿主/管理入口；现有公开进程测试需要迁移到资源登记项，不得保留远程扩权旁路。

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

## 6. F21 验收合同

必须让 `tests/functional/pending/ui-project-resource.spec.ts` 原样走通：

```text
宿主登记一个临时目录，目录内有 proof.txt
→ 从空数据库打开首页
→ 浏览器创建项目
→ 浏览器提交目标并批准
→ Agent/Verifier 在登记目录读取文件
→ 独立 Verification PASS
→ 浏览器验收
→ Work Completed
```

该测试不能用直接 `/commands`、SQLite、内部 Layer/Repository 预建项目，
也不能标记 skip、fixme 或预期失败。修复后将 F21 移入默认 Playwright 功能门禁，
删除独立 pending 配置。

还需要负例：伪造 ref、未登记绝对路径、旧版本 ref、目录不存在、无目录时的明确
“仅对话”选择、无权主体、命令重放、后台重启，以及 Project 与 Git worktree
仍为不同对象。

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
