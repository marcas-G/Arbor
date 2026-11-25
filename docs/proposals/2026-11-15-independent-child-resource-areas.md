# Child Workspace 独立责任区域与通信设计审计

状态：已完成设计核对；尚未修改冻结设计或生产代码。

日期：2026-11-15

## 先纠正一个误读

这里的“Child 是单独的区域”首先指 **Workspace / Responsibility / Communication
区域**，不是简单选择一个目录或 Git worktree。

正确的产品结构是：

```text
Parent Workspace
  ├─ 自己的责任、Session、Work、Context 和执行循环
  └─ Child Workspace
       ├─ 自己的责任、Session、Work、Context 和执行循环
       └─ 通过正式通信与 Parent 协作
```

Child 不是 Parent Session 里切出来的一段上下文，也不是 Parent 继续直接执行的
一块工作。它是一个长期责任单元，有自己的主认知执行角色、Work、验证和状态。

## 原设计中的通信语义

现有冻结设计的 P6/P7 链条已经表达了这套行为：

1. Parent 通过 `ProposeChildWorkspace` 形成正式 Child，而不是创建一次性
   Subagent Prompt。
2. Child 拥有自己的 Primary Session 和独立 Context；Runtime 只向它提供
   Responsibility、必要事实、约束、Initial Work 和引用入口。
3. Child 的结果不会直接写入 Parent Session。重要输入进入 Parent Inbox，经过
   Promotion/Consumption 后由 Parent 自己理解。
4. Parent 与 Child 通过明确的通信原语协作：
   `Assign`、`Query/Reply`、`Report`、`DecisionRequest`、`Deliver` 和
   `Dependency`。
5. `Deliver` 只表示正式交付；它不会自动代表 Parent 已理解，也不会替代
   Verification、Acceptance 或 Dependency matcher。
6. Authority 纵向流动，信息可以按允许的图关系流动；Sibling 不能因为可观察
   Child subtree 就获得治理或写权限。

对应的文档证据：

- `docs/design/02-system-design.md` §4.1–§4.6、§7.1–§7.5、§8.1；
- `docs/design/implementation/P6/01-formation-semantics.md` §1、§4、§5；
- `docs/design/implementation/P6/02-communication-protocol.md` §1–§6；
- `docs/design/implementation/P7/02-deliver-primitive.md` §1–§9；
- `docs/design/implementation/P7/06-wake-integration.md`。

## 当前真正存在的缺口

后续 S3 资源所有权治理包没有改写上述通信语义，而是在“物理资源写入所有权”层
增加了一个已经确定的执行模型：

```text
Parent allow = /project
Child region = /project/child
Parent effective write set = /project - /project/child
```

它出现在：

- `docs/design/02-system-design.md` v1.25 §4.5.2；
- `docs/design/03-detailed-implementation-design.md` v1.64；
- `docs/design/implementation/P1/04-sqlite-schema.md` 的 schema 53 补充；
- `docs/design/implementation/P4/05-resource-admission.md`；
- `packages/domain/src/resources.ts` 的 `OwnershipRegion`；
- `adapters/persistence-sqlite/src/ownership.ts` 的激活和回收事务。

因此，当前问题不是“Child 通信被实现成了 Parent 的一部分”，也不是要在目录、
worktree 或独立区域之间重新做产品选择。通信/责任模型仍然是独立 Workspace；
资源层的 Parent exclusion 是已经确定的物理写入实现。剩余问题是维护文档、
生产装配和真实用户旅程是否把这两层都准确体现出来。

## 必须保持的分层

### Workspace/通信层

- Child 有独立 Identity、Primary Session、Current Work、Context、Verification
  和 Acceptance 事实。
- Parent 不直接写 Child 的 Session、Context 或正式责任范围。
- Child 的请求、发现、阻塞和结果通过 Inbox、Message、Deliverable、Dependency
  和治理命令传递。
- 收到消息不等于理解；收到 Deliver 不等于 Acceptance；Dependency 满足由
  结构化 matcher 决定。

### 资源执行层

- ResourceBoundary 是责任在 Environment 中的执行投影，不是 Workspace 的
  通信区域。
- Write ownership 必须由 Runtime 和 P4 admission 判定，不能由模型文本或
  Parent/Child 消息推断。
- Read visibility、formal write ownership、通信可见性和治理 authority 是
  四个不同问题。
- 所有文件和进程工具必须使用同一资源准入结果，不能因为通信关系而自动扩大
  读写范围。

## 当前实现需要核对的不是“目录还是 worktree”

后续实现应先回答以下真实行为：

1. Child 的责任、Session、Work 和通信是否始终独立持久化；
2. Parent 是否只能通过通信和正式治理路径影响 Child；
3. 已授权资源范围内的 Child 文件修改是否被记录为 Child 的正式产物，并能通过
   Deliverable/Delivery 被 Parent 观察和接收；
4. 明确共享的输入是否保持只读，Parent 的 broad grant 是否仍不能覆盖 Child
   的独占写入范围；
5. Child 回收时是否按已冻结的 provenance、quiescence 和原子 reclaim 合同释放
   Child claim，并保留未交付结果的可观察状态；
6. 停止、恢复和重放是否保持同一 Child Workspace、Message、Deliverable、
   Verification、Acceptance 和 Resource binding。

这些是已经有设计方向的产品可观察行为和跨层实现验收，不能用“自动 worktree”
或“用户选目录”先行替代。最新产品澄清还要求两个工作区能够真实联网、安装依赖、
构建和测试；当前 Native 生产执行仍未接通，因此这些验收尚未完成。

## 目前可以保留的实现结论

- P6/P7 的 Child 形成、Inbox、通信、交付和依赖设计方向与“Child 是独立区域”
  一致，不能被改回 Parent Session 直写或一次性 Subagent。
- 当前 S3 carve-out 代码代表已接受的资源写入所有权实现，不能被描述成 Child
  Workspace 的整体语义，也不能被当作整个父子 coding 旅程已经完成。
- 在生产进程执行、联网、并行工作区和停止/恢复的真实资格完成前，不应把定向
  carve-out 测试或历史 S3 旅程扩大成完整父子产品交付。
- 历史 carve-out 数据不能从路径或旧通信记录自动推导出新的 Workspace、资源或
  权限事实。

## 需要同步审阅的文件

- `docs/design/01-scenarios.md`：已定义 Parent/Child 的可观察协作与结果汇聚；
- `docs/design/02-system-design.md`：已定义责任/通信边界与 ResourceBoundary、
  ownership carve-out 的分层；
- `docs/design/03-detailed-implementation-design.md`：已定义 Workspace、Message、
  Deliverable 和 ownership claim 的绑定关系；
- P6/P7：核对实现是否保持独立 Session、Inbox、Delivery 和 Dependency；
- P4/P11/P12：核对资源准入、worktree、sandbox mount 与通信关系没有互相越权；
- `packages/application`、`packages/agent-runtime`、SQLite ownership adapter、
  sandbox wiring 和真实 S3 验收测试。

## 验收口径

必须用一条真实 Parent/Child 旅程同时证明两条链：

1. Parent 形成 Child 后，Child 拥有独立 Session、Work 和上下文入口；
2. Parent 通过 Assign/Inbox/Message/Deliver/Dependency 与 Child 协作；
3. Child 的消息到达、交付、Verification 和 Parent Acceptance 各自可观察，
   不能互相冒充完成；
4. Parent 和 Child 的文件/进程资源访问由独立的资源准入事实控制，通信不会
   自动扩大权限；
5. 停止、重启、恢复和重复投递后，Workspace Identity、Message、Deliverable、
   Verification、Acceptance 与资源绑定仍然一致。

设计层已经明确，不需要重新选择 Child 的通信模型。实现层必须在同一份当前源码和
发行物上同时通过这两条链，才能声明“Child 独立区域的完整 coding 用户旅程已实现”。
