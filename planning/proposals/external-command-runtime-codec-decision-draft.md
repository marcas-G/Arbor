# 外部 Command 运行时解码 — 治理决策稿

状态：**DRAFT / 等待人工治理接受**

缺口：`FT-DG-03`

实施：**尚未授权**

建议接受标识：`ACCEPT_EXTERNAL_COMMAND_RUNTIME_CODEC`

## 建议决定

每个生产注册的 Command 类型与 schemaVersion 绑定一个封闭、可执行的 payload
codec。ExternalSubmission 在已认证主体确定后、Authority Resolver 和语义指纹
计算前，以该 codec 解码原始 envelope/payload；不能把 TypeScript cast、Web
表单 Zod 或 Prompt 当作服务端验证。已持久化收据的只读重放先于当前 codec，
但仍须认证与请求来源校验：

```text
wire JSON
→ 认证主体与 envelope 基本形状检查（含 CommandId/ProjectId）
→ 按 commandId 查询已有收据
   ├─ 已有：按收据保存的版本/算法比较指纹；匹配返回原收据，不匹配冲突
   └─ 没有：按当前 commandType + schemaVersion 解码
             → 完整、规范的语义 payload
             → semanticRequestFingerprint
             → Authority Resolver
             → CommandGateway / durable receipt
```

codec 至少验证 branded ID 前缀与 UUIDv7、revision 整数、枚举、对象闭合字段、
数组元素及命令特有联合类型；不得把非法字符串强转成 Domain ID。解码结果是
Application Command 的语义类型，所有 HTTP/WS/CLI 外部壳共享同一解码边界。
Agent 控制工具已有自己的 provider-neutral 解码，不通过此 External codec 绕权。

不满足 wire/schema 合同的请求返回公开、类型化 `InvalidCommandPayload` Problem
（只给字段路径/规则类别，不回显密钥、绝对路径等敏感值），不进入 Authority Resolver、
CommandGateway、Domain Event Journal，也不形成 authoritative CommandReceipt。
合法 payload 的 AuthorityDenied、RevisionConflict 等业务结果仍按既有 Gateway
规则形成稳定的 TerminalRejected Receipt。这里的“格式错误”不伪装成权限拒绝。

同一个 commandId 的已解决请求仍应优先执行安全的只读收据比较：按收据保存的
schemaVersion 和指纹算法使用对应历史比较器，不以当前版本重解旧 payload；
历史上没有 codec 的版本按其原始规范序列化规则计算指纹，绝不把非法旧 ID
修正后写回。不同语义输入必须 `IdempotencyConflict`。这一 read-only
compatibility 路径与
`FT-DG-01` 的 CreateProject v1/v2 收据规则共用一个 Application/Composition
入口，不能各实现一套身份与指纹判定。未知或无法证明来源的历史 payload 失败关闭，
不以猜测自动改写已持久化 ID。

System/ExecutionOrigin 提交的规范 Command 不经外部 JSON 壳，但进入 Gateway 前
同样必须满足同一 schemaVersion 的可执行合同；Runtime 可以证明其构造来源，
不能仅靠 `as never` 或泛型让非法值写入。内部解码失败是 typed implementation
failure/Attention，不转换成模型可重试的权限错误。

## F23 验收

1. 公开进程用例拒绝非法 `MessageId`，没有 CommandReceipt、Message、Inbox 或
   Event；有效 `msg_<uuid-v7>` 保持原行为。
2. 表单生成的 AcceptanceId 使用 `acc_<uuid-v7>`；直接调用公开命令提交
   `acp_<uuid-v7>` 必须在持久化前被拒绝。
3. 覆盖非法 CommandId/ProjectId、负 revision、错误 enum、额外未声明字段、
   深层数组错误；各壳错误一致且不泄露原始敏感值。
4. 验证 same-id 同有效请求收据重放、same-id 改 payload 冲突、schemaVersion
   更新后的旧收据只读兼容；不把无效 wire 输入写成 TerminalRejected。
5. `pnpm check`、`pnpm test:functional`、干净检出通过；F23 从 pending 移入
   默认门禁，不允许 skip、预期失败或只测纯函数。

若接受，仅在拥有相应语义的 `docs/design/02-system-design.md`、
`docs/design/03-detailed-implementation-design.md` 和相关 P12 transport/Application
合同落字。用户此前授权的代写仅在人工治理明确接受固定提案后生效。
