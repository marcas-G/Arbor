# 首次模型配置方案接受记录

日期：2026-11-14（Asia/Shanghai）

负责人接受了固定提案：

`docs/proposals/2026-11-14-first-run-model-setup.md`

提案 SHA-256：

`a4ce27ecdeadcb040a1f98052b7af87f9ac2b323f66c2b9254757f7eb18f0dbf`

接受的产品行为是：首次打开 Arbor 时填写真实模型，连接检查成功后保存到
本机并自动重新加载进入工作台；未配置或连接检查失败时不能开始任务。

接受范围严格限于提案中的首次本机单用户配置流程：兼容 OpenAI 的 HTTPS
接口、模型名和 API Key；配置成功前禁止业务 API、WebSocket 和 Work；成功
后保存 SecretRef 并重载；已配置后不能通过该入口更换模型。原生 Anthropic/
Gemini、无 key 本机模型、多 Provider 和运行中换模型不在本次接受范围内。

## 精确落点

- P12 `10-transport-shells.md`：首次配置 host surface；
- P13 `01-client-boundary-role.md`：I3 的精确 `/model-setup` 例外；
- P13 `06-acceptance.md`：EC-15 与浏览器验收故事；
- `tests/architecture/p13-web-boundaries.test.ts`：仅增加该精确路径和
  POST/字段检查，保留其余写路径限制。

## 一致性审查

落地不修改领域命令、权限、Work、Provider Runtime、数据库 schema 或迁移。
架构门禁仍拒绝任意新增 URL；只有 `/model-setup` 被列入 host 配置白名单。
实现验收仍需补齐真实连接成功、私有凭据无泄露、自动重载和重载后真实工作
流；在这些证据完成前，EC-15 和整体 Linux 首发目标保持未完成。

## 后续实施复验

本机独立 Linux x64 安装包已经通过浏览器配置外部真实模型、私有凭据保存、
自动重载、真实助手回复和重启历史；后续同一包的文件任务也完成受阻、明确
授权、恢复修改、独立验证、人工验收及重启。详细发行物身份和证据见
`docs/verification/2026-11-14-linux-install-real-model.md`。

上述结果补齐本地首次配置主流程的真实服务证据；Linux 命令、构建、测试和
完整 Provider/平台发布矩阵仍未完成，整体首发目标继续进行。
