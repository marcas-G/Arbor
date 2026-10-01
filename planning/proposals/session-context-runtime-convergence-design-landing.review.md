# Session / Context Runtime 收敛 — Owning Contract 落字后一致性审阅

## 结论

**ACCEPT / Blocking = 0 — 2026-10-01。**

本审阅针对已经提交的正式设计落字，而不是针对未应用的 planning 草案。审阅与
后续代码实现分离；它只判断 SCRC-1…SCRC-12 是否完整、无冲突地进入 owning
contracts，不授权 migration 0019 或生产实现。

## 固定对象

- 人工接受提案 SHA-256：
  `200D9EE0F252915F1816C57FC5FEE470E77D7FB924A95A7474E03DF68BFAFD05`
- Owning-contract landing commit：`75589c5`
- System Design v1.4 SHA-256：
  `7F44DFD544AD06F510A11F43642111372DB8A957B333105E38319BD712A6C54C`
- DID v1.22 SHA-256：
  `781FB5DCBFB91BDD8A94A8237FD5BAF0458A8BF46ED55A9CCB583F43699C8866`
- P3 contract index SHA-256：
  `245180E7E0F376565ED37E0449B7F1D6981E15011C44E1AB3ABC2D45AB57E1F8`

Landing commit 同时固定 P2/P3/P4/P9/P12 的 owning phase-contract edits；文件清单
以该 commit tree 为准。

## 四向审阅

### 1. 设计忠实度 — PASS

- Session Timeline 与 active model window、Canonical State 三者分离；
- ToolCall/ToolResult 保留 callRef；
- Inbox 改为一次性 source-key Session promotion；
- Steer/Queue safe-boundary 语义分离；
- `NeedsCompaction` 保持 control result，不再被设计为 settlement；
- Summary/ProviderNative compaction、binding compatibility、same-step resume 已落字；
- Permission/Authority 不从 Session/summary/checkpoint 恢复。

没有修改 P1–P8/G1–G8、S1–S4、Work/Verification/Acceptance 生命周期或父级权限衰减
语义。

### 2. 跨文档覆盖 — PASS

已覆盖：

- System Design：Session、Context、Inbox、Runtime components、system invariants 61–68；
- DID：ADT、Ports/Application service、Provider request、Tool correlation、Context
  pipeline、Budget、Compaction、Manifest、Persistence、Package DAG、Appendix B/C；
- P2：Session ports、migration successor、recovery ordering；
- P3：Provider/Model Context/Agent Loop/DDL/ContextUnsatisfiable/AgentLoopStep；
- P4：Tool settlement → Session result boundary；
- P9：Inbox/Tool/Compaction/overflow/native-binding crash recovery；
- P12：repeated-compaction safety 与 provider qualification。

### 3. 可执行性 — PASS

机械检查 16/16：

1. SD v1.4 / DID v1.22；
2. invariant 61–68 连续存在；
3. P2 typed append/frontier/checkpoint ports；
4. 0018 已占用、0019 唯一 reserved、生产 migration 尚无 19；
5. P2 恢复顺序；
6. `PortableInputItem + operationKind`；
7. CanonicalProviderEvent ADT 保持 closed；
8. 旧 every-turn Inbox / plain role:tool 规范句已清除；
9. Summary/Native result ADT；
10. NeedsCompaction 不结算；
11. ContextUnsatisfiable 不再进入无收益压缩循环；
12. Compaction 前后 AgentLoopStep identity 不变；
13. ToolRuntime 不直接写 Session；
14. AH15–AH19 crash faces；
15. ProviderNative mismatch portable fallback；
16. repeated/no-gain compaction 与 second overflow bounded。

`git diff --check` PASS。完整 `pnpm check` 的 lint、typecheck、20 个 architecture
files / 121 tests 通过；全量测试 250/251 files、1492 passed、1 skipped。唯一失败是
`tests/convergence/result-record.test.ts` 仍把 OPEN gap 集固定为 G-V2-1…4；正式设计
落地后，按本审阅关闭 SCRC-DG-01 即恢复该既有收敛断言，无需改测试语义。

### 4. 风险与边界 — PASS

- 没有新增 package/dependency edge；
- 没有扩展 CanonicalProviderEvent；
- 没有授权 migration 0019；
- legacy Observation 不从文本猜 callRef；
- native opaque checkpoint 不跨 binding；
- overflow retry 有界且受 durable-effect gate；
- historical P2–P12 completion 仍是历史证据，不冒充 SCRC 实现完成。

## Supersession 核对

以下旧合同已被明确替代：

| 旧合同 | 当前合同 |
|---|---|
| Observation → plain `role:tool` text | typed ToolResult/ControlResult + callRef |
| 每轮读取全部 unconsumed Inbox 且不消费 | source-key atomic Session promotion |
| `PortableMessage` universal carrier | `PortableInputItem` ADT；Message 只是变体 |
| char/4 独自决定上下文处理 | 多级 budget evidence；char/4 仅 fallback |
| ContextUnsatisfiable 先 compact | fixed mandatory context 的 typed terminal failure/Attention |
| ordinary NeedsCompaction 可停止执行 | explicit in-loop Compaction + same-step resume |

## 裁决建议

SCRC-DG-01 的设计问题已由 System Design v1.4 / DID v1.22 与 landing commit
`75589c5` 完整回答，建议标记 `RESOLVED`。

这不等于实现完成。下一门禁仍是：implementation plan + task contracts + TDD
acceptance matrix + explicit implementation authorization。
