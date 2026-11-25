# 首次模型配置：待确认的落地方案

状态：原型待确认，尚未修改冻结设计或放宽架构门禁。

产品依据：负责人已明确要求 Linux 可安装、使用真实模型，未配置时只提供配置功能，不能用假模型替代。

拟采用的用户流程：

1. 首次打开 Arbor 时显示模型配置页，填写兼容 OpenAI 的接口地址、模型名称和 API Key。
2. 点击“连接并保存”后，向指定接口发送一次简短模型请求；检查失败则保留表单，不保存配置，不进入工作台。
3. 成功后将凭据写入本机私有文件，配置只保存凭据引用；自动重新加载服务，回到工作台，无需终端命令。
4. 配置前禁止创建项目、提交工作和执行工具；HTTP 与 WebSocket 均执行此限制。已有可用配置继续直接进入工作台。
5. 本包只解决首次配置；更换已配置模型、无 API Key 的本机模型、Anthropic/Gemini 原生协议仍待后续实现，不能标为完成。

本包拟增加的精确技术合同：

- P12 本机 host 配置面：GET `/model-setup` 返回 `{configured:boolean,model:string|null}`，绝不返回凭据；POST `/model-setup` 只接收 `{endpoint,model,apiKey}`，校验并保存后返回 `{ok:true,restarting:true}`。失败返回安全错误码，不转发服务商响应正文或异常对象。
- 这是进程启动配置，不是 Work、PermissionGrant 或领域事件。只允许本机单用户配置；已配置状态拒绝重复保存。本包不允许远程修改配置。
- 浏览器请求先通过 Host/Origin 检查；POST 必须为 JSON，配置正文上限 64 KiB。未配置时业务 API 与 WS 在触及核心逻辑前拒绝。
- 凭据只发到用户明确填写的 HTTPS 地址，HTTP 仅允许 loopback；拒绝 URL 内凭据、query/hash 以及重定向。连接检查为实际 Chat Completions 请求；200 响应必须包含非空模型内容才允许保存。
- 配置和凭据文件权限 0600；凭据目录 0700，自带忽略规则。先同步凭据，再原子替换配置并同步目录；保存失败不伪造成功。旧配置和凭据不自动删除。
- Linux Node 24 的 execve 在 Effect scope、Web listener 和 SQLite writer permit 释放后重新执行当前入口；保持 PID，生成新的运行实例 ID。此包仅在首次配置未运行任务时重载，不授权在活跃 Work 中自动切换模型。
- 普通 production 缺少模型时使用拒绝执行的 ProviderPort，绝不回落到 fake；测试的显式 Provider 注入保持可用。
- 设计落地归属：P12 `10-transport-shells` 增加 host 配置面；P13 `01-client-boundary-role` I3 为首次 host 配置增加受限例外，`06-acceptance` 增加配置前拒绝/凭据不泄露/重载验收。领域命令仍全部经 `/commands`。
- 架构门禁只在上游落地后增加精确 `/model-setup` 例外，保留其他写路径限制，不能删除 I3 或宽泛允许任意 URL。

实际失败证据：

- `pnpm architecture`：`p13-web-boundaries.test.ts` I3 拒绝原型的 `/model-setup`，其余 196 项通过。这是冻结写路径合同缺口，不能用绕过扫描的写法处理。
- 真实 Chromium 首次配置原型：配置前 `/commands` 为 503，真实模型连接检查返回 `model-setup/connection-failed`，未进入工作台。此失败仍需诊断，不能宣称首次配置完成。
- 原型单元与 Web 回归通过不替代上述真实模型验收。

人工确认后才允许按本包修改 owning design、记录包的 SHA-256，并继续完成真实模型配置、自动重载和重启后任务验收。
