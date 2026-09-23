# P14 — 03 Transcript Read Model 升级

**Owns:** transcript 视图 DTO 的对话轮表达与 projection 归属
**Does not own:** 视图语义之外的呈现（`04`）、projection 框架（P10 既有）

## 1. DTO（frozen）

在既有 transcript 视图（kind/summaryRef/at 游标列表）之上，P14 冻结
**对话轮条目**表达：

```ts
type TranscriptEntry =
  | { readonly kind: "HumanConversationTurn";
      readonly messageId: string;
      readonly body: string;            // bounded（P6 `02` §2 quota 内）
      readonly occurredAt: string }
  | { readonly kind: "AssistantConversationTurn";
      readonly executionId: string;     // correlation：来自哪个对话轮 execution
      readonly body: string;            // bounded 最终回复（ModelOutput 汇总）
      readonly occurredAt: string }
  | { readonly kind: string;            // 既有条目原样（Message/Work/…）
      readonly summaryRef: string;
      readonly at: string };
```

- 请求形状不变（workspaceId/sessionId?/cursor?/limit）；响应 entries 变为
  上述联合；`nextCursor` 游标语义不变。
- **bounded body**：正文来自 bodyRef/blob 的 bounded view（DID §8.14），
  超限截断 + 完整体不进 DTO（不做全文通道）。
- **correlation（seam-7）**：Assistant turn 必带 executionId；Human turn
  必带 messageId；`02` §4 保证 1:1（execution ↔ answered message）。

## 2. Projection 归属

- transcript projection（P10 既有）扩展消费三类来源：`HumanMessageSubmitted`
  （Human turn）、`SettleExecution(Completed(QueryCompleted))` + execution
  focus=Coordination（Assistant turn，从最终 ModelOutput 落 bounded 正文）、
  既有事件（原样条目）。
- Assistant turn 以 executionId 为唯一键 upsert（重放安全，`02` §4）。
- freshness：沿用 P10 watermark/barrier——P14 不新增失效机制（WS 帧 →
  invalidate → `/views` refetch，Web v1 既有链路零改动）。

## 3. 不变量

1. transcript 仍只读（`04` 的 composer 是唯一输入面，走 `01` 命令）；
2. 无 streaming：任何 turn 的 body 都是**最终态**投影（无 delta/部分态）；
3. child workspace transcript 天然复用本 read model（只读、无 composer——
   `04`）；child 的 Agent 内部 Message 条目按既有 kind 原样呈现。

## 4. Must Not Decide

- 不决定 UI 布局（`04`）；
- 不发明 message 搜索/全文检索（Search 仍 out-of-v1）；
- 不改其他 8 个 frozen views。

## 5. Verification

单测：三 kind 联合渲染 fixture（含未知 kind 原样）；bounded 截断；
executionId/messageId correlation；cursor 分页；upsert 重放幂等；
api-contracts types 编译级穷尽。
