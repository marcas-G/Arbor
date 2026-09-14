# P1-03 — Minimal Agent Runtime 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 项目自有的最小 agent 内核：归一化 provider port（Fake + OpenAI Chat Completions 非流式）、五个工具、agent loop + guards。验收 = Fake Provider 测试全绿 + 一个真实 OpenAI 小任务（有 key 时）。

**Architecture:** 全部落在 `src/agent-runtime/`（DEPENDENCY_RULES：可用 application ports，不含 Workspace domain 变更）。工具执行 rooted 在 workspace worktree，参数经 domain path 校验。P1-03 无持久化（transcript/session 持久化是 P1-05）。

**权威依据:** `P1_03_RUNTIME_GATE.md`（D-032 冻结：A1-A4/B1-B4）+ `P1_AGENT_RUNTIME_CONTRACT.md`。

**已验证:** effect 4 提供 `Schema.toJsonSchemaDocument`（draft-2020-12）——工具模型面 JSON Schema 从 Effect Schema 派生。

---

## 文件结构

```text
src/agent-runtime/
├── provider.ts          # T1 ModelPort/ModelTurn/ModelRequest/消息类型 + ModelError
├── fake-provider.ts     # T1 剧本式 Fake（tests 主力）
├── openai-provider.ts   # T2 Chat Completions 非流式（fetch 注入）
├── tool.ts              # T3 Tool 接口 + registry + JSON Schema 派生
├── tools/
│   ├── read-file.ts     # T4
│   ├── write-file.ts    # T4
│   ├── edit-file.ts     # T4（0 或 ≥2 匹配报错）
│   ├── run-command.ts   # T4（argv + timeout 30s 默认/120s 上限）
│   └── git-status.ts    # T4（走 GitPort）
└── agent-loop.ts        # T5 循环 + guards（25 步 / 3 连同调）
tests/unit/
├── fake-provider.test.ts      # T1
├── openai-provider.test.ts    # T2（注入 fake fetch）
├── tool-registry.test.ts      # T3
└── agent-loop.test.ts         # T5
tests/integration/
└── tools.test.ts              # T4（真 fs/git/进程）
tests/acceptance/
└── agent-fake-task.test.ts    # T6（剧本驱动端到端写文件）
script/openai-smoke.ts         # T6 真实 OpenAI 手动验收脚本
```

---

### Task 1: provider 类型 + Fake Provider（TDD）

**Files:** `src/agent-runtime/provider.ts`、`src/agent-runtime/fake-provider.ts`; Test `tests/unit/fake-provider.test.ts`

- [ ] **Step 1: 失败测试**

```typescript
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { ModelPort } from "../../src/agent-runtime/provider.js";
import { FakeProviderLive } from "../../src/agent-runtime/fake-provider.js";

const turn = (t: Partial<Parameters<typeof Object>[0]> extends never ? never : object) => t;

describe("FakeProvider (scripted)", () => {
  it("returns scripted turns in order", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const p = yield* ModelPort;
        const r1 = yield* p.complete({ messages: [] });
        const r2 = yield* p.complete({ messages: [] });
        expect(r1.finishReason).toBe("tool-calls");
        expect(r2.finishReason).toBe("stop");
      }).pipe(Effect.provide(FakeProviderLive.withScript([
        { content: undefined, toolCalls: [{ id: "c1", name: "read_file", arguments: "{\"path\":\"a.txt\"}" }], finishReason: "tool-calls" },
        { content: "done", toolCalls: [], finishReason: "stop" },
      ]))),
    );
  });
  it("exhausted script → ModelError", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const p = yield* ModelPort;
        yield* p.complete({ messages: [] });
        return yield* p.complete({ messages: [] });
      }).pipe(Effect.provide(FakeProviderLive.withScript([
        { content: "x", toolCalls: [], finishReason: "stop" },
      ]))),
    );
    expect(exit._tag).toBe("Failure");
  });
});
```

- [ ] **Step 2: 实现 provider.ts**

```typescript
import { Context, Data, Effect } from "effect";

export class ModelError extends Data.TaggedError("ModelError")<{ message: string }> {}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string; // JSON
}

export type FinishReason = "stop" | "tool-calls" | "length";

/** A4 (D-032): Arbor-owned normalized provider turn. */
export interface ModelTurn {
  readonly content: string | undefined;
  readonly toolCalls: ReadonlyArray<ToolCall>;
  readonly finishReason: FinishReason;
}

export type ChatMessage =
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content?: string | undefined; readonly toolCalls?: ReadonlyArray<ToolCall> | undefined }
  | { readonly role: "tool"; readonly toolCallId: string; readonly content: string };

export interface ModelToolSpec {
  readonly name: string;
  readonly description: string;
  readonly jsonSchema: object; // model-facing JSON Schema (derived, see tool.ts)
}

export interface ModelRequest {
  readonly system: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly tools?: ReadonlyArray<ModelToolSpec> | undefined;
}

export interface ModelPort {
  readonly complete: (req: ModelRequest) => Effect.Effect<ModelTurn, ModelError>;
}

export const ModelPort = Context.Service<ModelPort>("agent-runtime/ModelPort");
```

- [ ] **Step 3: 实现 fake-provider.ts**（`withScript(script)` 是 Layer 工厂；按序返回，耗尽 ModelError）

```typescript
import { Effect, Layer } from "effect";
import { ModelError, ModelPort, type ModelTurn } from "./provider.js";

const make = (script: ReadonlyArray<ModelTurn>) =>
  Layer.succeed(
    ModelPort,
    ModelPort.of({
      complete: () =>
        Effect.succeed(script[0] ?? undefined).pipe(
          Effect.flatMap((t) => {
            script.shift();
            return t === undefined
              ? Effect.fail(new ModelError({ message: "fake provider script exhausted" }))
              : Effect.succeed(t);
          }),
        ),
    }),
  );

export const FakeProviderLive = { withScript: make };
```

（`script.shift()` 在 succeed 前执行的时序问题以测试为准修正——意图：每次 complete 消费一个剧本项。）

- [ ] **Step 4: 绿 → Commit** `feat: model port with normalized turns and scripted fake provider (P1-03)`

---

### Task 2: OpenAI Provider（TDD，注入 fetch）

**Files:** `src/agent-runtime/openai-provider.ts`; Test `tests/unit/openai-provider.test.ts`

- [ ] **Step 1: 失败测试**（fake fetch 断言请求体与响应映射）

```typescript
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { ModelPort } from "../../src/agent-runtime/openai-provider.js";

const okBody = {
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"x\"}" } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
};

describe("OpenAIProvider", () => {
  it("maps request and response (A1/A4)", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fakeFetch: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify(okBody), { status: 200 });
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const p = yield* ModelPort;
        const t = yield* p.complete({
          system: "sys",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(t.finishReason).toBe("tool-calls");
        expect(t.toolCalls[0]?.name).toBe("read_file");
        expect(t.toolCalls[0]?.arguments).toBe("{\"path\":\"x\"}");
      }).pipe(Effect.provide(OpenAiProviderLive({ fetchImpl: fakeFetch }))),
    );
    const body = JSON.parse(String(captured?.init.body));
    expect(body.model).toBe("gpt-test");
    expect(body.stream).toBe(false);
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
  });

  it("missing OPENAI_MODEL → typed ModelError", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const p = yield* ModelPort;
        return yield* p.complete({ system: "s", messages: [] });
      }).pipe(Effect.provide(OpenAiProviderLive({ fetchImpl: async () => new Response("{}", { status: 200 }), env: {} }))),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("non-200 → ModelError with status", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const p = yield* ModelPort;
        return yield* p.complete({ system: "s", messages: [{ role: "user", content: "x" }] });
      }).pipe(Effect.provide(OpenAiProviderLive({
        fetchImpl: async () => new Response("nope", { status: 401 }),
        env: { OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-test" },
      }))),
    );
    expect(exit._tag).toBe("Failure");
  });
});
```

- [ ] **Step 2: 实现**（factory 接 `{ fetchImpl?, env? }`，默认 globalThis.fetch / process.env；映射 ChatMessage→OpenAI 格式；finish_reason 归一化 `tool_calls→tool-calls`）

```typescript
import { Effect, Layer } from "effect";
import { ModelError, ModelPort, type ChatMessage, type ModelToolSpec, type ModelTurn } from "./provider.js";

interface Deps {
  readonly fetchImpl?: typeof fetch;
  readonly env?: Record<string, string | undefined>;
}

const mapMessages = (system: string, msgs: ReadonlyArray<ChatMessage>) => [
  { role: "system", content: system },
  ...msgs.map((m): object => {
    if (m.role === "user") return { role: "user", content: m.content };
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    return {
      role: "assistant",
      ...(m.content !== undefined ? { content: m.content } : {}),
      ...(m.toolCalls !== undefined
        ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) }
        : {}),
    };
  }),
];

const mapTools = (tools: ReadonlyArray<ModelToolSpec>) =>
  tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.jsonSchema } }));

const normFinish = (r: string): ModelTurn["finishReason"] =>
  r === "tool_calls" ? "tool-calls" : r === "length" ? "length" : "stop";

export const OpenAiProviderLive = (deps: Deps = {}) =>
  Layer.succeed(
    ModelPort,
    ModelPort.of({
      complete: (req) =>
        Effect.gen(function* () {
          const env = deps.env ?? process.env;
          const key = env.OPENAI_API_KEY;
          const model = env.OPENAI_MODEL;
          if (model === undefined || model === "") {
            return yield* new ModelError({ message: "OPENAI_MODEL is required (A2, D-032)" });
          }
          if (key === undefined || key === "") {
            return yield* new ModelError({ message: "OPENAI_API_KEY is required" });
          }
          const f = deps.fetchImpl ?? fetch;
          const res = yield* Effect.tryPromise({
            try: () =>
              f("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
                body: JSON.stringify({
                  model,
                  stream: false,
                  messages: mapMessages(req.system, req.messages),
                  ...(req.tools !== undefined && req.tools.length > 0 ? { tools: mapTools(req.tools) } : {}),
                }),
              }),
            catch: (e) => new ModelError({ message: `network: ${String(e)}` }),
          });
          if (!res.ok) {
            return yield* new ModelError({ message: `openai ${res.status}: ${res.statusText}` });
          }
          const body = (yield* Effect.tryPromise({
            try: () => res.json(),
            catch: (e) => new ModelError({ message: `bad json: ${String(e)}` }),
          })) as { choices?: Array<{ message: { content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }, finish_reason: string }> };
          const choice = body.choices?.[0];
          if (choice === undefined) {
            return yield* new ModelError({ message: "no choices in response" });
          }
          return {
            content: choice.message.content ?? undefined,
            toolCalls: (choice.message.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
            finishReason: normFinish(choice.finish_reason),
          };
        }),
    }),
  );
```

（test 的 import 路径以实现文件名为准修正。）

- [ ] **Step 3: 绿 → Commit** `feat: openai chat completions provider with fetch injection (P1-03)`

---

### Task 3: Tool 接口 + registry（TDD）

**Files:** `src/agent-runtime/tool.ts`; Test `tests/unit/tool-registry.test.ts`

- [ ] **Step 1: 失败测试**（JSON Schema 派生 + 未知工具 + 参数解码错误路径）

```typescript
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { runTool, toolFromSchema } from "../../src/agent-runtime/tool.js";

const echo = toolFromSchema({
  name: "echo",
  description: "echo text",
  params: Schema.Struct({ text: Schema.String }),
  execute: (p) => Promise.resolve(`echo:${p.text}`),
});

describe("tool registry", () => {
  it("derives model-facing JSON Schema from Effect Schema", () => {
    const json = JSON.stringify(echo.jsonSchema);
    expect(json).toContain("text");
    expect(json).toContain("string");
  });
  it("runs valid args", async () => {
    expect(await runTool([echo], "echo", { text: "hi" })).toEqual({ ok: true, output: "echo:hi" });
  });
  it("invalid args → typed tool error result (not throw)", async () => {
    const r = await runTool([echo], "echo", {});
    expect(r.ok).toBe(false);
  });
  it("unknown tool → typed tool error result", async () => {
    const r = await runTool([echo], "nope", {});
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 实现**

```typescript
import { Context, Data, Effect, Layer, Schema } from "effect";

export class ToolError extends Data.TaggedError("ToolError")<{ message: string }> {}

export type ToolResult = { ok: true; output: string } | { ok: false; error: string };

export interface ToolParams<P> {
  readonly name: string;
  readonly description: string;
  readonly params: Schema.Schema<P, unknown, never>;
  readonly execute: (args: P) => Promise<string>;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly jsonSchema: object;
  readonly run: (rawArgs: unknown) => Promise<ToolResult>;
}

export function toolFromSchema<P>(t: ToolParams<P>): Tool {
  const doc = Schema.toJsonSchemaDocument(t.params as never);
  return {
    name: t.name,
    description: t.description,
    jsonSchema: doc as object,
    run: async (raw: unknown) => {
      try {
        const decoded = Schema.decodeUnknownSync(t.params)(raw);
        return { ok: true, output: await t.execute(decoded) };
      } catch (e) {
        return { ok: false, error: `invalid arguments for ${t.name}: ${String(e)}` };
      }
    },
  };
}

export async function runTool(tools: ReadonlyArray<Tool>, name: string, rawArgs: unknown): Promise<ToolResult> {
  const t = tools.find((x) => x.name === name);
  if (t === undefined) {
    return { ok: false, error: `unknown tool: ${name}` };
  }
  return t.run(rawArgs);
}
```

（`toJsonSchemaDocument` 的参数类型按 d.ts 调整；ToolError 类暂无消费者则不导出多余 API——保留为 run 循环内的字符串结果形态。）

- [ ] **Step 3: 绿 → Commit** `feat: tool interface with schema-derived json schema (P1-03)`

---

### Task 4: 五个工具（integration TDD）

**Files:** `src/agent-runtime/tools/*.ts`（5 个）; Test `tests/integration/tools.test.ts`

工具公共形状：工厂 `makeReadFileTool(worktreeRoot: string)` 等；path 参数经 `normalizeProjectPath`（非 canonical 即错误），resolve 到 `worktreeRoot + value`。

- [ ] **Step 1: 失败 integration 测试**（真 fs/进程/git；矩阵含 §11 拒绝、edit 0/2 匹配、命令超时）

```typescript
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeEditFileTool } from "../../src/agent-runtime/tools/edit-file.js";
import { makeGitStatusTool } from "../../src/agent-runtime/tools/git-status.js";
import { makeReadFileTool } from "../../src/agent-runtime/tools/read-file.js";
import { makeRunCommandTool } from "../../src/agent-runtime/tools/run-command.js";
import { makeWriteFileTool } from "../../src/agent-runtime/tools/write-file.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "arbor-tools-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const run = (t: { run: (a: unknown) => Promise<{ ok: boolean } & Record<string, string>> }, args: unknown) => t.run(args);

describe("file tools", () => {
  it("write then read roundtrip", async () => {
    const root = tmp();
    const w = makeWriteFileTool(root);
    const r = makeReadFileTool(root);
    expect((await run(w, { path: "src/a.txt", content: "hello" })).ok).toBe(true);
    expect(await run(r, { path: "src/a.txt" })).toMatchObject({ ok: true, output: "hello" });
  });
  it("read missing file → error result", async () => {
    const r = makeReadFileTool(tmp());
    expect((await run(r, { path: "nope.txt" })).ok).toBe(false);
  });
  it.each([["/abs/x"], ["../esc"], ["a/../b"]])("rejects non-canonical path %s", async (p) => {
    const r = makeReadFileTool(tmp());
    expect((await run(r, { path: p })).ok).toBe(false);
  });
  it("edit with unique match succeeds; zero and double matches fail (B2)", async () => {
    const root = tmp();
    writeFileSync(join(root, "f.txt"), "aaa bbb aaa");
    const e = makeEditFileTool(root);
    expect((await run(e, { path: "f.txt", oldString: "bbb", newString: "ccc" })).ok).toBe(true);
    expect((await run(e, { path: "f.txt", oldString: "zzz", newString: "y" })).ok).toBe(false);
    expect((await run(e, { path: "f.txt", oldString: "aaa", newString: "x" })).ok).toBe(false);
  });
});

describe("run_command (B3)", () => {
  it("runs argv and captures stdout", async () => {
    const c = makeRunCommandTool(tmp());
    const r = await run(c, { argv: [process.execPath, "-e", "console.log('out42')"], timeoutMs: 10000 });
    expect(r).toMatchObject({ ok: true });
    expect(String(r.output)).toContain("out42");
  });
  it("non-zero exit → error result with output", async () => {
    const c = makeRunCommandTool(tmp());
    const r = await run(c, { argv: [process.execPath, "-e", "process.exit(3)"], timeoutMs: 10000 });
    expect(r.ok).toBe(false);
  });
  it("timeout kills the process", async () => {
    const c = makeRunCommandTool(tmp());
    const r = await run(c, { argv: [process.execPath, "-e", "setTimeout(()=>{},30000)"], timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("timeout");
  });
  it("rejects timeoutMs above 120s cap", async () => {
    const c = makeRunCommandTool(tmp());
    expect((await run(c, { argv: ["true"], timeoutMs: 200000 })).ok).toBe(false);
  });
});

describe("git_status", () => {
  it("reports porcelain status", async () => {
    const root = tmp();
    execSync("git init -q && echo x > a.txt", { cwd: root });
    const g = makeGitStatusTool(root);
    const r = await run(g, {});
    expect(r).toMatchObject({ ok: true });
    expect(String(r.output)).toContain("a.txt");
  });
});
```

- [ ] **Step 2: 实现五个工具**（read-file/write-file/edit-file/run-command 直接 node API + normalizeProjectPath 校验；git-status 走 GitPort——为避免 Layer 复杂度，git-status 工厂直接 spawn `git status --porcelain`（与 GitCliLive 同法），P1-03 独立于 application 层组装）

read-file.ts 示例（其余同构）：

```typescript
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { normalizeProjectPath } from "../../domain/project-path.js";
import { toolFromSchema } from "../tool.js";

const READ_LIMIT = 256 * 1024;

export function makeReadFileTool(worktreeRoot: string) {
  return toolFromSchema({
    name: "read_file",
    description: "Read a file from the workspace. Path is workspace-relative with '/' separators.",
    params: Schema.Struct({ path: Schema.String }),
    execute: async (p) => {
      const n = normalizeProjectPath(p.path);
      if (n.kind === "err") throw new Error(`bad path: ${n.reason}`);
      const content = await readFile(join(worktreeRoot, n.value), "utf8");
      if (content.length > READ_LIMIT) throw new Error(`file exceeds read limit (${READ_LIMIT} bytes)`);
      return content;
    },
  });
}
```

edit-file 的匹配计数、run-command 的 spawn+timeout（setTimeout 到时 child.kill，Promise race 形态或 close 事件计数）、git-status 的 `git status --porcelain` 均按测试矩阵实现。

- [ ] **Step 3: 绿 → Commit** `feat: five agent tools with workspace-rooted paths (P1-03)`

---

### Task 5: Agent Loop + guards（TDD with Fake）

**Files:** `src/agent-runtime/agent-loop.ts`; Test `tests/unit/agent-loop.test.ts`

- [ ] **Step 1: 失败测试**（剧本驱动：工具两轮后 stop；同调用×3 触发 guard；超 25 步截断）

```typescript
import { describe, expect, it } from "vitest";
import { runAgent } from "../../src/agent-runtime/agent-loop.js";
import { FakeProviderLive } from "../../src/agent-runtime/fake-provider.js";
import type { ModelTurn } from "../../src/agent-runtime/provider.js";
import { makeWriteFileTool } from "../../src/agent-runtime/tools/write-file.js";

const toolTurn: ModelTurn = {
  content: undefined,
  toolCalls: [{ id: "c1", name: "write_file", arguments: JSON.stringify({ path: "x.txt", content: "v" }) }],
  finishReason: "tool-calls",
};
const stopTurn: ModelTurn = { content: "done", toolCalls: [], finishReason: "stop" };

describe("runAgent", () => {
  it("executes tools across turns then finishes on stop", async () => {
    const r = await runAgent({
      provider: FakeProviderLive.withScript([toolTurn, toolTurn, stopTurn]),
      tools: [makeWriteFileTool("/tmp/arbor-loop-test")],
      system: "s",
      task: "do it",
      stepLimit: 25,
    });
    expect(r.finish).toBe("stop");
    expect(r.steps).toBe(3);
  });
  it("3 consecutive identical tool calls trigger loop-guard (B4)", async () => {
    const r = await runAgent({
      provider: FakeProviderLive.withScript([toolTurn, toolTurn, toolTurn, toolTurn, stopTurn]),
      tools: [makeWriteFileTool("/tmp/arbor-loop-test")],
      system: "s",
      task: "t",
      stepLimit: 25,
    });
    expect(r.finish).toBe("loop-guard");
  });
  it("step limit terminates with diagnostic finish", async () => {
    const r = await runAgent({
      provider: FakeProviderLive.withScript(Array.from({ length: 30 }, () => toolTurn)),
      tools: [makeWriteFileTool("/tmp/arbor-loop-test")],
      system: "s",
      task: "t",
      stepLimit: 3,
    });
    expect(r.finish).toBe("step-limit");
  });
  it("tool errors are reported back as tool results, run continues", async () => {
    const r = await runAgent({
      provider: FakeProviderLive.withScript([toolTurn, stopTurn]),
      tools: [makeWriteFileTool("/tmp/arbor-loop-test")],
      system: "s",
      task: "t",
      stepLimit: 25,
    });
    expect(r.finish).toBe("stop");
    expect(r.messages.some((m) => m.role === "tool")).toBe(true);
  });
});
```

- [ ] **Step 2: 实现 runAgent**（纯函数式：接受 provider Layer + tools + system + task；内部 messages 数组推进；tool result 以 `{role:"tool", toolCallId, content: ok?output:error}` 回填；同轮 toolCalls JSON 与上轮相同则 repeatCounter++；finish: "stop" | "loop-guard" | "step-limit"；返回 `{finish, steps, messages, turns}`）

- [ ] **Step 3: 绿 → Commit** `feat: agent loop with step and repeat guards (P1-03)`

---

### Task 6: acceptance（Fake 端到端 + 真实 OpenAI 手动脚本）

**Files:** Test `tests/acceptance/agent-fake-task.test.ts`; `script/openai-smoke.ts`

- [ ] **Step 1: fake acceptance**——临时 worktree + 剧本（read_file → edit_file → stop），断言文件真的被 agent 改了。

- [ ] **Step 2: 真实 OpenAI 脚本**（`script/openai-smoke.ts`：要求 env OPENAI_API_KEY/OPENAI_MODEL；任务="创建 hello.txt 内容为 hello arbor"；跑 runAgent；校验文件存在。手动 `node --experimental-strip-types` 不行——P1 禁 tsx 运行时，脚本编译进 dist（tsconfig include src；脚本放 src/entrypoints/ 下？不——放 `src/agent-runtime/smoke.ts`？干净做法：`script/` 目录用 `pnpm build && node dist/...` 需 tsconfig include script/。最小侵入：tsconfig include 加 `"script/**/*"`（rootDir 改 "."？会破坏 dist 布局……——处理：smoke 脚本放 `src/entrypoints/openai-smoke.ts`，随主构建进 dist，运行 `node dist/entrypoints/openai-smoke.js`。）

- [ ] **Step 3: 全绿 → Commit** `test: fake end-to-end acceptance and openai smoke entry (P1-03)`

---

### Task 7: 完成报告

- [ ] 全链路 + （如用户提供 key）真实 OpenAI 任务演示 → 合同格式报告 → deviation 回填

---

## 自审记录

- **Spec coverage**: P1_03_RUNTIME_GATE A1-A4/B1-B4 全部映射（A1/A3→T2 请求体 stream:false Chat Completions；A2→T2 env 校验；A4→T1 ModelTurn；B1→T4 五工具；B2→T4 edit 矩阵；B3→T4 argv+timeout；B4→T5 guards+T4 120s cap）。P1_AGENT_RUNTIME_CONTRACT 的 Session/pause/resume/transcript 持久化 = P1-05，不在本 STEP ✓
- **占位符**: T4 其余工具"同构实现"给了 read-file 全文+差异清单（匹配计数/spawn/porcelain），T5 runAgent 给了行为规格——执行时按测试矩阵实现，语义已锁
- **类型一致性**: ModelTurn/ToolCall/ChatMessage/ToolResult 跨文件签名一致；runAgent 返回形状在 T5 测试中锁定
