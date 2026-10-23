# 2026-10-23 隔离验证修复批次整合记录

基线：`16a1709b0c8d8bcede721dcba4b703a8d31321ac`，其上保留 F21 在线 exact replay 提交 `48378e65`、`92713c09`。整合仅在 `f21-online-replay` managed worktree 完成。

## 整合映射

| 来源提交 | 来源改动 | 整合提交 |
|---|---|---|
| `adcb524f0eebb7e4ea40166dc00da8dfd3fc5e4d` | P41 完整主线祖先链 | merge `2f0779a7` |
| `1c9b97ac2a1c667691a312a2e5dc344c0d97bfd4` | V6 fresh execution registry drift 资格用例及记录 | `fb34282c` |
| `9f266177e796d5438ef76fb71c907626139ff030` | V6 stale receipt 无 owned effects 断言加强 | `83ece028` |
| `cbf2342bdc5614977cce89061bee344a38174374` | F21 P10 历史 rebuild fixture 升至 schema 51 | `d789772c` |
| `f6eabd55ee84b4059bf72cf4bcf767741b0f8c19` | F18 exact process crash marker oracle | `7a362eb9` |

整合前逐项核对来源 commit 的父提交、文件路径和实际 diff。最初只 cherry-pick `adcb524f` 得到 `398efe4c`，它只包含 tip 的 P41 结果记录，不包含其祖先中的生产修复、诊断证据及 fixture 测试修正；该 tip-only 挑入不足以代表主线整合。随后按主线拓扑在 `7581d46d` 上执行 `git merge --no-edit adcb524f`，得到 merge commit `2f0779a7085b964f9b95f6304b16a378e469cc15`，父提交为 `7581d46d` 与 `adcb524f`。没有 merge conflict。完整可达的 P41 链为 `15a25677`、`6416295e`、`779ec803`、`15bbdb99`、`adcb524f`；`git merge-base --is-ancestor adcb524f HEAD` 返回 exit 0。最初的 tip-only commit 保留在历史以供审计，不再作为完整整合凭据。其余来源提交按上表各挑入一次，无重复改动。

V6、F21 补测提交只改 process tests/support 与 `planning/results/**` 记录；完整 P41 主线 merge 还带入其 `agent-runtime` recovery implementation、tests 和 fixture diagnostics，未改 `docs/design/**`。V6 P9 terminal proof 保留，fresh drift 走单独 root Work / CandidateRead；stale 命令前后精确比较 owned domain snapshot，oracle 未降低。F21 rebuild 只把历史 seed 经现有 schema-44 → current helper 升级后再用于当前 worker/public query，保留 rebuild 断言。

F18 exact crash-oracle commit 的父提交为完整主线 `adcb524f`，已在主线 merge 后单独挑入。独立 `recent_test_oracle_audit` review **PASS，无 P1/P2**：12 个 boundary 的 lease generation 与 production probe 对应，原业务断言保留，marker 过滤不会吞掉相邻错误。该 review 不等于真实 process qualification。

## 检查状态

- `AGENTS.md` 与 `docs/design/00-problem-goals.md` 已阅读；owner semantics 未改。
- 完整主线 merge 的差异包括 P41 manifest mismatch recovery route、AgentLoop recovery classifier、对应测试及 fixture startup diagnostics；测试补齐提交另只改 V6/F21 tests 与结果记录。没有丢弃任何来源祖先，P41 production recovery 行为随主线完整合并。
- 完整整合后所有改动 TypeScript/MJS 文件的定向 Biome 检查：**PASS**（主线/V6/F21 批 12 files，后续 F18 批 3 files）。
- `git diff 16a1709b HEAD --check`、`git diff HEAD^1 HEAD --check` 与工作区 `git diff --check`：**PASS**。
- F18 crash-oracle lightweight unit file：**2/2 PASS**（`pnpm exec vitest run tests/f18-process-crash-oracle.test.ts`）。F18 organization process cases 仍 **NOT RUN**。
- 不运行全量 typecheck/build、daemon 重型测试或全量扫描；V6/F21/F18 process qualification 仍 **NOT RUN**，待 root 统一串行安排。
