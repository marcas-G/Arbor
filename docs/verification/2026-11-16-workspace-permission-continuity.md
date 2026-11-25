# Workspace 权限持续性：设计落地与首个实现单元

日期：2026-11-16。源码为 `e7065a7c` 加当前工作树修改；不是发布资格。

## 人工决定与落地范围

负责人对同一批问题明确回答：

- “工作区授权持续有效（推荐）”
- “Parent 可在已有权限内分配（推荐）”

前者包含跨任务与重启、能力/资源扩大或原授权失效时重新确认，以及具体敏感动作
审批独立；后者包含明确分配、Child 自己的边界以及超过 Parent 上限时升级用户。
这些是产品决定，工程细节由 Agent 落实，不要求负责人决定内部角色/表名。

决定记录：`docs/decisions/2026-11-16-workspace-scoped-sandbox-authority.md`。
工程落地包：`docs/proposals/2026-11-16-workspace-permission-continuity.md`。
包 SHA-256：`d0049ca9e8e4e1c9246813be633b381b2458040741fdb58497d8c0a29ad6ac5f`。

没有改动 WHY/WHAT 的 P1–P8/G1–G8；按语义所有权在 Scenarios、SD、DID、P12、P4、
P1 追加有日期的补充。Q-016/Q-017 已标为已决定。未宣称有额外的人工技术审查。

## 本次实现

1. 普通文件/命令授权默认持续有效，也可以选 1/8/24 小时。仍需用户明确提交。
2. GrantPermission schema 2 只为精确 WorkspaceAgent + 相同 Workspace target 的
   fs:write/shell:exec 接受显式 null expiry。缺省/空值、人类/Execution、wildcard、
   跨工作区、DecideSandboxPolicy 持久授权均拒绝。
3. Resolver 要求明确 authenticatedHumans 成员、当前同项目 Active Workspace 和
   revision，不能凭 user: 前缀授权。Gateway 在事务内复核 Workspace、Project、
   lifecycle、revision，并使用可信 Clock 记录 validFrom。身份仍用于来源与审计。
4. 沿用既有 permission_grants 的 NULL 存储，runtime schema 保持 56，不升级或
   修改用户数据库；历史有限期授权不延长，schema 1 receipt 可读/重放。
5. 工具执行不能为退休或跨项目 Workspace 产生新的 InvocationAuthority；敏感
   动作审批、资源准入及 Native process policy 检查继续独立。

## 已有证据及限制

- 授权/输入/领域/既有沙箱授权的首批定向 6 文件 81 项通过。
- 新 SQLite 关闭重开与新 Execution 检查通过：十年后同一持久 Workspace grant
  仍授权精确能力，其他 Workspace 被拒绝，撤销后拒绝。该用例用 P29 物理存储
  合同证明 NULL 与耐久读取，不是安装产品验收。
- 当前 schema 工厂 + 真实 external composition（P12 loader/resolver → P1 Gateway
  → SQLite）新增流程通过：创建项目、持续授权提交、关闭重开、同请求重放、
  单一 PermissionChanged、schema 2 receipt，以及公开撤销命令。
- Web 新默认与既有有限期/丢失响应重试用例 2/2 通过。
- 根 lint/typecheck、架构 199/199、launcher 6/6，以及 Web typecheck、production
  build、39 文件/295 项测试通过。
- 本轮 `pnpm check` 没有完整 exit 0：早期测试导入/转型约束问题已修正；后续全量
  core 发现 P39 累计前缀清单漏列 56（已有 schema 56 增量的测试遗漏）。只补清单，
  未改迁移或 SQL；之后该文件随首批 50 文件通过。没有降低指纹或历史前缀断言。
- 为避免在 Native/Child 整体改动前反复完整串行检查，随后按现有 runner 的
  `ARBOR_CORE_TEST_BATCH_SIZE=50` 合批执行；前三批共 150 文件结束（其中 2 文件
  既有跳过），第 4 批主动 SIGINT，退出 130。未宣称 499 文件全部通过；整套后台
  和完整功能旅程留待下一批整体接入后验证。所属进程组已退出。
- 最后针对本次权限、外部命令装配、存储耐久和历史兼容的定向复验：7 文件、74/74 通过。

没有使用脚本模型证明真实 coding 完成；没有代办用户授权、设置第二身份或修改
现有用户库。Native DecideSandboxPolicy 旧特殊链仍在，Parent 分配与实时上游
ceiling、每次执行的新策略物化和普通安装包真实命令验收仍未完成。KP-016 保持
OPEN/P0；上述局部证据不能关闭它。

## 落地一致性复核（本 Agent，非独立审查）

- 产品决定与实现资格分别记录；Child 明确分配是已决定、待实现，不再提问。
- Workspace 授权与 exact Execution policy / action approval 分开，无自动扩大。
- 上游来源仍为治理事实；新持久授权不使用旧 sandbox grant/provenance 填假值。
- 不修改历史 planning/results 证据，不把既有包的成功扩展为当前包资格。
- 下列拥有补充的文件摘要固定本次落地内容（后续合法修订应追加新记录）。

| Owning document | SHA-256 |
|---|---|
| `docs/design/01-scenarios.md` | `f405dd3371c6b0f161a161f4f7e3f618ab8594ee0e293b6faa6e68e9483910d7` |
| `docs/design/02-system-design.md` | `b5b8251a1dd7b20be0e5e5970324e3f3f14c76ba8b4fe4fb226e3aaec82378b2` |
| `docs/design/03-detailed-implementation-design.md` | `72b426d9ae9c8bcd5e108daa2d9d9313afbc175bf59d4e41d9f127ca1ec7e599` |
| `docs/design/implementation/P12/02-authority-resolver.md` | `cdde5dba0bafed89e2e689b878acb19fe1426f6052fd019211dbed67f09e739c` |
| `docs/design/implementation/P4/03-authority-permission-approval.md` | `8db528d2afb5eb9443e25670ecae9606b350244e594628f201a4969fafeed09f` |
| `docs/design/implementation/P1/01-command-contracts.md` | `595060b21c89585f8421720f9675bea1116717453748b9dfe72dbd62a94fafac` |
