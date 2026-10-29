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
| `5438ef8c2a79a44405c7bb6858e5f26b7f96f592` | 唯一主索引更新（delivery convergence matrix） | `9e594220` |
| `16785463186e71845a4dbddd0d16f9b32b69d2d7` + `09f644a85f7567618178616116b2003af078a347` | AH7 pending-intent failure diagnostics；ToolResult `callRef` JSON exact match | merge `c9862404` |
| `4ebd8804` + `79cfcbed` + `f0d06bc2` + `166c2341` + `de8d44c5944c904e49d20844fe9b97bdb5d10951` | real-public-S1 full process harness range | merge `2fdad3de` |
| `e70c423a0b03e703f599fc261dde6dde9093df68` | P9 direct-control gen1 lease-timeout diagnostics | merge `3d2341ed` |
| `bd7cd924b10fbb0ab96e7e845f136de15841ce75` | safe port-handshake diagnostic helper and unit tests | merge `d2902411` |
| `53c36a77a2e1c07ba72989e18b01c90003f49f67` + `c69e87c79ff1c8f80672cec49b4776aa7e0e1ef4` | real-public-S1 WorkEpisode role guidance and durable self-wait diagnosis | merge `d4640d36` |
| `a8aaf6d3c9a5445c48968a6e952c45a26f2cc547` | safe readiness-failure evidence completion | merge `ddacaab7` |
| `9b19b224d444dc2bee0b6adae9a363715d91e9a8` | P9 delayed old-generation lease renewal test fixture | merge `8129e483` |
| `55a7b89bf6996ad4479e1e7f5b864bd350b7a5f0` | 脱敏 real-public-S1 qualification record | merge `7643956e` |
| `0721d984ee48094cc272a2a84e41702e8c2ef77e` + `b03ba50795c70b2b07a09bcbe64843f5885a1bde` | F18 per-case budget/deadline and late-write containment | merge `303820b4` |
| `2b04cb75286eed7de717a9b310e7e557a84c1739` | F21 online replay canonical receipt assertion repair | `2b04cb75` |
| `bf86b8848d87e6157fbe8fee8f289012ef466709` | safe handshake error cause normalization | merge `7ac920c2` |
| `68fab54cabefd5b583d2cad1e80e64e0563ced76` | isolated functional qualification sweep record | fast-forward |
| `dfa8139e` + `8c67f364` + `27cf6d5b66010d6957ee6c942071bb8d3b078353` | S2 shared public real-journey harness and evidence-root readiness | merge `1de70e89` |
| `e33a7f25fb98a746b238b4f35758488d9d253caa` | S4 public recovery journeys based on current shared helper | merge `1922a401` |
| `3e43fb4086c64e1e7d393d8f90a3834d6fdc7993` | S3 permission recovery journey against current shared helper | cherry-pick `44bc1522` |

整合前逐项核对来源 commit 的父提交、文件路径和实际 diff。最初只 cherry-pick `adcb524f` 得到 `398efe4c`，它只包含 tip 的 P41 结果记录，不包含其祖先中的生产修复、诊断证据及 fixture 测试修正；该 tip-only 挑入不足以代表主线整合。随后按主线拓扑在 `7581d46d` 上执行 `git merge --no-edit adcb524f`，得到 merge commit `2f0779a7085b964f9b95f6304b16a378e469cc15`，父提交为 `7581d46d` 与 `adcb524f`。没有 merge conflict。完整可达的 P41 链为 `15a25677`、`6416295e`、`779ec803`、`15bbdb99`、`adcb524f`；`git merge-base --is-ancestor adcb524f HEAD` 返回 exit 0。最初的 tip-only commit 保留在历史以供审计，不再作为完整整合凭据。其余来源提交按上表各挑入一次，无重复改动。

V6、F21 补测提交只改 process tests/support 与 `planning/results/**` 记录；完整 P41 主线 merge 还带入其 `agent-runtime` recovery implementation、tests 和 fixture diagnostics，未改 `docs/design/**`。V6 P9 terminal proof 保留，fresh drift 走单独 root Work / CandidateRead；stale 命令前后精确比较 owned domain snapshot，oracle 未降低。F21 rebuild 只把历史 seed 经现有 schema-44 → current helper 升级后再用于当前 worker/public query，保留 rebuild 断言。

F18 exact crash-oracle commit 的父提交为完整主线 `adcb524f`，已在主线 merge 后单独挑入。独立 `recent_test_oracle_audit` review **PASS，无 P1/P2**：12 个 boundary 的 lease generation 与 production probe 对应，原业务断言保留，marker 过滤不会吞掉相邻错误。该 review 不等于真实 process qualification。

主索引更新 `5438ef8c` 原样从 `adcb524f` 挑入，只改变 `full-delivery-convergence-matrix-2026-10-20.md`。索引最初记录的 `d5f4928d` build PASS / daemon startup in progress 是当时的中间观测，不作为终态证据覆盖；其终态仍是 Vitest **1 failed / 499.8s**，公开交互到 `Answered` 但没有 Work approval。旧 prompt 包含 `claim_completion`，Root 将缺文件工具误判为 no executor。早期 `early-aborted` 分类已更正。原 fixture/capture 后续缺失，仅私人 `real-s1-failure-evidence.json` 留有公开问答和 2 个 HTTP 200 观测，不能声称完整留证。后续 bounded S1 PASS 已通过 `55a7b89b` 结果记录同步：test SHA `c69e87c7` / runtime SHA `53c36a77`，1/1 PASS、重启后新增 Provider 调用为 0。索引明确该 source pair 不是 main `d89103d` 的同 SHA 全 gate，也不是 S1–S4 release qualification。索引 audited candidate 仍记录为 `adcb524f`；候选 `a33040e9`、`ae2630ea` 及当前整合线均未继承 adcb 的完整 build/functional/release qualification。

AH7 pending-intent diagnostics 以完整 range 整合：`git log adcb524f..09f644a8 --oneline` 给出 `16785463` 和 `09f644a8` 两笔；在候选上普通 merge 得到 `c9862404`，父提交为 `41218ea3` 与 `09f644a8`。来源 range 的 diff 仅涉及 `tests/functional/process/agent-action-ah7-pending-intent.functional.test.ts`。首笔补充按项目/Execution/callRef 限定的一致快照与启动失败归档上下文；次笔移除 SQL `LIKE` 子串匹配，改为解析 `ToolResult` JSON 并 exact 比较 `callRef`。生产和设计文件未改，AH7 原资格断言未改；该 change set review 无 B1。AH7 重型 process qualification 仍 **NOT RUN**。

real-public-S1 按完整 source branch merge：相对隔离候选 `ae2630ea` 的提交链为 `4ebd8804`、`79cfcbed`、`f0d06bc2`、`166c2341`、`de8d44c5`，中间保留其 `adcb524f` merge。普通 merge 为 `2fdad3de`，无冲突。改动包含 opt-in public real-provider S1 lifecycle、Root Work routing/prompt 与 control-catalog 文案、versioned provider completion matcher、journey deadline、capture hook 和支持测试。Root v7 `assign_work` 说明已有独立 review。d5 尝试的终态为上文记录的 1 failed / 499.8s，完整 fixture/capture 未留存。之后完整整合 `53c36a77` production 与 `c69e87c7` test 两笔；结果记录 `55a7b89b` 由 merge `7643956e` 引入，证明一个 bounded real-provider lifecycle slice 1/1 PASS、14 个 Provider 请求均为 HTTP 200，restart 后 Provider request count 仍为 14。该 PASS 对应 source test/runtime pair，不是 main `d89103d` 同 SHA 全 gate，也不完成 S1–S4。

P9 direct-control diagnostics `e70c423a` 的父提交为 `ae2630ea`；普通 merge `3d2341ed` 仅引入 process test、AH10 child test-support probe 与诊断结果记录，没有 production runtime 改动。原 gen1 45 秒等待和成功/拒绝语义断言保留，诊断增加失败快照；相应 P9 process case **NOT RUN**。

Port-handshake diagnostics `bd7cd924` 的父提交为 `ae2630ea`；普通 merge `d2902411` 仅改 process test-support classifier/helper 并新增三条小单测，无 production runtime 改动。所有 `safeHandshakeFailure` 路径复用严格前缀分类；wrong-port 只保留 validated numeric ports，不序列化 error cause。拒绝/停止断言保持。独立 review **PASS，无阻断**；新增小单测尚未运行。

F18 per-case budget/deadline 以完整 range 整合：`0721d984` 和 `b03ba507`，普通 merge `303820b4`，仅修改 `tests/functional/process/organization.functional.test.ts`。独立 review 确认 665.5s 外层耗时可由现有 setup/wait budget 解释，不是冻结业务 SLO；b03 将 PublicClient 和轮询绑定同一 case deadline，并将 `afterEach` 置为 closed 以阻止 late write，不改 lease、内层等待或业务断言。定向 Biome 与 diff PASS；F18 crash-oracle + public-client deadline unit 共 3/3 PASS。F18 第二 process case 保留给 `remaining_functional_sweep`。

S2/S3/S4 source integration 全部建立在 shared real-journey helper `27cf6d5b` 上：S2 range `dfa8139e` / `8c67f364` / `27cf6d5b` 包含 test-only capture gate、deadline 与 evidence-root helper 和 S2 test；recent oracle audit 已确认 gate 默认透明、未 arm 时不延迟响应，canonical evidence-root same-path修复已在27cf。S4 `e33a7f25` 的 parent 正是27cf，新增 S4 test file only。S3 owner 的来源树将 8c67/27cf 重放为等价 commits；其 final `3e43fb40` 只改 S3 test file。候选 helper blob 与27cf精确相同（`02e29505d6d919ec32c7f82e78f40c4bda57e9778`）；为避免导入重复/旧 helper history，最终 S3 test commit作为单文件变更cherry-pick到共同helper候选，缺失路径冲突时保留了与来源commit blob完全相同的最终测试文件。S3/S4均不改生产Role/API。

S3/S4 owners 的来源类型检查均报告 PASS；candidate 在最终整合后也完整运行 `pnpm build` 与 `pnpm exec tsc -p tsconfig.test.json --noEmit --pretty false`，两者 exit 0。候选相对 `44f3cc39` 的9个改动 TypeScript/MJS 文件 Biome PASS、diff check PASS；6项轻量测试实际执行为5 files/18 tests PASS（默认 Vitest 配置忽略 public-real opt-in目录），CRAC architecture 4/4 PASS。Readiness owner另报告 evidence-root 4个path cases PASS。没有设置 real-provider opt-in、发送请求或运行 S2/S3/S4 daemon journey；这些仅为实现与类型/静态核对，不是场景资格。

F21 在线 replay 的 `46d811b7` 首轮失败与修复已在候选整合。唯一失败是 raw JSON 命令成功后，对 canonical receipt 与 HTTP envelope 形状断言错配；命令仍 HTTP 200，持久结果 `result_json` 仅为 result。修复 `2b04cb75` 使用持久 `command_id`/resolution/result 构造 canonical receipt，只精确比较响应 `body`，并保留 same-command、receipt stability、同 PID、`[Pending, Active]` event、单 ownership、Attention 清除和 Provider 计数断言。result record 将首轮列为 oracle mismatch failed，修复后 online daemon case **NOT RUN**，留给 sweep；这不是资源恢复问题的失败证据。此改动仅 test 与 result record。

Safe handshake error normalization `bf86b884` 以完整单提交范围整合（source base `46d811b7`），merge 为 `7ac920c2`，只改 functional test-support 与 handshake unit file。它沿 cause chain 限深查找最具体已知分类，仅保留经过校验的 port/readiness numeric 字段；不序列化 Error cause，不改变 lifecycle rejection/stop 逻辑。独立 review PASS 无阻断；`handshake-diagnostic.test.ts` 8/8 PASS。候选相对 `46d811b7` 无 production/runtime 路径改动。

`68fab54c` sweep 记录以 fast-forward 整合（只新增 sweep 文档）。候选完整 `tsconfig.test.json` typecheck 首轮只报一项：`organization.functional.test.ts:740` 读取不存在的 `ProductionFixture.httpPort`。修复从既有 `started.baseUrl` 提取实际监听端口 `Number(new URL(started.baseUrl).port)`；不扩展 fixture/runtime API、不用 `as any` 或过滤错误。完整重跑 `pnpm exec tsc -p tsconfig.test.json --noEmit` exit 0，未报 V6 diagnostic 类型错误。相关 organization 测试 Biome PASS，diff check PASS。root `pnpm build` exit 0；dist 存在且相对 46 的 production source 没有差异。F21 online daemon case 尚未重跑，保持待 `remaining_functional_sweep`。

没有合入 nativehelper 分支；其安全红测仍待处理。S1 变更了 production prompt/control catalog assets；当前候选含此前已验证的 BaseLoop v2 源码，后续 S2/S3/S4 变更仅在 test/support/config，未改生产Role。

第三批源码完整合并后的 build 与定向验证已在候选 `8129e483` 执行：root `pnpm build` exit 0；Web `pnpm --filter @arbor/web build` exit 0，存在 >500 kB chunk 提示。root `main.js` 与 Web `index.html` dist 均存在，但产物存在不等于资格。六个轻量单测文件 16/16 PASS（handshake、安全 F18 marker、Root Work routing、provider capture path、public-client deadline、S1 wait diagnosis）；定向 CRAC architecture 4/4 PASS；相对 `d89103d` 的 10 个 TS/MJS 文件 Biome PASS、diff check PASS。之后 `55a7b89b` / `7643956e` 只增加/合并资格结果记录和状态矩阵文档，未改源码。完整 typecheck、`pnpm check`、functional/daemon suite 均未运行。

脱敏结果记录 `real-public-s1-lifecycle-qualification-20261023.result.md` 已整合。记录将 public commands/views 和 isolated filesystem assertion 定为 primary lifecycle oracle，并将 ReadOnlySQLite auxiliary assertion 标注为辅助证据。source pair `c69e87c7` / `53c36a77` 的运行结果限定为该 bounded slice；main `d89103d` 与该 pair 不是同 SHA。候选在记录合入前已于 `8129e483` 完成 root/Web build 和定向单测；`model-decision.ts` / `prompt-assets.ts` 与 `53c36a77` blob 完全相同，`control-catalog.ts` 与 `de8d44c5` blob 完全相同。这支持生产源码关联，但不等于同 SHA 的完整功能或 release gate。

Readiness evidence `a8aaf6d3` 只扩展 test-only safe handshake classifier 与失败归档测试，原拒绝/停止语义断言保持；相关轻量单测包含在上述 16/16 中。P9 renewal-pause fixture `9b19b224` 只改测试/诊断结果记录并设置旧 gen0 lease renewal pause gate，未改生产代码；来源独立 review PASS，process case 尚未运行。候选没有合入 P39 lock-scope 或 nativehelper 专项分支。

## 检查状态

- `AGENTS.md` 与 `docs/design/00-problem-goals.md` 已阅读；owner semantics 未改。
- 完整主线 merge 的差异包括 P41 manifest mismatch recovery route、AgentLoop recovery classifier、对应测试及 fixture startup diagnostics；测试补齐提交另只改 V6/F21 tests 与结果记录。没有丢弃任何来源祖先，P41 production recovery 行为随主线完整合并。
- 当前候选相对 adcb 的全部改动 TypeScript/MJS 文件定向 Biome 检查：**PASS**（24 files）。
- `git diff 16a1709b HEAD --check`、`git diff HEAD^1 HEAD --check` 与工作区 `git diff --check`：**PASS**。
- F18 crash-oracle lightweight unit file：**2/2 PASS**（`pnpm exec vitest run tests/f18-process-crash-oracle.test.ts`）。F18 organization process cases 仍 **NOT RUN**。
- `5438ef8c` 主索引文档 cherry-pick：仅该 Markdown 文件，diff check 后整合；候选 qualification 仍按精确 SHA 隔离。
- AH7 pending-intent 文件来源 typecheck/Biome 据提交方报告 PASS；本次定向 Biome 1 file **PASS**、`git diff adcb524f HEAD --check` / 工作树 diff check **PASS**。F18 crash-oracle lightweight unit file 在当前候选重跑 **2/2 PASS**。AH7 process qualification **NOT RUN**。
- 当前候选未运行全量 `pnpm check`、functional/daemon suite 或全量扫描。V6/F21/F18/AH7/P9/real-S1/port-handshake process qualifications 仍需按精确候选与结果记录核对；较早 d5 S1 的 terminal-fail 不是通过资格。c69/53c 的第三次 real S1 仅为来源报告的独立 1/1 PASS，脱敏记录 SHA 待补，不能扩展成当前候选同 SHA 的 full gate。
