# Arbor 交付收敛清单

更新时间：2026-10-19

## 打勾规则

一项只有在“实现完成 + 模块级检查通过 + 独立复审无阻断”后才标记为完成。全量检查只在各模块局部通过后执行，不用全量套件代替模块检查。

## 已完成

- [x] F23 命令与回执精确绑定基础实现
- [x] AH7 恢复/对账运行时的已授权范围
- [x] Windows 测试进程树清理稳定性修复
- [x] AH19 Work 历史固定窗口与 checkpoint 边界实现、专项测试、独立复审
- [x] 资源感知的分层测试执行器；基线 `pnpm check` 已通过
- [x] Native Sandbox schema 48 设计落地与 post-landing review（实施授权已给出；不代表生产实现完成）
- [x] Native Sandbox Wave C policy/grant 与 decision transaction 路径闭合；T2 五个 provider identity 已集成，均保持 Experimental/empty/Unavailable（详见统一 checkpoint；不代表 T3 或 release 完成）

## 当前执行队列

- [x] VCS 验证证据稳定时间、验收条件快照与迁移 0046
- [x] AH14 旧数据采纳失败时的公开 Attention 与迁移 0047
- [x] AH19 对话历史 checkpoint 唯一所有者与迁移 0048
- [x] F23/P6 当前版本的 owner/parent 路由和 Inbox 重建治理结论
- [x] F23/P6 operator-only 离线 Inbox 重建实现、模块资格与独立复审
- [ ] AH10 剩余控制动作的崩溃恢复闭合
- [ ] Sandbox Policy Candidate Read Model V5-A：实施 token `AUTHORIZE_SANDBOX_POLICY_CANDIDATE_READMODEL_V5_IMPLEMENTATION` 已给出；固定计划 v2 Git blob SHA-256 为 `B99C2682F30F277AA9E3C7C135E4A8A2C5C5811C3B44C380604ABB3B6F1CC3B9`。V5-A 基础代码已并入统一候选并通过 4 文件/45 测试、build、typecheck、Biome、diff check；待独立复审后按打勾规则关闭。P5/P4/P2/P1/P10/P13、生产注入和双 daemon 资格为后续切片，不在本次 V5-A 完成声明内。
- [x] Sandbox Policy Candidate Read Model V5-B P2 pre-dispatch gate：TrustedLocal/OsEnforced 的完整 V2 bundle 当前性于 lease/dispatch 前核对；13/13 模块测试、build/typecheck/Biome 与独立复审 B0/B1/B2=0，见 `planning/results/sandbox-policy-candidate-readmodel-v5-b-integration-review.record.md`。P4 最终 effect gate、双 daemon 与其余 V5 切片仍开放。
- [ ] Sandbox Policy Candidate Profile Binding Digest V6：授权的 A–C 已并入统一候选，每个 candidate 独有 handle-binding digest 的 DTO 与 P10/P11 同一事务投影已通过 V6 52/52、P2 13/13、D0/P4 104/104、架构 192/192 及 build/typecheck/Biome。独立源码复审 B0/B1/B2=0；统一集成时另修正 Supported tuple 的完整 D0 rule-set digest 核对，待该集成增量独立复审后依打勾规则关闭 A–C。D Web 选择已单独通过；真实双 daemon 的 E 和最终 F 仍开放；见 `planning/results/sandbox-policy-candidate-profile-binding-digest-v6-a-c-integration-review.record.md`。
- [x] Sandbox Policy Candidate Profile Binding Digest V6-D Web 选择：47/47、Web typecheck/build 与独立复审 B0/B1/B2=0；Human 显式选择、TrustedLocal 单独确认、旧 CAS 拒绝后的整表刷新/重选已并入，见 `planning/results/sandbox-policy-candidate-profile-binding-digest-v6-d-integration-review.record.md`。V6-E/F 及总体闭合仍开放。
- [ ] Windows native sandbox T3 测试/固定工件 checkpoint：AppContainer/Job/ACL/network 探针、只读工件检查已并入；Windows 19/19、D0/P4 104/104、架构 192/192 通过。生产 `run` 仍未接入，Windows provider 保持 Experimental/empty/Unavailable；Disabled 网络精确拒绝、全生命周期文件边界、broker、签名及 T3 正式资格仍开放，见 `planning/results/native-os-sandbox-windows-t3-checkpoint-integration.record.md`。
- [ ] Native OS sandbox 生产实现与跨平台资格：Wave D 仍 PARTIAL；待 production `sandboxProcessPolicy` wiring 与真实 SQLite 双 daemon 资格。V3/high-water V2/candidate-read V5 owner landing 的独立 post-landing review 已 PASS（B0/B1/B2 = 0），记录见统一 checkpoint 引用的 review result。首决策 V5 已人工接受并落地；T3 enforcement qualification 未开始。T2 provider reviews 有 thread-local scoped PASS 记录，正式复审证据待落盘。

## 最终集成检查

- [ ] 在全新数据库验证迁移 0045 → 0050
- [ ] 运行最终 `pnpm check`
- [ ] 运行最终 `pnpm test:functional`（真实进程与浏览器）
- [ ] 用真实用户流程验证 S1–S4，并做重启恢复
- [ ] 补齐使用、升级、故障恢复说明和最终证据
- [ ] 同步最终提交到 GitHub

## 当前状态

F23/P6 operator-only 离线 Inbox 重建实现、模块资格与独立复审已合并到 `HEAD 1300bfda`，B0/B1/B2 均为 0。最终定向矩阵：P6 operator 6/6、P39 security 7/7、schema filtered 3/3、cleanup 3/3。资格仅覆盖 operator-only 离线 rebuild；没有 public route，也不构成 release/full-suite 声明。VCS/0046、AH14/0047 与 AH19 Conversation/0048 已完成实现、独立审查和主线合并检查；Native Sandbox 代码候选为 `28907165738d48cd3bc24226b003fc42665a3a2a`，其后有 docs-only owner landing `7ad5c19a3e9eff0a5da33b25d228f0e22dff2643` 与 post-review record `c1c4371a`；schema 目标为 50。Conversation owner 现以 immutable HumanMessage 加 Job/Attempt/Execution 权威证明推进 frontier，owner 与 Work Session epoch 分离。AH10 已闭合 P8 两项验证动作、全部 SendMessage 类型、direct-child AssignWork target binding，以及 ProposeWorkspace/UpdatePlan/ClaimCompletion 的持久效果边界；冻结 EGP 使用同一 Agent Loop，AH10 exit 按 durable handler/action path 与确实独立的 runtime boundary 计算，不要求 Profile×Episode 笛卡尔积；AH10 仍待当前 HEAD 最终全量门禁后勾选。Native Sandbox Wave C transaction 路径已闭合，Wave D 为 partial；production policy wiring 与 SQLite 双 daemon 仍开放。Producer Mapping V3、高水位 V2 amendment 和 candidate-read V5 已接受并 landed；其独立 post-landing review 已 PASS（B0/B1/B2 = 0），记录见 `planning/results/native-os-sandbox-v21-producer-and-candidate-read-postlanding-review.result.md`。T2 五个 provider identity 已集成但全部保持 Experimental/empty/Unavailable；T3 和 release/full-suite qualification 未完成。POSIX/Windows provider review 仍为 thread-local scoped evidence，full-suite 与 release qualification 未完成。最终集成检查各项保持未勾选。
