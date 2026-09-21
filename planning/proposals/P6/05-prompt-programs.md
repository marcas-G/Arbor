# P6 — 05 Prompt Programs (versioned contract)

**Authority:** DID v1.9 §8.4（Prompt Program families）, §8.4A（trust metadata）, §8.19（decisionBasisManifest）, §13 表（Prompt Program actual text / behavioral eval set = PHASE CONTRACT, P6）; SD §13.3.
**Status:** PROPOSAL DRAFT.

## 1. P6 拥有的 Program families

按 DID §8.4 编号（编号是 family 名，与阶段号无关）：

| Family | 用途 | P6 交付 |
|---|---|---|
| P5 Responsibility Formation Program | 形成分工提案的行为协议 | v1 文本骨架 + eval 集 |
| P6 Communication / Coordination Program | Query/Reply/Report/DecisionRequest 通信行为 | v1 同上 |
| P10 Workspace Bootstrap / Handoff Program | 子 Workspace 初始认知装配 | v1 同上 |
| P13 Human Interaction / Steer Program | 吸收纠错、请求裁决、恢复自治 | v1 同上 |

- 它们是**行为代码**：版本化、留 provenance、回归测试（AGENTS.md 规则 6）。
- Prompt 指导；Runtime/Sandbox 强制（SD §13.3 结语）——Program 文本中的任何约束都不得是唯一防线（不变量执行归 DID-6 六层）。

## 2. 文本骨架契约（open decision D4：契约冻结骨架+必备条款，全文随实现版本化）

每个 Program v1 必须包含的必备条款（缺一即 eval 失败）：

### P5 Formation Program

```text
- 形成判据：独立性/并行价值/上下文可隔离/工作方式差异/单 Agent 成本（S1.4 步骤 3 原文五条）
- 提案输出结构 = ChildWorkspaceProposal 字段一一对应（name/draft/rationale/initialWork）
- 第一层提案必须预期 human gate；不得在文本中声称自行完成第一层划分
- 深层细分自主判断（自己做/串行/并行三支，S1.3 图）
- 禁止条款：不得以 formation 代替 Dependency（后者属 P7 surface，文本不承诺）
```

### P6 Communication Program

```text
- 四种 kind 的适用条件（Query 求观察、Report 暴露发现、DecisionRequest 请求裁决、Reply 应答）
- correlation 纪律：应答必须携带所应答消息的 correlationId
- 发送 ≠ 已被理解：不得把"已发送"当作"已确认"
- bodyRef 纪律：正文写 Artifact，消息内只留 bounded 摘要（DID §8.14）
- urgency 固定 Normal：不得在文本层发明抢占语义
```

### P10 Bootstrap Program

```text
- 初始认知清单 = 01 §5 五项来源，逐项对齐
- 标注来源 authority：CanonicalInstruction 与 DataOnly 的区分规则（DID §8.4A）
- 无 parent 记忆继承承诺：bootstrap 不复制 parent Session
- 首轮自检：复述 Responsibility 边界与 initialWork 目标（形成可评估的 grounding 输出）
```

### P13 Human Steer Program

```text
- 吸收不重启：在既有工作脉络上合并 guidance（S2 §5）
- 纠错后恢复自治：完成吸收即自主推进，不等待逐步人工确认（S2 §7）
- 升级路径：需要高层裁决时用 DecisionRequest，不用重复 Report
- severity 语义：Normal 不改变执行节奏；Critical 后首个动作是重读 Canonical Control 面
```

## 3. 行为 eval 集（每 Program 至少）

| Eval | 形式 | 通过标准 |
|---|---|---|
| E1 结构遵从 | Fake Provider 脚本化输出 | 指令载荷 100% 落在冻结 ADT（decode 通过或拒绝，无 repair 逃逸） |
| E2 判据召回 | 场景化提问（该不该拆/该不该报） | 行为与 family 判据一致（可测的 directive 选择） |
| E3 禁止条款 | 诱导性场景 | 违禁行为不出现（如文本层抢占、发明 Deliver） |
| E4 版本回归 | 固定种子集 | 文本版本变更后全量重跑，差异即 diff 报告 |

- eval 集是 deterministic 的（Fake Provider 脚本），不依赖真实模型（沿 P5 决策：real provider non-gating）。
- eval 断言的对象是 directive/消息结构，不是自由文本相似度。

## 4. 版本化与 provenance

```text
promptPrograms/
  formation/v1.md        communication/v1.md
  bootstrap/v1.md        human-steer/v1.md
每文件头：familyId, version, frozenContractRef(P6 05 §2), changelog, hash
```

- Program 文件进入 git；Manifest 引用其 hash（对齐 P3 Manifest 的 OutputContractRef 模式）。
- 文本变更 = 行为变更：走 eval 全量回归 + 版本号递增；不允许静默改文。

## 5. Must Not Decide

- No Output Contract / directive 词汇表变更（P3 拥有）。
- No Skill 内容语义（Skills surface 属 P3 加载机制 + 内容自有版本线）。
- No 真实模型调优基准（非 gating；empirical 归实现）。
- No 用 prompt 文本替代任何 runtime 不变量强制。
