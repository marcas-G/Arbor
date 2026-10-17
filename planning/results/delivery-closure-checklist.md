# Arbor 交付收敛清单

更新时间：2026-10-18

## 打勾规则

一项只有在“实现完成 + 模块级检查通过 + 独立复审无阻断”后才标记为完成。全量检查只在各模块局部通过后执行，不用全量套件代替模块检查。

## 已完成

- [x] F23 命令与回执精确绑定基础实现
- [x] AH7 恢复/对账运行时的已授权范围
- [x] Windows 测试进程树清理稳定性修复
- [x] AH19 Work 历史固定窗口与 checkpoint 边界实现、专项测试、独立复审
- [x] 资源感知的分层测试执行器；基线 `pnpm check` 已通过

## 当前执行队列

- [x] VCS 验证证据稳定时间、验收条件快照与迁移 0046
- [x] AH14 旧数据采纳失败时的公开 Attention 与迁移 0047
- [ ] AH19 对话历史 checkpoint 唯一所有者与迁移 0048
- [ ] F23/P6 当前版本的 owner/parent 路由和 Inbox 重建治理结论
- [ ] AH10 剩余控制动作的崩溃恢复闭合
- [ ] Native OS sandbox 生产实现与跨平台资格

## 最终集成检查

- [ ] 在全新数据库验证迁移 0045 → 0048
- [ ] 运行最终 `pnpm check`
- [ ] 运行最终 `pnpm test:functional`（真实进程与浏览器）
- [ ] 用真实用户流程验证 S1–S4，并做重启恢复
- [ ] 补齐使用、升级、故障恢复说明和最终证据
- [ ] 同步最终提交到 GitHub

## 当前状态

VCS/0046 与 AH14/0047 已完成实现、独立审查和主线合并检查；主候选数据库版本为 47。AH10 已闭合 P8 两项验证动作、全部 SendMessage 类型、direct-child AssignWork target binding，以及 ProposeWorkspace/UpdatePlan/ClaimCompletion 的持久效果边界；相应最终回归和独立复审均已合入主线。旧记录中的 direct-child C/P 与 Deliver gap 已被后续接受合同和资格结果取代。冻结 EGP 使用同一 Agent Loop，AH10 exit 按 durable handler/action path 与确实独立的 runtime boundary 计算，不要求 Profile×Episode 笛卡尔积；当前只待最终 current-HEAD 全量门禁后打勾。AH19 Conversation/0048 已完成迁移、owner store 和投影第一层，但发现 P17 权威来源冲突，当前等待人工接受已复审通过的 reconciliation proposal。后续严格按上面的顺序逐项完成和打勾。
