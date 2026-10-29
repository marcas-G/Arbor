# AH14 旧成功证据接管 — 进程崩溃资格进度

日期：2026-10-05

状态：**PARTIAL；正向等价 fixture 两侧 PASS，负向持久 Attention 仍 RED。**

`tests/functional/process/agent-loop-ah14-legacy-adoption-crash.functional.test.ts`
先用真实 daemon 在 Provider 成功提交后、Step 可用前杀进程，形成
完整 CanonicalProviderEvents、已结算 Turn、Prepared Step、零 sourced
输出的隔离 fixture。测试仅把这份隔离数据库的 success evidence version
置为旧版 null，模拟受 P9 §3 授权的等价 legacy 记录；不修改保存的 dogfood
数据库。第二个进程分别在旧证据升级与 Step 转移的原子事务前/后杀停。

两侧均证明：事务前是旧证据 + Prepared；事务后是升级证据 +
ProviderResultAvailable；正常重启后同一 Step 到 SettlementProposed、
只有一条 sourced AssistantMessage、一条公开回复、一次目标 Provider 请求；
再重启后上述持久状态不变。定向测试 **2/2 PASS**。

负向测试 `tests/functional/pending/ah14-ambiguous-legacy-attention.functional.test.ts`
使用含动作而无 disposition 的旧成功证据；真实进程重启后公开
`attention` 视图一直为空，**RED**。P9 §3 的“持久 Attention”与 P10
封闭的六来源词表之间存在 `AH14-DG-01`，见
`planning/proposals/AH14-legacy-adoption-attention-decision-draft.md`。
未接受裁决前，不把 AH14 判为通过，也不在 `docs/design/**` 或产品
Runtime 中自创 Attention 语义。
