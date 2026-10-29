# Tool Resource / Sandbox Target V2 治理决策草案

**Status:** SUPERSEDED — do not accept; replaced by the mount-relative decision

> 本草案的 `root + relativePath` 方案已被后续治理否决。权威方案是
> `ExecutionWorkspaceBinding + mount + path`，见
> `tool-resource-sandbox-target-v2-governance-decision.md` 与 DID v1.25。

**Design Gap:** `DOGFOOD-DG-03`

**Decision token:** `ACCEPT_TOOL_RESOURCE_SANDBOX_TARGET_V2`

## 1. 要解决的问题

当前文件工具把同一个 `path` 同时当成两种东西：

1. 用于权限、资源边界和环境解析的 `ResourceAddress`；
2. 用于访问临时沙箱的相对路径。

这两个概念不能合并。现实 Worktree 可以是绝对路径，但沙箱内目标必须是
相对于已挂载资源根的路径。真实 dogfood 已证明当前实现会因此拒绝合法地址并
击穿守护进程。

本决定只收敛“资源根如何映射到沙箱内目标”。它不改变 Workspace、Work、
Execution、Agent Loop、Permission、Ownership 或 Tool Calling 的既有语义。

## 2. TRS-1：资源根与根内目标分离

引入 provider-neutral 值对象：

```ts
interface FilesystemTargetV2 {
  readonly root: FileTree | GitWorktree;
  readonly relativePath: SandboxRelativePath;
}
```

- `root` 是环境语义地址；参与 ProjectEnvironment resolve、ResourceBoundary、
  Permission、Tool Authority 与 ResourceAdmission。
- `relativePath` 只在该资源根被准入并挂载后解释；不得单独参与权限扩张。
- `relativePath = "."` 表示资源根本身。
- 不允许通过把 host absolute path 塞入 `relativePath` 绕过 `root`。

## 3. TRS-2：SandboxRelativePath v1

`SandboxRelativePath` 使用 `/` 作为规范分隔符，并满足：

```text
"."                                  合法
"src/index.ts"                       合法
"/src/index.ts"                      非法
"C:/repo/src/index.ts"               非法
"src\\index.ts"                      非法
"", "..", "a/../b", "a//b"          非法
含 NUL、控制字符或空 segment          非法
```

解析必须同时执行：

1. 词法边界检查；
2. 目标存在时的 realpath / junction / symlink 边界检查；
3. 写入新目标时，对最近存在祖先执行 realpath 边界检查；
4. 最终目标必须仍位于指定 mount 内。

平台路径转换只发生在 Sandbox adapter 内部。模型、Provider adapter、Model
Context 和 ToolDefinition 均只看到规范 `/` 表示。

## 4. TRS-3：版本化工具输入

保留工具名，新增版本 `2`；v2 输入为：

```text
read@2  { target: FilesystemTargetV2, offset?: int, limit?: int }
list@2  { target: FilesystemTargetV2, depth?: int }
patch@2 { target: FilesystemTargetV2, unifiedDiff: string }
shell@2 { command: string, cwd: FilesystemTargetV2, timeoutMs?: int }
```

约束：

- `read@2` 的 target 必须解析为普通文件。
- `list@2` 的 target 必须解析为目录。
- `patch@2` 的 target 必须解析为普通文件；本轮不新增“通过 patch 创建文件”
  语义。需要创建文件时必须由后续独立工具合同治理。
- `shell@2.cwd` 必须解析为目录。
- Result schema 与现有 v1 保持兼容；版本/hash 必须随 input contract 更新。

## 5. TRS-4：v1 的处置

`read@1`、`list@1`、`patch@1`、`shell@1` 不得被重新解释，因为这会让同一
version/hash 在历史与当前产生不同语义。

治理落地后：

- 新 execution profile 不再暴露四个 v1 filesystem definitions；
- ToolDefinitionStore 保留 v1 供历史记录解析和审计；
- 新的 v1 调用 fail closed，返回明确的迁移失败，不执行文件系统动作；
- 已持久化的 v1 ToolIntent 不自动转换成 v2，不自动重放；
- Agent Loop 在后续 turn 只能看到 v2 定义并重新作出调用决定。

## 6. TRS-5：Sandbox mount 合同

`SandboxPort.open` 必须接收已解析的资源绑定，而不只是失去来源关系的 region
数组：

```ts
interface ResolvedResourceBinding {
  readonly address: FileTree | GitWorktree;
  readonly region: CanonicalResourceRegion;
}
```

它返回每个绑定对应的 opaque mount：

```ts
interface SandboxMount {
  readonly mountId: string;
  readonly regionKey: string;
  readonly writable: boolean;
}

interface SandboxHandle {
  readonly handleId: string;
  readonly mounts: ReadonlyArray<SandboxMount>;
}
```

具体 host path、临时目录和 WorktreeStore record 不进入模型上下文，也不作为
跨进程 wire contract。当前 `rootPath` 可在兼容迁移期作为 adapter-local 字段，
但 v2 executor 不得直接拼接它。

## 7. TRS-6：唯一映射与解析端口

SandboxPort 拥有解析操作：

```ts
resolveTarget({
  handle,
  regionKey,
  relativePath,
  access: "Read" | "Write" | "Execute"
}) -> Effect<SandboxResolvedTarget, SandboxTargetError>
```

规则：

- Tool Runtime 先 resolve `target.root`，并以
  `canonicalRegionString(region)` 找到同一次 `open` 返回的唯一 mount。
- 0 个匹配为 `UnmappedResource`；多于 1 个匹配为
  `AmbiguousResourceMount`；两者都 fail closed。
- 不允许 Tool Runtime 通过字符串前缀截断 host path 自行推导 mount。
- `SandboxResolvedTarget` 只在进程内传给 builtin executor，不持久化、不进入
  Provider 或 canonical ToolObservation。

## 8. TRS-7：Worktree adapter 的挂载与写回

Worktree-backed sandbox 必须保留三者的明确关系：

```text
requested canonical root
containing backing WorktreeRecord
isolated mount location
```

若请求根是 backing worktree 的子树，mount 指向隔离副本中的相同子树，而不是
把请求根错误映射为整个 worktree 根。

关闭沙箱时：

- 每个 writable mount 只写回其对应 backing worktree 的同一子树；
- 多 mount 不得把同一临时根完整复制到多个 backing worktree；
- read-only mount 不写回；
- 同一 canonical region 的 alias 先去重；
- overlap 或目标歧义在 open/resolve 阶段拒绝，不到 close 才猜测；
- 写回失败进入既有 SandboxError / 工具恢复语义，不伪装为成功。

## 9. TRS-8：失败分类与恢复

下列属于终端 `ExpectedFailure` ToolObservation，不是进程 defect：

- 非法 `SandboxRelativePath`；
- 未挂载或歧义 root；
- 目标不存在或类型不匹配；
- 词法、symlink 或 junction 越界；
- write target 不在唯一 writable mount；
- 普通 filesystem permission / stale path I/O 失败。

真正的 executor defect、进程崩溃或 write outcome ambiguity 仍按既有 P9
副作用等级与恢复协议处理，不得被全局 catch 后降级成 ExpectedFailure。

## 10. TRS-9：上下文与权限来源

- Model Context 展示 v2 schema，并以当前 ResourceBoundary 中可见的
  `ResourceAddress` 作为 `root` 候选；不向模型展示临时 sandbox path。
- `resourceArguments` 从 `target.root` / `cwd.root` 提取地址。
- Authority、Capability、Permission、Ownership 和 ResourceAdmission 仍只对
  canonical resource region 生效；`relativePath` 永远不能扩大 root。
- 对写操作，准入 region 必须覆盖最终 canonical target；若 root 权限只覆盖更窄
  region，则 adapter 必须拒绝越界目标。

## 11. TRS-10：实施与机械验收

接受本决定只授权把 owning contract 写入 `docs/design/**`；运行时代码实施需要
独立令牌：

```text
AUTHORIZE_TOOL_RESOURCE_SANDBOX_TARGET_V2_IMPLEMENTATION
```

实施按以下顺序进行：

1. TDD 固定 RelativePath、alias、nested root、multi-mount、symlink/junction、
   write-back 和 crash-preservation 反例；
2. 增加 v2 ToolDefinition 与 profile 切换，v1 fail closed；
3. 扩展 ProjectEnvironment resolution 以保留 address→region pairing；
4. 扩展 SandboxPort mount/resolveTarget；
5. 修改 local/worktree sandbox adapters；
6. 修改 read/list/patch/shell executors；
7. 证明 P9 crash/reconcile tests 不被错误吞掉；
8. 在隔离项目重新运行原 release-validation Work；
9. `pnpm check` 全绿并记录真实 dogfood 结果。

机械退出条件：

- 合法绝对 `GitWorktree` root + 相对目标成功；
- host absolute path 出现在 `relativePath` 时失败；
- nested root 不会映射到 backing worktree 根；
- 多 mount 无串写；
- 所有逃逸反例失败且无 daemon crash；
- P9 ReadOnly / Idempotent / Reconcilable / NonIdempotent 恢复套件保持通过；
- 原 dogfood Work 由 Arbor Agent 自己读、改、测、提交 CompletionClaim，人工不
  代写目标文件。

## 12. 接受方式

人工治理若接受本文完整语义，回复：

```text
ACCEPT_TOOL_RESOURCE_SANDBOX_TARGET_V2
```

接受不等于实现授权。接受后先由人工治理或已明确获准的 Codex 更新 owning
`docs/design/**`、记录 resolving revision，并把 `DOGFOOD-DG-03` 标为
`RESOLVED`；随后才可使用独立实现授权令牌。
