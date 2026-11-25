# 2026-11-15 真实模型权限拒绝阻断与恢复复验

## 范围

本次只验证一个窄范围行为：真实模型调用文件工具时，写入被权限拒绝后，
Work 是否进入用户可见的阻断状态；阻断是否跨重启保留；用户授权后是否能
继续真实写入。它不替代命令执行、构建、测试或正式发行资格。

## 发行物与环境

- 发行物：`/home/lgao/.local/share/Arbor/release-preview-builds/prompt-blocked-20261115/arbor-0.0.0-preview-e75ea7672db7-7166d262-linux-x64.tar.gz`
- SHA-256：`b034cf47b00d71f3e220acd55c1b02ca1b3fa0e586a3629fdb4d1098526810fc`
- buildId：`sha256:e75ea7672db77e28fe64e361e9b7bba8b708b4861530077243440a5480798807`
- Provider：外部真实 OpenAI-compatible Provider，模型 `gpt-6.1-sol`
- 业务操作：浏览器页面和公开 HTTP/WS 边界；没有使用内部数据库接口代替用户操作
- 脚本：`.test-results/real-final-file-tools-prompt-20261115/verify.mjs`
- 结果：`.test-results/real-final-file-tools-prompt-20261115/result.json`
- 对齐后脚本：`.test-results/real-final-file-tools-aligned-20261115/verify.mjs`
- 对齐后结果：`.test-results/real-final-file-tools-aligned-20261115/result.json`

## 结果

通过的事实：

1. 首次配置真实模型、连接检查、自动重载和真实项目目录选择通过。
2. `glob`、`grep`、`read` 真实调用成功。
3. `write` 被 `InvocationAuthorityDenied` 拒绝，目标文件没有创建。
4. 新 canonical prompt 使真实模型选择 `wait(disposition: Blocked)`；页面显示
   “本轮执行已阻断”，没有继续重试或声称完成。
5. 停止并重启 daemon 后，阻断状态仍然存在。
6. 用户通过浏览器授予当前 Work 的限时文件权限并提交补充指导后，真实模型创建
   了目标文件，内容实际落盘为“标记加一个换行”。

第一次复验没有通过完整旅程：独立 Verification 将“标记加换行”的实际文件与
此前生成的“内容严格为标记、没有换行”的验证标准比较，人工验收按钮保持禁用。
这暴露的是验收脚本初始任务标准与后续指导之间的内容约束不一致。

随后只把两次用户输入统一为“标记加一个换行”，没有修改产品代码，使用同一发行物
重新执行完整浏览器旅程。第二次结果为 `success=true`：独立 Verification、人工
验收、完成后的重启读取均通过，`pageErrors=[]`。因此当前 BaseLoop v3 预览包的
文件型 coding agent 旅程已经通过；第一次失败仍保留为验收脚本一致性缺陷的证据。

## 实现变化

- `packages/agent-runtime/src/prompt-assets.ts` 将 BaseLoop asset 从 v2 更新为 v3，
  明确规定：可由用户解决的权限、资源准入或终端能力拒绝，必须使用
  `wait` 的 `Blocked` disposition，不能使用普通 `Yielded` 等待或重复尝试。
- `packages/agent-runtime/src/work-context.ts` 在 A3 Work completion protocol 中
  重复同一条具体规则，确保更高优先级的 Work 上下文不会把拒绝解释成普通等待。
- 对应单测、真实 Provider prompt 引用和类型构建已同步。

## 验证门禁

- Agent Runtime 定向测试：2 个文件、8/8 通过。
- Agent Runtime 构建：通过。
- 根测试类型检查：通过。
- Biome：5 个受影响文件通过。
- 真实浏览器阻断/授权部分：通过。
- 完整当前源码 `pnpm check`：通过。
- 完整 `pnpm test:functional`、命令/构建/测试旅程和正式发布资格：仍未通过或未完成。
