# Coding Agent 工具面调研：write 与其他常见工具

日期：2026-11-14。目的：核对 Arbor 当前工具能力是否覆盖真实 coding agent
的基本工作流。本文只记录调研和当前缺口，不修改 `docs/design/**`，也不把
外部项目的工具名称直接当成 Arbor 的设计决定。

## Arbor 当前事实

当前内置 `ToolDefinition` 为：

| 工具 | 能力 | 当前行为 |
| --- | --- | --- |
| `read@2` | `fs:read` | 读取项目内有界文件片段 |
| `list@2` | `fs:read` | 有界列出目录 |
| `patch@2` | `fs:write` | 用 unified diff 创建或更新一个文件 |
| `write@1` | `fs:write` | 新增完整写入候选；相同内容直接调用不变，不能据此认定崩溃重放安全 |
| `glob@1` | `fs:read` | 在有界目录深度和结果数内匹配文件路径，不跟随符号链接目录 |
| `grep@1` | `fs:read` | 在有界文件大小、目录深度和结果数内搜索文本正则 |
| `shell@3` | `shell:exec` | 通过策略检查后运行命令；普通 production 在无 Linux Supported tuple 时隐藏 |

`packages/tool-runtime/src/tools/index.ts` 的执行器已经包含上述七类。当前仍没有
独立 `edit`、`delete`、`move`、`websearch`、`fetch` 或浏览器工具。新增文件工具
较早修订有执行器级 TypeScript、Biome 和定向测试；最新修订尚未完整验证，普通安装包真实模型旅程、重启后
模型重放和发布资格尚未完成。

`patch` 不是完整 `write` 的同义词。现有实现的实际限制是：

- 输入是一个目标和 unified diff，不能直接表达“把这个文件完整写成这段内容”；
- 目标可以创建，但父目录必须已经存在；
- 只处理一个目标文件；
- 当前合同明确把删除和移动排除在外；
- 它的优势是有上下文匹配和幂等重放，适合对已有文件做小范围修改；
- `patch` 的 `write: true` 只表示它是文件写入型执行器，不表示存在一个名为
  `write` 的模型工具。

因此，当前 Agent 已有独立路径完整生成新文件、覆盖文件、创建嵌套目录和定位
代码；当模型需要局部结构化编辑、重命名或删除文件时，产品能力仍不完整。用
shell 里的 `cat`/重定向绕过也不能作为补救：shell 仍须走进程沙箱、审批、资源
边界和效果结算，且会把文件操作和命令执行混在一起。

## OpenCode 调研

来源：OpenCode commit
[`d759c548aab33a7a6f5171cbeab40a59e91d90aa`](https://github.com/anomalyco/opencode/tree/d759c548aab33a7a6f5171cbeab40a59e91d90aa)。
相关源码已保存到 `.test-results/coding-agent-tools-research-20261114/`。

它把文件修改拆成不同用途：

- [`write.ts`](https://github.com/anomalyco/opencode/blob/d759c548aab33a7a6f5171cbeab40a59e91d90aa/packages/core/src/tool/plugin/write.ts)：
  `path + content`，完整覆盖或创建文件，缺失父目录自动创建；用于完整文件生成。
- [`edit.ts`](https://github.com/anomalyco/opencode/blob/d759c548aab33a7a6f5171cbeab40a59e91d90aa/packages/core/src/tool/plugin/edit.ts)：
  对已有文件做局部编辑。
- [`patch.ts`](https://github.com/anomalyco/opencode/blob/d759c548aab33a7a6f5171cbeab40a59e91d90aa/packages/core/src/tool/plugin/patch.ts)：
  多文件 add/update/delete，并可表达移动；在写入前解析、验证和生成 diff，
  通过 edit 权限检查后再提交。
- `read`、`glob`、`grep`：分别处理文件读取、路径匹配和内容搜索。
- [`webfetch.ts`](https://github.com/anomalyco/opencode/blob/d759c548aab33a7a6f5171cbeab40a59e91d90aa/packages/core/src/tool/plugin/webfetch.ts)：
  URL 检查、手动逐跳重定向、权限检查、正文大小限制和 HTML 转文本/Markdown；
  不是把任意 HTTP 响应直接塞给模型。
- [`websearch.ts`](https://github.com/anomalyco/opencode/blob/d759c548aab33a7a6f5171cbeab40a59e91d90aa/packages/core/src/tool/plugin/websearch.ts)：
  搜索是独立工具和独立 Provider 配置，不等同于 `webfetch`。

这套拆分说明 `write` 的价值不是多一个名称，而是让模型有一个明确的完整文件
写入契约，同时把局部编辑、结构化 patch、搜索、网页读取和 shell 分开授权。

## Cline 调研

来源：Cline commit
[`72b3d7140553a733242126e51a7c2e87efe75c64`](https://github.com/cline/cline/tree/72b3d7140553a733242126e51a7c2e87efe75c64)。

Cline 的默认工具构造器在
[`definitions.ts`](https://github.com/cline/cline/blob/72b3d7140553a733242126e51a7c2e87efe75c64/sdk/packages/core/src/extensions/tools/definitions.ts)
中分别提供：

- `read_files`：有界读取；
- `search_codebase`：代码搜索；
- `run_commands`：命令执行；
- `fetch_web_content`：网页读取；
- `editor`：创建、替换和插入文件内容；
- `apply_patch`：另一种 patch 工具，两者不会同时作为默认编辑入口启用；
- `ask_question`、`skills`、`submit_and_exit`：交互和流程工具。

它的 editor 执行器明确支持新建文件、完整替换和按行插入；同时对已有文件要求
精确的旧文本或插入位置。Cline 没有把“能通过 shell 写文件”作为 editor 的
替代品。

## Aider 的对照结论

Aider 的模型编辑方式以 edit format（例如 edit block、diff、whole-file editor）
为中心，常见操作由编辑器格式和命令执行共同完成；它不说明 Arbor 可以省略
独立的完整文件写入能力。Aider 的实践仍证明：模型需要“完整文件生成”和“局部
差异修改”两个不同的反馈/失败处理路径。

## 对 Arbor 的结论

### 必须补齐的 coding 基础能力

为了让用户可以真实完成创建配置文件、生成脚本、更新代码和修复测试，建议至少
具备以下独立能力：

1. `read`：当前已有；
2. `list`：当前已有，但通常还需要 `glob` 和 `grep` 来定位代码；
3. `write`：完整写入/创建一个文件，支持递归创建获准目录，写入前检查资源
   边界，写入后返回是否创建/覆盖及字节数；
4. `edit` 或增强后的 `patch`：局部修改，保留当前幂等和上下文验证；
5. `move`/`delete`：真实项目整理和修复不可避免会用到，但必须单独设计副作用
   和恢复语义；不能偷偷从 write 扩大出来；
6. `grep`/`glob`：代码定位效率和模型上下文质量需要；
7. `websearch`/`fetch`：如果首发要求 Agent 查询在线文档和最新 API，则必须
   是正式工具；工具网络、目标、凭据、重定向、结果大小和来源标注分别验证；
8. 浏览器工具：只有当产品要求操作动态网页或查看开发预览时加入，不能用一次
   `fetch` 冒充浏览器。

### write 的安全与恢复要求

`write` 不能直接调用 `fs.writeFile` 就算完成。它至少需要：

- `mount + relative path`，禁止绝对路径、路径穿越、符号链接逃逸和未准入父目录；
- `content` 大小上限和编码规则；
- 项目文件权限/审批检查，和 patch 使用同一 Tool Runtime pipeline；
- 原子临时文件写入、权限继承规则和中断清理；
- 明确覆盖语义：新文件、已存在文件、内容相同重放、并发内容变化分别返回什么；
- 持久 invocation identity 与可重放结果，不能因为网络或进程重启重复破坏覆盖；
- 独立 Verification 能重新读取结果；
- 真实浏览器任务中证明“创建完整配置文件/脚本”能完成。

`write` 的 capability 可以仍然是 `fs:write`，但工具 identity、schema、side-effect
semantics 和结果契约必须独立版本化；不能把 `patch` 改名或偷偷扩大 patch 语义。

### 不能直接照搬外部项目

OpenCode/Cline 把工具运行在各自的权限和沙箱模型中。它们的 `write`、网页工具
代码或名称不能直接进入 Arbor；Arbor 必须保留当前项目资源边界、审批、Invocation
identity、Verification、Acceptance 和严格 OS 隔离。尤其是 web 工具不能绕过
Arbor 现有的 broker 合同，浏览器辅助进程不能绕过 `SandboxProcessPort`。

## 当前建议的优先级

P0：先补 `write`，并补齐创建嵌套目录、覆盖、相同内容重放和重启恢复的真实验证；
P0：补 `grep`/`glob`，否则模型只能依赖昂贵的 shell 搜索；
P1：在首发明确需要在线资料时补 `websearch` 和 `fetch`，二者必须分别纳入网络
  工具权限和真实 Provider/网络资格；
P1：再决定 `delete`/`move` 和浏览器工具的产品范围。

## 当前证据

只读工具目录盘点结果保存在
`.test-results/network-tool-inventory-20261114/result.json`：当前四个内置定义和
四个执行器，缺失 `websearch`、`web_search`、`fetch`、`browser`。本次外部源码
树与关键文件保存在 `.test-results/coding-agent-tools-research-20261114/`。
这是调研证据，不是 Arbor 的发布资格。
