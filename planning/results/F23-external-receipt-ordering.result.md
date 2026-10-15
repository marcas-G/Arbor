# F23 External Receipt Ordering — Implementation Evidence

状态：**此实现切片已修复并定向验证；F23 整体仍 OPEN**

## 合同与修复

依据冻结 DID §4.1B、P1 `01` §3、P1 `03` §3.1、P12 `02` §2 / `10` §3：外部请求完成严格 envelope 解码、Actor/Principal 绑定并通过当前 Resolver 后才调用 CommandGateway；外部路径不得在 Gateway 事务前读取 receipt。Gateway 的 `BEGIN IMMEDIATE` 内 receipt tuple compare 是唯一查找/线性化点，tuple mismatch 的既有 `IdempotencyConflict` 作为 `TerminalRejected` receipt 返回。合同不为 `RetryVerification` 提供 external receipt pre-read 例外。

`makeExternalSubmission` 不再预读 `StoredCommandResolution` 或自行比较 fingerprint/schema/algorithm tuple；普通命令和 `RetryVerification` 均先载入 authority inputs、通过 Resolver，再调用 Gateway。移除专供该绕行路径使用的 `RetryVerificationReceiptReplayAuthority`，不再让重放绕开 Resolver。Resolver 可见性要求及 Gateway 内部 receipt-first / final-authority 顺序保持不变；未改 SQL、schema、receipt tuple 或 design 文档。

## 回归与结果

- F23 功能用例先以一个已 seed 的损坏旧 receipt 和当前无权访问的目标复现顺序差异：修复前返回 409 tuple conflict，未先返回 Resolver denial；修复后返回 HTTP 403 `authority/denied`。receipt 原始 bytes、attempt/event 快照不变，sentinel、raw JSON、旧 fingerprint 均未泄露，daemon errors 为空。
- 授权目标的 tuple mismatch 由 Gateway 返回 HTTP 200 `TerminalRejected` / `IdempotencyConflict` receipt（沿用既有 `receiptToView`）。损坏历史 JSON 未解析；receipt bytes、attempt/event 快照不变，sentinel/raw JSON/fingerprint 未泄露，daemon errors 为空。
- 同文件 exact-tuple corrupt JSON 与 Committed/TerminalRejected wrong-shape 两案继续按安全 corruption Problem fail closed，不改旧 receipt 或副作用。

验证命令及结果：

```text
pnpm build
pnpm exec vitest run apps/single-workspace/test/external-command-composition.test.ts packages/application/test/retry-verification.test.ts
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/f23-receipt-tuple-ordering.functional.test.ts
pnpm typecheck
pnpm exec biome check apps/single-workspace/src/transport/composition.ts apps/single-workspace/test/external-command-composition.test.ts packages/application/src/authority.ts packages/application/src/commands/retry-verification.ts tests/functional/process/f23-receipt-tuple-ordering.functional.test.ts
git diff --check
```

结果：build PASS；unit **2 files / 9 tests PASS**；F23 功能文件 **1 file / 5 tests PASS**；typecheck PASS；Biome 5 files PASS；diff check PASS。首次功能验证在重建 daemon 前使用了旧 bundle，因此复现了旧 409；重建后完整文件 5/5 PASS。未运行全量测试、未改在线数据库。此结果不宣称 F23 全面闭合。
