# Workspace-scoped sandbox authority

日期：2026-11-16  
状态：产品口径已确定；实现和设计落地仍在进行

## 决定

Arbor 的权限和授权按 Workspace 计算。一次沙箱策略决定是否有效，取决于
当前 Project、目标 Workspace、该 Workspace 的 ResourceBoundary、所属
Execution、Episode 和当前策略版本之间的真实关系。

文件工具、命令工具和联网工具都要遵守工作区的权限范围；一次动作审批不能扩大
ResourceBoundary。Workspace 是责任与治理单元，不能等同于目录。

`user:local` 只表示本机请求的认证来源和审计 actor。它不能被拆成多个
HumanPrincipal，也不能通过隐藏 token、内部角色或自动代办 Grant 来制造授权。

Workspace 的纵向治理继续使用现有模型：根 Workspace 由当前用户治理，Child
Workspace 通过既有 Parent/Direct-Child 治理关系处理；Sibling 之间不因为共用
一个本机用户而互相获得权限。Child 的独立区域、正式通信关系和 ResourceBoundary
仍然有效。

主机上的 sandbox authority bundle 只证明本机执行器、operator 配置、provider
资格和网络执行能力可信。它不决定哪个用户拥有 Workspace，也不再作为第二套
用户权限名单。

## 工程落地要求与建议（尚非实现完成记录）

- Web 的策略选择直接提交当前 Workspace 的决定，不创建第二个人类身份。
- Resolver 必须验证 Workspace/Project/Execution/ResourceBoundary/治理关系，
  并把这些事实绑定到 `SandboxPolicyDecisionAuthority`。
- Gateway 必须在同一事务内重新验证这些 Workspace 事实和 CAS；身份只用于
  请求来源与审计。
- 新的策略决定不能依赖 `HumanPrincipal → HumanPrincipal` 的 sandbox Grant。
- 已有 grant/provenance 和旧策略决定保留为历史兼容数据，不能被解释为新的
  Workspace 授权。迁移和重放必须保持可读，并明确区分历史授权与当前授权。
- 新的持久化结构必须能表达 Workspace 授权依据，不能用伪造的 grant ID 或
  第二身份填充旧字段。

## 验收条件

1. 单用户本机请求使用一个 `user:local` 即可为当前有权 Workspace 选择策略。
2. 决定绑定精确 Workspace 和 Execution；换 Workspace、换 Execution、改
   ResourceBoundary、改治理关系或改 host/provider 资格后旧决定失效。
3. 两个 Workspace 即使由同一用户操作，也不能访问仅分配给对方的资源；明确
   共享的资源按正式准入范围访问，共享读取不授予写入所有权。
4. 重启只恢复同一 Workspace 的持久事实，不从环境变量、隐藏 token 或模型文本
   重建授权。
5. 审计保留真实认证 actor，同时明确记录 Workspace/Execution 授权依据。

## 与冻结设计的关系

现有设计已经定义了 Workspace Agent、ResourceBoundary、Parent/Direct-Child
治理和 subject-bound grant。这里明确的是产品优先级：Native sandbox 的用户
授权必须落在 Workspace 治理事实上，不能采用当前 P12 特殊的两个
HumanPrincipal 例外链。涉及冻结设计的具体落地仍需在所属文档中留下可审计的
治理 landing；本文件不悄悄改写 `docs/design/**`。

## 已确认的使用行为（同日补充）

项目负责人明确接受 Q-016、Q-017 的推荐方案：

- 同一 Workspace 已获准的能力跨新任务与重启持续有效。只在扩大能力、扩大资源
  范围、撤权或原授权失效时重新确认；敏感动作的一次性审批仍单独处理。
- Parent 可在自身当前权限上限内明确分配给直接 Child，Child 只在自己的资源
  边界内工作；超出 Parent 权限或扩大资源范围时升级给用户。
- 分配不是默认复制全部能力，也不取消既有 Child 形成审批、正式通信、独立
  Session/Work/Inbox、资源所有权或结果 Acceptance。

这两项已是产品决定，不再作为未决问题。实现资格与产品决定分开记录。
具体落地合同见 `docs/proposals/2026-11-16-workspace-permission-continuity.md`。

## 用户撤权的优先级（同日明确接受）

负责人确认：对某个 Child 工作区的撤权决定由用户亲自解除；Parent 即使仍拥有
相关能力，也不能再次授予来抵消撤权。持久 Revoked 当前记录必须拒绝新的 Parent
分配，不能仅依靠旧请求版本不匹配实现。用户显式重新授权才可恢复。

本次固定工程落地包是
`docs/proposals/2026-11-16-workspace-authorization-commands-and-revocation.md`，
SHA-256 `07e2552d26ff41a1b23df398260cda6752c81f4fe0fe5f275eda54f291e65e7c`。
已增加领域、事务提交和 SQLite 验证；普通生产执行入口和 UI 仍未接入，不能据此
宣布真实 shell/构建/测试已经可用。分层证据见
`docs/verification/2026-11-16-workspace-sandbox-authorization.md`。


## 执行策略绑定工程接入（同日补充）

以上产品决定对应的固定工程包为
`docs/proposals/2026-11-16-workspace-execution-policy-binding.md`，SHA-256
`9d3a968400d89bc9865ac92dd91e143f2390db6037ff4286a4a79d4385c267f4`。
已在 DID、P1/04、P4/03、P12/02 留下同日补充：内部 Binder 复用受信主机准备及当前
资源检查，回执绑定真实工作区授权版本，保留旧人类 grant 历史，不引入第二用户。
此工程接入没有增加新的产品授权选择，也未推广 runtime schema。实现与落地复核
见 `docs/verification/2026-11-16-workspace-policy-binding.md`；正式执行链仍待集成。


## 后续生产接入检查点（同日）

上文的“暂存/未注册/schema56”描述对应先前检查点。当前源码已接入 schema57、
离线副本升级、现代回执兼容、生产授权/撤销和内部 Binder。普通浏览器表单使用
一个本机人类身份；内部 Parent 来源保持外部不可伪造。文件工具的只读/撤销上限、
新命令 effect 准入事务的完整当前来源复查及旧策略授权版本检查已补实现与定向验证。
当前策略已有不可用事实时重新绑定，不能因其余快照仍相同而永远复用旧修订。

模型 Parent 分配动作现已接入：只在当前上限内向直接 Child 分配，人工撤权
阻断新的分配；旧回执重放不恢复权限。真实模型分配和完整安装包旅程仍未验收。
这里不把产品决定、源码接线和安装验收合并为一个完成标签。当前资格与失败记录见
`docs/verification/2026-11-16-workspace-production-integration.md`。
