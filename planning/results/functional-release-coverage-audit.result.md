# 发布功能旅程逐项证据审计

日期：2026-10-04

状态：**F01–F20 的限定判定通过；F21–F23 为独立红灯；不宣称发布就绪。**

`b4c0fd6` 上 `pnpm test:functional` 通过：公开进程 24/24（含 AH1–AH6）、
Playwright 2/2、零重试。F02 的 Human/Assistant 两条权威转录断言已包含在
本批次。默认 `pnpm check` 同提交全绿：
架构 155、核心 1677 + 3 skipped、Web 216。F21–F23 在单独 pending 配置中
运行并保持真实失败，不被 skip 或伪装成通过。

| 旅程 | 公开证据所在测试 | 当前证明范围 / 缺口 |
|---|---|---|
| F01 | `tests/capability/black-box/s1-s4-public-api.test.ts` | Project 与父子责任树可见，PASS |
| F02 | 同上 | Human 与 Assistant 均进入权威转录，PASS |
| F03 | 同上 | Inbox 暴露 exact approval，Work 尚未创建，PASS |
| F04 | 同上 | 批准后 Current Work 为 Open 且含目标，PASS |
| F05 | 同上 | PASS 前不自动完成、Acceptance 可见、当前选择清空；Completed 终态须由 F22 证明 |
| F06 | 同上 | 验收证据重启后仍可读、Provider 未重放；Completed 终态须由 F22 证明 |
| F07 | `tests/functional/process/human-steer.functional.test.ts` | Work revision 递增，后续模型请求含纠偏文本，PASS |
| F08 | `tests/functional/ui/project-conversation.spec.ts` | 浏览器创建项目及 Human/Assistant 回合可见，PASS |
| F09 | 同上 | 硬重启后回合保留且无 Provider 重放，PASS |
| F10 | `tests/functional/process/recovery-verdicts.functional.test.ts` | 拒绝审批后无 Work，用户见纠正答复，PASS |
| F11 | 同上 | 一次 503 后两次 Provider 调用、单条权威回复，PASS |
| F12 | 同上 | 独立 Fail、有证据、Work 仍 Open 且无 Acceptance，PASS |
| F13 | 同上 | 独立 Unknown、有证据、Work 仍 Open 且无 Acceptance，PASS |
| F14 | `tests/functional/ui/approval-completion.spec.ts` | 浏览器凭公开待处理项批准，无需用户复制 ID，PASS |
| F15 | 同上 | 浏览器看到 PASS 待验收并提交 Acceptance；Completed 终态须由 F22 证明 |
| F16 | `tests/functional/process/recovery-verdicts.functional.test.ts` | Provider wire 完成后崩溃，重启只见一条回复，Provider 重试 1–2 次，PASS（不宣称精确命中持久化 handoff 缝隙） |
| F17 | 同上 | 三页历史可达、六条记录不重复，PASS |
| F18 | `tests/functional/process/organization.functional.test.ts` | 子 Workspace 初始 Work 经独立 PASS、父级 Acceptance、当前选择清空；Completed 终态须由 F22 证明 |
| F19 | `tests/functional/process/cross-work-delivery.functional.test.ts` + `cross-work-wake.functional.test.ts` | 先交付后声明与先等待后交付均精确满足依赖，后者唤醒消费者，PASS |
| F20 | `tests/functional/package/clean-checkout.functional.test.ts` | 从已提交 HEAD 冷克隆、冻结安装、构建、公开黑盒 4/4，PASS |
| F21 | `tests/functional/pending/ui-project-resource.spec.ts` + `resource-admission.functional.test.ts` | RED：浏览器缺可信文件挂载；未登记自由路径却被 Committed；`FT-DG-01` |
| F22 | `tests/functional/pending/completed-work-visibility.spec.ts` | RED：公开验收与硬重启后原 Work 链接显示“未找到该工作”；`FT-DG-02` |
| F23 | `tests/functional/pending/command-input-validation.functional.test.ts` | RED：非法 MessageId、错误前缀 AcceptanceId 均被 Committed；`FT-DG-03` |

测试通过只证明表中写明的判定。特别是 Current Work 消失不等于公开可观察的
`Work.lifecycle = Completed`，浏览器“待处理”清空也不等于完成；不得把 F05/F06/
F15/F18 的 PASS 代替 F22。F16 不证明 Provider 成功已经落盘后的特定故障窗口；
功能旅程只证明用户可见去重与有界重试。`docs/design/implementation/P9/07-agent-loop-step-recovery.md`
还要求 AH1–AH14 每个实际提交边界两侧的 crash injection。AH1–AH6 现已
真实进程资格 PASS，但 AH7–AH14 仍未闭合；不能用 F16 或 AH1–AH6 绿灯抵销。

剩余动作：等待三份固定治理提案分别被人工接受，按所属文档落地，再让 F21–F23
从 pending 迁入正式门禁并全量复测；并按既有授权补齐其余 AH crash 矩阵。
未获接受前不能降低测试判定或按错误提示做局部绕行。
