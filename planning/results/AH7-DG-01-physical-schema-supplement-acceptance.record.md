# AH7-DG-01 Physical Schema Supplement — Acceptance and Integration Gate

日期：2026-10-11

状态：**物理补充设计已接受（Independent review Blocking = 0）；owner-document
landing / migration registration 仍暂停，等待统一治理 DAG 与前缀资格**

## 接受决定

- Decision: `ACCEPT_AH7_DG01_PHYSICAL_SCHEMA_SUPPLEMENT`
- 被接受物理补充稿：
  `planning/proposals/AH7-DG-01-physical-schema-supplement-draft.md`
- 固定 LF SHA-256：
  `5B61E0FF922A10D225FD5DAEA00176BD16C5C0B39484D626B7FEF6340516373A`
- 固定稿 commit：`ecd36972c812076ebf3766ad7a9f79d823ee89fa`
- 语义前置接受包：`ACCEPT_TOOL_SETTLEMENT_OBSERVATION_REPLAY`，LF SHA-256
  `19EFED54E037D3E2EC6F4D273D917F5249195650E5E41B3DCFF8DEB9784F29CD`。
- 独立复审结论由协调 Governor 报告：**Blocking = 0**，范围仅为物理设计补充。
  复审 artifact 不在此独立 worktree 中；本记录不编造 review 文件或 hash。
- 接受范围包括 P40 cumulative-only slot 与依赖边、P4 observation evidence DDL/trigger、
  DG03 Denied/NotAdmitted NULL-evidence 分支、P9 fact/event 物理候选，以及 P10
  source-specific marker row、query union、offset/rebuild 物理决定。接受的是该固定稿；
  不扩张其外的产品语义。

## 未获资格的前缀与执行边界

P40 仍只允许沿既定顺序集成：

```text
P36 AH7-DG-03 → P37 AH10 → P38 EA → P39 AH7-DG-02 (conditional) → P40 AH7-DG-01
```

**本接受不证明 P36–P39 已集成，也不授予 P40 单独发行或从旧 schema 跳级执行。**
这些前置 migration/owner contracts 在 `f80ee9132774c0c1fb570744d81398fad17da188`
基线尚未齐备；DG03 仍是另一已接受树，不能由本记录宣称已并入。

同样，**累积 migration runner 的单执行者/串行化仍未资格**。现有 runner 的
`user_version` 预读可能让两个 OS 进程同时认为 P40 可运行。本接受不证明它安全；在
集成树固定并证明 P36–P40 启动 migration 不会并发重复执行前，不得注册/执行 P40。

治理集成审计 agent 正在核对跨分支 DID/owner 冲突。待统一治理树 DAG 与前缀 landing
顺序确定后，才可评估是否开始 owner-document landing；本记录本身不落 `docs/design/**`，
不启动 migration，不授权生产实现或 AH7 阶段关闭。Landing 后还需要各 owner hash、
diff-check 与独立一致性复审。

## Worktree 与验证范围

- 记录所在隔离树的 landing 前 HEAD：`ecd36972c812076ebf3766ad7a9f79d823ee89fa`。
- 本提交仅新增本 planning acceptance record。
- 未修改 `docs/design/**`、生产代码、migration 或 tests。
- 未运行 tests、daemon、migration，也未推送。
