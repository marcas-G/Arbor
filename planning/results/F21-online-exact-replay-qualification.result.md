# F21 在线 exact replay 恢复资格

状态：实现已补；首轮资格尝试命中 receipt-envelope 断言错误，修复后资格重跑 **NOT RUN**。

基线：`16a1709b0c8d8bcede721dcba4b703a8d31321ac`。

P12 `10-transport-shells.md` 第 352–355 行规定：canonical path 在 daemon 存活期间恢复后，可通过经 Gateway tuple validation 的 exact CreateProject replay 重试；daemon restart 是另一条恢复路线。此前 F21 用例在移除故障后先 restart，startup reconcile 已将 intent 激活，再发送 exact replay，因此不能证明在线 replay 触发恢复。

新增 `P12 exact replay activates restored path online in the same daemon`：通过可释放的 test-only post-commit gate 暂停首个 P11 激活；暂时移走真实 workspace 目录后放行，要求原命令保持 Committed、activation intent 为 Pending、Attention 恰为一条且 ownership 为零。随后在不重启的情况下恢复同一路径并提交原 envelope，断言 daemon PID 不变且存活、intent 转为 Active、Attention 清除、唯一 ownership/command、按 sequence 精确为 `[Pending, Active]` 的 activation 状态事件及原持久 receipt 稳定，Provider 未被调用。目录在 fixture 同卷的 `workspace-offline` sibling 临时存放；cleanup 独立尝试安全恢复、关闭 DB、停止 daemon 和清理 marker。若原路径已被占用，则不覆盖它，并在 fixture 清理前将离线目录移到 fixture 外的同卷保留位置；保留失败时只 crash daemon、跳过可能递归删除离线目录的 fixture 清理。既有 restart 覆盖保持不变。测试不执行 live DDL，也不改 production 或 `docs/design/**`。

待串行资格：

```text
pnpm vitest run tests/functional/process/f21-open3-activation-recovery.functional.test.ts -t "P12 exact replay activates restored path online in the same daemon"
```

2026-10-23 候选 `46d811b7` 首次定向运行记录于主树 `.test-results/2026-10-23T09-40-36Z-46d811b7-f21-v6/f21-p12-online-replay-exact.json`。唯一失败发生在在线 replay 的 receipt 断言（约 11.3s）：HTTP 返回 200，测试把持久化 `result_json`（仅 result）误当成完整 receipt，并再与 HTTP success envelope 比较。`PublicClient.rawCommand` 返回 `{ status, payload }`；其 `command` 读取 `payload.body.resolution` 并返回 payload。直连 `/commands` 同样有 HTTP envelope，canonical receipt 位于 `body`，形状为 `{ commandId, resolution, result }`。因此这次失败不是资源恢复失败证据，亦未越过该断言证明后续 Active/ownership/Attention/event oracle。

随后测试改为从持久化 `command_id`、`resolution`、`result_json` 重建原 canonical receipt，只比较 replay envelope 的 `body` 与该 receipt，并保留 `HTTP 200`、exact commandId、持久 result_json 不变、单 command、same daemon PID、activation events `[Pending, Active]`、唯一 ownership、Attention 清除等所有断言。其他 F21 replay assertions 已静态检视，restart case 本来就从 HTTP envelope 提取 `body` 并对 canonical receipt exact 比较。本修复未改生产返回/production code，也未放宽 oracle。

修复后资格测试：**NOT RUN**（等待 root 安排串行 daemon slot）。
