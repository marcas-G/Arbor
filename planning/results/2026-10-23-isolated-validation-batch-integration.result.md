# 2026-10-23 隔离验证修复批次整合记录

基线：`16a1709b0c8d8bcede721dcba4b703a8d31321ac`，其上保留 F21 在线 exact replay 提交 `48378e65`、`92713c09`。整合仅在 `f21-online-replay` managed worktree 完成。

## 整合映射

| 来源提交 | 来源改动 | 整合提交 |
|---|---|---|
| `adcb524f0eebb7e4ea40166dc00da8dfd3fc5e4d` | P41 分段进程证据结果记录 | `398efe4c` |
| `1c9b97ac2a1c667691a312a2e5dc344c0d97bfd4` | V6 fresh execution registry drift 资格用例及记录 | `fb34282c` |
| `9f266177e796d5438ef76fb71c907626139ff030` | V6 stale receipt 无 owned effects 断言加强 | `83ece028` |
| `cbf2342bdc5614977cce89061bee344a38174374` | F21 P10 历史 rebuild fixture 升至 schema 51 | `d789772c` |

整合前逐项核对来源 commit 的父提交、文件路径和实际 diff。`adcb524f` 的 P41 结果文件在隔离基线中不存在，因此 cherry-pick 报 modify/delete；按来源提交内容将该结果记录作为新增文件保留。其余提交无冲突。来源提交没有被隔离树祖先包含；按上表各挑入一次，无重复改动。

变更限定于 process tests 与 `planning/results/**` 记录，没有 production 或 `docs/design/**` 变更。V6 P9 terminal proof 保留，fresh drift 走单独 root Work / CandidateRead；stale 命令前后精确比较 owned domain snapshot，oracle 未降低。F21 rebuild 只把历史 seed 经现有 schema-44 → current helper 升级后再用于当前 worker/public query，保留 rebuild 断言。

## 检查状态

- `AGENTS.md` 与 `docs/design/00-problem-goals.md` 已阅读；owner semantics 未改。
- 改动 TypeScript/MJS 文件的定向 Biome 检查：**PASS**（4 files）。
- `git diff 16a1709b HEAD --check` 与工作区 `git diff --check`：**PASS**。
- 不运行全量 typecheck/build、daemon 重型测试或全量扫描；当前资格测试均 **NOT RUN**，待 root 统一串行安排。
