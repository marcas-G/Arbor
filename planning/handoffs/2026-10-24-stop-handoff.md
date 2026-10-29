# Arbor 工作交接（2026-10-24）

## 1. 接手入口

- 仓库：`https://github.com/marcas-G/Arbor.git`
- 工作树：`C:\Users\ThinkPad\.codex\worktrees\native-sandbox-preintent-integration\Arbor`
- 分支：`codex/native-sandbox-preintent-final-20261021`
- 本交接前 HEAD：`bb7816e51dfeb78b09fd07a2a43f12c604b20618`
- 远程状态：相对 upstream `ahead 280 / behind 0`，尚未推送。
- 当前在线/用户数据库不得升级或修改；后续只使用 fresh fixture 或可丢弃副本。
- `docs/design/**` 继续遵循 `AGENTS.md` 的人工治理约束。

## 2. 本轮已经形成的安全提交

| Commit | 内容 | 已做验证 |
|---|---|---|
| `f4880a1a` | 修复 OpenAI-compatible / DeepSeek 多轮工具调用中的 reasoning round-trip；`reasoning_content` 与相邻 `tool_calls` 合并在同一 assistant message | `pnpm typecheck`；5 文件 34 项定向测试；P16 架构 6 项；Biome / diff-check |
| `bb49be0c` | Windows Native Sandbox D4a：有界私有协议、固定构建脚本、non-launching helper；生产仍保持 Experimental / Unavailable | sandbox-windows build；定向 12/12；Biome |
| `31d922eb` | 保守的测试影响规划器与分层执行说明 | manifest/规划器 11/11；语法检查 |
| `c431c91f`, `1a09a90a` | 机器可读 RC 收敛看板及最新资格修正 | report 测试 3/3；Markdown/JSON 输出 |
| `9f39b643`, `bb7816e5` | 终态 Provider 失败重复准入的治理提案与独立复审 | RED 证据复核；复审 Blocking=4，不可接受/实施 |
| `29afcbda`, `baacc105`, `f5df474a` | F23/P6 UnboundLegacy 公共读取资格 | 真实进程定向 1/1 PASS |
| `96df6392` | 四个 P8/F23/recovery 用例晋升到默认 process 清单 | manifest/typecheck/Biome；尚待最终候选运行 |
| `71eca442`, `13938387` | 安全的 additive-manifest resume 与 Playwright 新文件防误继承 | runner/manifest 轻量测试 |

## 3. 已知可靠基线

`772ba5d713032fbccd7623264f5b664bee22f4a9` 上已有：

- `pnpm check` PASS；
- release functional `completeCoverage=true`；
- browser 10/10；
- package / clean-checkout PASS。

证据：`planning/results/release-candidate-convergence-772ba5d7.result.md`。

这不是当前 HEAD 的完整资格。之后的生产代码、manifest、support 和测试变化要求重新形成最终候选证据。

## 4. 当前唯一 RC 看板

执行：

```powershell
node scripts/release/report-rc.mjs --format=md
```

机器合同：`planning/release/rc-contract.json`。

当前汇总：**3 PASS / 6 OPEN / 3 BLOCKED**。报告器不会因为证据文件存在而自行推断 PASS。

## 5. 真正的剩余关键路径

1. **不要立即重跑真实 Provider。** 先对 `f4880a1a` 做代码审阅、定向协议/Context 回放和四个晋升 process 测试。
2. **修订 RAI-DG-02，而不是实施当前草案。** 独立复审在
   `planning/results/RAI-DG-02-terminal-provider-failure-readmission-hold-independent-review.md`
   记录了 4 个 Blocking：来源基数/身份、P10 物化机制与完整性可见性、终态 Work 的 Attention 处置、缺失的 crash/race/历史重复资格。修订、重新哈希、重新独立复审后才能请求人工接受。
3. **Windows Sandbox 保持 fail-closed。** D4a 只建立 helper 协议和可复现构建，不得把 provider 标成 Supported，也不得启动 helper。D4b 生命周期、真实文件系统隔离、网络、资源限制和 Stop 资格仍开放。
4. **解决 Submitted DecisionEpisode 损坏语义。** 当前仍需 owner 治理决定，不能用测试负例替代设计。
5. **最终只做一次冻结候选全量。** 局部分层验证全部通过后，冻结 exact SHA，再依次运行 `pnpm check`、完整 release functional、browser、package，然后串行运行真实 Provider S1–S4。

## 6. 更高效的执行方法

日常反馈顺序固定为：

```text
纯状态/codec/协议
→ 组件与 SQLite 事务
→ 少量真实 daemon/crash 边界
→ 真实 Provider 单场景
→ 冻结 SHA 后一次全量 release
```

先运行影响规划器：

```powershell
node scripts/testing/plan-test-impact.mjs --base <已验证基线SHA>
```

注意：当前 v1 规划器仍偏保守。对 `AGENTS.md`、非执行 planning Markdown、
`scripts/release/**` 和 `adapters/sandbox-windows/**` 还会因 unknown path 扩大到全 lane。
下一步只需按 `planning/tasks/focused-test-impact-execution.md` 增加 ignored/direct-check
规则和 3 类单测；不要把 focused PASS 标成 `completeCoverage=true`。

## 7. 推荐的下一条接手指令

```text
读取 AGENTS.md 和 planning/handoffs/2026-10-24-stop-handoff.md。
先审阅 f4880a1a 的 Provider reasoning round-trip，并运行交接中列出的轻量/定向测试；
随后执行四个已晋升的 process 用例。不要运行真实 Provider，也不要实施当前
RAI-DG-02 草案。修订该提案的 B1-B4 并完成新的独立复审后再请求人工接受。
Windows sandbox 保持 Experimental/Unavailable。
```

## 8. 外部调研结论

- Codex 的 rollout trace 将模型可见 ConversationItem 与 ToolCall、InferenceCall、Compaction、Terminal 等运行时对象分离，并保留信息流边；Arbor 应继续按稳定 ID 关联，不能把“运行时有结果”等同于“模型已经看到结果”。
- OpenCode 将 tool part 独立持久化并显式记录状态；其 doom-loop 防护只能作为启发式，不能替代 Arbor 的 durable exact-revision hold。
- Effect `TestClock` 可把 lease、timeout、retry 等等待改成确定性时间推进；Arbor 已在 P9/provider runtime 部分使用，应优先扩展到纯状态/组件层，而不是在真实进程测试里等待墙钟。
- 模型化/属性测试适合覆盖有限状态组合；真实进程只保留模型找到的最小 crash 反例和公开行为见证。

参考：

- `https://github.com/openai/codex/blob/main/codex-rs/rollout-trace/README.md`
- `https://github.com/openai/codex/blob/main/codex-rs/core/README.md`
- `https://dev.opencode.ai/docs/permissions/`
- `https://effect.website/docs/v4/testing/testclock`
- `https://stately.ai/docs/graph`

