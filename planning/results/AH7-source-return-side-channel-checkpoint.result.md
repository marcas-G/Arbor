# AH7 source-return side-channel 修复 checkpoint

状态：**test-harness 修复与本文件资格通过；不构成 AH7 阶段闭合或生产行为变更。**

基线：`40f9799f`。test-harness commit：`bf15f8b0d891a32d52d39d23f968e4e152b8ac8b`。修改范围仅限 AH7 functional test 与进程测试夹具。

## 修复

- 统一 JSONL append helper 在写入前递归创建 gate 目录，覆盖普通 resource-change reconciliation 路径。
- `recordSourceReturn` 在追加 side-channel 记录前将 adapter stage 精确设为 `append-source-return-side-channel`；post-gate mutation 完成后将 stage 更新为 `prepare-reconciliation-result`。
- adapter 和 source-return side-channel 写入错误会将原始错误写入 stderr，并尽力追加结构化错误记录后返回原始 reconciliation error。
- source-return side-channel 是返回可见性的权威测试证据；SQLite `returned_at` 仅作异步 best-effort 辅助记录。
- failure archive 在 fixture 目录改名前捕获依赖原路径的诊断快照，改名后写入归档目录。

## 资格

- `pnpm typecheck`：PASS。
- Biome：两个修改的 harness 文件 PASS。
- `git diff --check`：PASS。
- 精确过滤：resource snapshot recovery、plain takeover、`attemptNo` mismatch、`visibilityScopeSha256` mismatch，4/4 PASS；retry 0、bail 1、no-file-parallelism。
- 完整 `agent-action-ah7-reconcilable.functional.test.ts`：25/25 PASS，Vitest 单 worker、no-file-parallelism、retry 0、bail 1；耗时 1810.33 秒。

此前完整文件首次运行因普通 resource-change 路径没有创建 `ah10-gates` 而失败。中央 append helper 加入目录创建后，失败场景独立复跑通过，随后完整文件 25/25 通过。

此 checkpoint 只覆盖本文件列出的 test-harness 路径，不扩展为 AH7 crash/replay/concurrency 总体资格，也不修改 production 或 `docs/design/**`。
