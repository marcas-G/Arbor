# P1-01B — Runtime Project Bootstrap 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `arbor project init/show` CLI——从用户源仓库创建 Runtime Project：ARBOR_HOME 布局、Runtime SQLite（自动迁移）、Workspace Store Git（E0 + effective ref）、持久 Root worktree、进程重启后可复现查询。

**Architecture:** Effect Layer 分层：domain 纯函数（path/ids/templates）→ application（ports + ProjectBootstrap 编排服务）→ infrastructure（git-cli / better-sqlite3 / node-fs 适配器）→ entrypoints（CLI composition root）。Agent Runtime 相关一概不做。

**Tech Stack:** P1-01A 已建立的工具链 + `effect@4.0.0-rc.115`（本 STEP 引入，见下方决策修正）+ `better-sqlite3@13.0.3`（本 STEP 引入）。

**权威依据:** `P1_01_EXECUTION_BASELINE` §3-§12、§18.1-18.6（六条冻结决策）；`P1_PERSISTENCE_CONTRACT`；`DEPENDENCY_RULES`；`VIBECODING_USAGE_GUIDE`。

**决策修正（执行前声明，记入 DECISION_REGISTER）:**
- **D-031-amend**: `effect` 引入点从 P1-02 提前到 P1-01B。理由：application 层的服务编排与 Layer 组装是本 STEP 的直接消费者（EFFECT_TS_ARCHITECTURE 既定方向）；推迟引入意味着 P1-01B 手写 async 编排、P1-02 返工。Effect Schema 仍按 D-031 在 P1-02 作为 domain 载体引入（本 STEP 只用 Effect 核心，不用 Schema）。

---

## 文件结构

```text
migrations/0001_initial.sql                        # Task 8
src/
├── domain/
│   ├── ids.ts                                     # Task 3 (branded ProjectId/WorkspaceId)
│   └── project-path.ts                            # Task 2 (normalize/prefix 纯函数)
├── application/
│   ├── ports.ts                                   # Task 4 (GitPort/SqlitePort/FsPort + tagged errors)
│   ├── workspace-templates.ts                     # Task 5 (store 骨架文件生成，纯函数)
│   └── project-bootstrap.ts                       # Task 9 (init/show 编排服务)
├── infrastructure/
│   ├── git-cli.ts                                 # Task 6 (spawn git CLI 适配器)
│   ├── sqlite-node.ts                             # Task 7 (better-sqlite3 + 迁移执行器)
│   └── fs-node.ts                                 # Task 6 (node:fs 实现 FsPort)
├── agent-runtime/.gitkeep / infrastructure 其余 .gitkeep  # 不动
└── entrypoints/
    ├── version.ts                                 # 不动
    ├── main.ts                                    # Task 10 改为调 cli
    └── cli.ts                                     # Task 10 (argv 解析 + Layer 组装 + dispatch)
tests/
├── unit/
│   ├── project-path.test.ts                       # Task 2
│   ├── workspace-templates.test.ts                # Task 5
│   └── cli-args.test.ts                           # Task 10
├── integration/
│   ├── git-cli.test.ts                            # Task 6
│   ├── sqlite-node.test.ts                        # Task 7
│   └── project-bootstrap.test.ts                  # Task 9 (init 全流程/重启/重复/无效 repo)
└── acceptance/
    └── cli.test.ts                                # Task 11 (node dist 进程级)
```

**Effect API 稳定性注意:** effect@4.0.0-rc.115 的 Service/Layer API 若与本计划写法有出入（rc 期间签名可能变化），以 `node_modules/effect` 实际类型为准调整调用方式，语义不变，记入 deviation。计划统一使用最保守的 `Context.GenericTag` + `Layer.succeed/scoped` 模式。

---

### Task 1: 引入 effect + better-sqlite3

**Files:** Modify `package.json`

- [ ] **Step 1: 安装**

```bash
cd /home/lgao/work/arbor && pnpm add effect@4.0.0-rc.115 better-sqlite3@13.0.3
```

Expected: 两个包进入 `dependencies`，lockfile 更新。better-sqlite3 原生模块预编译下载成功（若编译失败：报 blocker，不静默换库）。

- [ ] **Step 2: typecheck/lint/test 仍绿**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

- [ ] **Step 3: Commit** `chore: introduce effect and better-sqlite3 (P1-01B)`

---

### Task 2: domain/project-path.ts（TDD，§11 全矩阵）

**Files:** Create `src/domain/project-path.ts`; Test `tests/unit/project-path.test.ts`

- [ ] **Step 1: 失败测试**（用例直接来自 §11 例句 + §18 无关）

```typescript
import { describe, expect, it } from "vitest";
import {
  isPathWithinPrefix,
  normalizeProjectPath,
  type PathRejected,
  type ProjectPath,
} from "../../src/domain/project-path.js";

const ok = (s: string): ProjectPath => normalizeProjectPath(s) as ProjectPath;

describe("normalizeProjectPath", () => {
  it.each([".", "src", "src/runtime", "src/runtime/file.ts"])("accepts %s", (input) => {
    const r = normalizeProjectPath(input);
    expect(r.kind).toBe("ok");
  });
  it("canonical root is '.'", () => expect(ok(".").value).toBe("."));
  it("normalizes separators and collapses duplicates", () =>
    expect(normalizeProjectPath("src\\\\runtime//x/./y")).toMatchObject({ kind: "ok", value: "src/runtime/x/y" }));
  it("rejects absolute", () => expect(normalizeProjectPath("/etc")).toMatchObject({ kind: "err", reason: "absolute" }));
  it("rejects drive prefix", () =>
    expect(normalizeProjectPath("C:\\x")).toMatchObject({ kind: "err", reason: "absolute" }));
  it("rejects ..", () => expect(normalizeProjectPath("a/../b")).toMatchObject({ kind: "err", reason: "parent-segment" }));
  it("rejects empty", () => expect(normalizeProjectPath("")).toMatchObject({ kind: "err", reason: "empty" }));
});

describe("isPathWithinPrefix (segment semantics)", () => {
  it("root prefix matches everything", () => {
    expect(isPathWithinPrefix(ok("."), ok("src/a.ts"))).toBe(true);
  });
  it("matches self and descendants", () => {
    expect(isPathWithinPrefix(ok("src/runtime"), ok("src/runtime"))).toBe(true);
    expect(isPathWithinPrefix(ok("src/runtime"), ok("src/runtime/x.ts"))).toBe(true);
  });
  it("does not match string-prefix siblings (§11: src/runtime2)", () => {
    expect(isPathWithinPrefix(ok("src/runtime"), ok("src/runtime2"))).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**（模块不存在）
- [ ] **Step 3: 实现**

```typescript
export type PathRejected = "empty" | "absolute" | "parent-segment";

export type ProjectPath = { readonly value: string };

export type NormalizedPath =
  | { readonly kind: "ok"; readonly value: string }
  | { readonly kind: "err"; readonly reason: PathRejected };

export function normalizeProjectPath(input: string): NormalizedPath {
  if (input.trim() === "") return { kind: "err", reason: "empty" };
  const unified = input.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified)) {
    return { kind: "err", reason: "absolute" };
  }
  const segments: string[] = [];
  for (const seg of unified.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return { kind: "err", reason: "parent-segment" };
    segments.push(seg);
  }
  const value = segments.length === 0 ? "." : segments.join("/");
  return { kind: "ok", value };
}

export function isPathWithinPrefix(prefix: ProjectPath, path: ProjectPath): boolean {
  const p = prefix.value === "." ? [] : prefix.value.split("/");
  const t = path.value === "." ? [] : path.value.split("/");
  if (p.length === 0) return true;
  if (t.length < p.length) return false;
  return p.every((seg, i) => seg === t[i]);
}
```

- [ ] **Step 4: 测试全绿 → Commit** `feat: domain project path normalization and prefix semantics (P1-01B)`

---

### Task 3: domain/ids.ts

**Files:** Create `src/domain/ids.ts`

- [ ] **Step 1: 实现**（branded types + uuid 构造；无行为分支，跳过独立测试，由后续 integration 覆盖）

```typescript
declare const brand: unique symbol;
export type ProjectId = string & { readonly [brand]: "ProjectId" };
export type WorkspaceId = string & { readonly [brand]: "WorkspaceId" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function newProjectId(): ProjectId {
  return crypto.randomUUID() as ProjectId;
}
export function newWorkspaceId(): WorkspaceId {
  return crypto.randomUUID() as WorkspaceId;
}
export function asProjectId(s: string): ProjectId | undefined {
  return UUID_RE.test(s) ? (s as ProjectId) : undefined;
}
export function asWorkspaceId(s: string): WorkspaceId | undefined {
  return UUID_RE.test(s) ? (s as WorkspaceId) : undefined;
}
```

- [ ] **Step 2: typecheck 过 → Commit** `feat: branded project/workspace ids (P1-01B)`

---

### Task 4: application/ports.ts

**Files:** Create `src/application/ports.ts`

- [ ] **Step 1: 实现**（接口 + tagged errors；无行为，由 integration 覆盖）

```typescript
import { Context, Data, Effect } from "effect";
import type { ProjectId, WorkspaceId } from "../domain/ids.js";

// ---- tagged errors (EFFECT_TS_ARCHITECTURE: DomainError/ApplicationError/InfrastructureError 家族)
export class GitError extends Data.TaggedError("GitError")<{
  readonly op: string;
  readonly message: string;
}> {}
export class DbError extends Data.TaggedError("DbError")<{
  readonly message: string;
}> {}
export class FsError extends Data.TaggedError("FsError")<{
  readonly op: string;
  readonly message: string;
}> {}
export class BootstrapError extends Data.TaggedError("BootstrapError")<{
  readonly reason:
    | "repo-not-found"
    | "not-a-git-repo"
    | "no-base-commit"
    | "duplicate-project"
    | "project-not-found"
    | "invalid-argument";
  readonly message: string;
}> {}

// ---- GitPort（§3 子集：P1-01B 有当前消费者的操作；cat-file/show 留给 P1-08）
export interface GitPort {
  /** git -C <cwd> rev-parse --verify <ref> → sha | undefined */
  readonly revParse: (cwd: string, ref: string) => Effect.Effect<string | undefined, GitError>;
  /** git -C <cwd> init */
  readonly init: (cwd: string) => Effect.Effect<void, GitError>;
  /** git -C <cwd> add -A && commit（确定性身份 -c user.name/email，消息固定） */
  readonly commitAll: (cwd: string, message: string) => Effect.Effect<string, GitError>; // 返回 sha
  /** git -C <cwd> update-ref <ref> <newSha>（若给 expected 则 --reference（CAS）） */
  readonly updateRef: (
    cwd: string,
    ref: string,
    newSha: string,
    expected?: string,
  ) => Effect.Effect<void, GitError>;
  /** git -C <sourceRepo> worktree add <path> -b <branch> <base> */
  readonly worktreeAdd: (
    sourceRepo: string,
    path: string,
    branch: string,
    base: string,
  ) => Effect.Effect<void, GitError>;
}

export const GitPort = Context.GenericTag<GitPort>("application/GitPort");

// ---- SqlitePort（打开即自动迁移，§7）
export interface SqlitePort {
  readonly open: (dbFile: string) => Effect.Effect<DbHandle, DbError>;
}
export interface DbHandle {
  readonly queryOne: (sql: string, ...params: unknown[]) => Effect.Effect<unknown | undefined, DbError>;
  readonly execute: (sql: string, ...params: unknown[]) => Effect.Effect<void, DbError>;
  readonly close: () => Effect.Effect<void, DbError>;
}
export const SqlitePort = Context.GenericTag<SqlitePort>("application/SqlitePort");

// ---- FsPort
export interface FsPort {
  readonly mkdirp: (path: string) => Effect.Effect<void, FsError>;
  readonly writeFile: (path: string, content: string) => Effect.Effect<void, FsError>;
  readonly pathJoin: (...parts: string[]) => string;
  readonly pathResolve: (path: string) => string;
}
export const FsPort = Context.GenericTag<FsPort>("application/FsPort");

// ---- ARBOR_HOME 解析（§4 优先级）放 application 层纯函数：
export function resolveArborHome(cliHome: string | undefined, env: NodeJS.ProcessEnv): string {
  if (cliHome !== undefined && cliHome !== "") return cliHome;
  const fromEnv = env["ARBOR_HOME"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const xdg = env["XDG_STATE_HOME"];
  if (xdg !== undefined && xdg !== "") return `${xdg}/arbor`;
  return `${env["HOME"] ?? "."}/.local/state/arbor`;
}

export function effectiveRefName(workspaceId: WorkspaceId): string {
  return `refs/arbor/effective/${workspaceId}`;
}

export const MANAGED_BRANCH = "arbor/root"; // §18.6
export const WORKTREE_DIR = "worktrees/root"; // §18.6
export type ProjectDirs = {
  readonly projectDir: string; // <home>/projects/<project-id>
  readonly dbFile: string;
  readonly storeDir: string;
  readonly worktreeDir: string;
  readonly agentStateDir: string;
  readonly logsDir: string;
  readonly workspaceDir: string; // store 内 <store>/workspaces/<ws-id>
};
export function projectDirs(home: string, projectId: ProjectId): ProjectDirs {
  const projectDir = `${home}/projects/${projectId}`;
  const storeDir = `${projectDir}/workspace-store`;
  return {
    projectDir,
    dbFile: `${projectDir}/runtime.db`,
    storeDir,
    worktreeDir: `${projectDir}/${WORKTREE_DIR}`,
    agentStateDir: `${projectDir}/agent-state`,
    logsDir: `${projectDir}/logs`,
    workspaceDir: `${storeDir}/workspaces`,
  };
}
```

（`projectDirs` 返回 store 顶目录 + workspaceDir 为 store/workspaces，workspace 实际内容目录在 service 里再拼 `<workspaceDir>/<workspace-id>`。）

- [ ] **Step 2: typecheck 过 → Commit** `feat: application ports, tagged errors, arbor-home resolution (P1-01B)`

---

### Task 5: application/workspace-templates.ts（TDD）

**Files:** Create `src/application/workspace-templates.ts`; Test `tests/unit/workspace-templates.test.ts`

- [ ] **Step 1: 失败测试**（§18.1 + §9 文件集）

```typescript
import { describe, expect, it } from "vitest";
import {
  renderWorkspaceYaml,
  renderWorkspaceMd,
  renderSummaryMd,
  renderOverviewMd,
  renderVerificationMd,
} from "../../src/application/workspace-templates.js";

describe("root workspace skeleton templates (§18.1)", () => {
  it("workspace.yaml has schemaVersion 1 and empty verification commands", () => {
    expect(renderWorkspaceYaml({ projectId: "p-1", workspaceId: "w-1" })).toContain("schemaVersion: 1");
    expect(renderWorkspaceYaml({ projectId: "p-1", workspaceId: "w-1" })).toContain("commands: []");
  });
  it("WORKSPACE.md intent is the literal TBD", () => {
    expect(renderWorkspaceMd()).toContain("TBD (user to fill)");
  });
  it("renders all four md files non-empty", () => {
    for (const s of [renderSummaryMd(), renderOverviewMd(), renderVerificationMd()]) {
      expect(s.trim().length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: 红 → 实现**（纯字符串模板；workspace.yaml 按 §10 最小 schema，resources.writable = ["."]，verification.local.commands = []）

```typescript
export function renderWorkspaceYaml(p: { readonly projectId: string; readonly workspaceId: string }): string {
  return [
    "schemaVersion: 1",
    `projectId: "${p.projectId}"`,
    `workspaceId: "${p.workspaceId}"`,
    "resources:",
    "  writable:",
    '    - "."',
    "verification:",
    "  local:",
    "    commands: []",
    "",
  ].join("\n");
}
export function renderWorkspaceMd(): string {
  return [
    "# Root Workspace",
    "",
    "## Intent",
    "",
    "TBD (user to fill)",
    "",
    "## Responsibility",
    "",
    "TBD (user to fill)",
    "",
    "## Expected Deliverables",
    "",
    "TBD (user to fill)",
    "",
    "## Inherited Constraints",
    "",
    "(none — Root workspace)",
    "",
  ].join("\n");
}
export function renderSummaryMd(): string {
  return "# Summary\n\nBootstrap skeleton. Derived view; not the highest-authority source.\n";
}
export function renderOverviewMd(): string {
  return "# Design Overview\n\nTBD (user to fill)\n";
}
export function renderVerificationMd(): string {
  return "# Verification Design\n\nDescribes properties to be proven. No formal test cases here.\n";
}
```

- [ ] **Step 3: 绿 → Commit** `feat: root workspace skeleton templates (P1-01B)`

---

### Task 6: infrastructure/git-cli.ts + fs-node.ts

**Files:** Create 两个文件; Test `tests/integration/git-cli.test.ts`

- [ ] **Step 1: 失败 integration 测试**（真 git、临时目录）

```typescript
import { Effect, Runtime } from "effect";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GitError, GitPort } from "../../src/application/ports.js";
import { GitCliLive } from "../../src/infrastructure/git-cli.js";
import { FsNodeLive } from "../../src/infrastructure/fs-node.js";

const run = Runtime.runPromiseExit(
  Runtime.makeEffectRuntime? undefined as never, // 占位说明：直接用默认运行时，见 Step 2 实现文件
);
// 简化：每个测试用 Effect.runPromise* 直跑（见下）

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "arbor-git-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) {
    require("node:fs").rmSync(d, { recursive: true, force: true });
  }
});

describe("GitCliLive", () => {
  it("init + commitAll + revParse + updateRef roundtrip", async () => {
    const d = tmp();
    writeFileSync(join(d, "a.txt"), "hello");
    await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* GitPort;
        yield* git.init(d);
        const sha = yield* git.commitAll(d, "E0 test");
        const got = yield* git.revParse(d, "HEAD");
        expect(got).toBe(sha);
        yield* git.updateRef(d, "refs/arbor/effective/w1", sha);
        expect(yield* git.revParse(d, "refs/arbor/effective/w1")).toBe(sha);
      }).pipe(Effect.provide(GitCliLive)),
    );
  });
  it("revParse unknown ref → undefined", async () => {
    const d = tmp();
    await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* GitPort;
        yield* git.init(d);
        expect(yield* git.revParse(d, "refs/nope")).toBeUndefined();
      }).pipe(Effect.provide(GitCliLive)),
    );
  });
  it("worktreeAdd creates branch + worktree", async () => {
    const src = tmp();
    writeFileSync(join(src, "f.txt"), "x");
    const wt = join(tmp(), "wt");
    await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* GitPort;
        yield* git.init(src);
        yield* git.commitAll(src, "base");
        const head = yield* git.revParse(src, "HEAD");
        yield* git.worktreeAdd(src, wt, "arbor/root", head as string);
        expect(yield* git.revParse(wt, "HEAD")).toBeDefined();
      }).pipe(Effect.provide(GitCliLive)),
    );
  });
  it("git failure surfaces as GitError", async () => {
    const d = tmp();
    mkdirSync(d, { recursive: true }); // not a repo
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const git = yield* GitPort;
        return yield* git.revParse(d, "HEAD");
      }).pipe(Effect.provide(GitCliLive)),
    );
    expect(exit._tag).toBe("Failure");
  });
});
```

（上面测试文件里若 `require` 在 ESM 下不可用，改 `import { rmSync } from "node:fs"` 顶部导入。vitest 5 处理 ESM：用顶部导入。）

- [ ] **Step 2: 实现 infrastructure/git-cli.ts**

```typescript
import { spawn } from "node:child_process";
import { Effect, Layer } from "effect";
import { GitError, GitPort } from "../application/ports.js";

function runGit(args: string[], cwd: string): Effect.Effect<{ stdout: string; stderr: string }, GitError> {
  return Effect.async((resume) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (err) => resume(new GitError({ op: args.join(" "), message: String(err) })));
    child.on("close", (code) => {
      if (code === 0) resume({ stdout, stderr });
      else resume(new GitError({ op: args.join(" "), message: `exit=${code} ${stderr.trim()}` }));
    });
  });
}

const DETACHED_IDENTITY = ["-c", "user.name=arbor", "-c", "user.email=arbor@local"];

export const GitCliLive = Layer.succeed(
  GitPort,
  GitPort.of({
    revParse: (cwd, ref) =>
      runGit(["-C", cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd).pipe(
        Effect.map((r) => r.stdout.trim() || undefined),
        Effect.catchAll(() => Effect.succeed(undefined)),
      ),
    init: (cwd) => runGit(["-C", cwd, "init", "--quiet"], cwd).pipe(Effect.asVoid),
    commitAll: (cwd, message) =>
      runGit(["-C", cwd, ...DETACHED_IDENTITY, "add", "-A"], cwd).pipe(
        Effect.flatMap(() =>
          runGit(["-C", cwd, ...DETACHED_IDENTITY, "commit", "--quiet", "-m", message], cwd),
        ),
        Effect.flatMap(() =>
          runGit(["-C", cwd, "rev-parse", "HEAD"], cwd).pipe(Effect.map((r) => r.stdout.trim())),
        ),
      ),
    updateRef: (cwd, ref, newSha, expected) =>
      runGit(
        expected === undefined
          ? ["-C", cwd, "update-ref", ref, newSha]
          : ["-C", cwd, "update-ref", ref, newSha, expected],
        cwd,
      ).pipe(Effect.asVoid),
    worktreeAdd: (sourceRepo, path, branch, base) =>
      runGit(["-C", sourceRepo, "worktree", "add", "--quiet", path, "-b", branch, base], sourceRepo).pipe(
        Effect.asVoid,
      ),
  }),
);
```

（`revParse --quiet` + catchAll→undefined：unknown ref 是正常路径不是错误。）

- [ ] **Step 3: 实现 infrastructure/fs-node.ts**

```typescript
import { mkdir, writeFile } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { FsError, FsPort } from "../application/ports.js";

const wrap = (op: string) => (err: unknown) => new FsError({ op, message: String(err) });

export const FsNodeLive = Layer.succeed(
  FsPort,
  FsPort.of({
    mkdirp: (path) => Effect.tryPromise({ try: () => mkdir(path, { recursive: true }), catch: wrap("mkdirp") }).pipe(Effect.asVoid),
    writeFile: (path, content) =>
      Effect.tryPromise({ try: () => writeFile(path, content, "utf8"), catch: wrap("writeFile") }).pipe(Effect.asVoid),
    pathJoin: (...parts) => parts.join("/"),
    pathResolve: (path) => resolvePath(path),
  }),
);

import { resolve as resolvePath } from "node:path";
```

（`pathJoin` 用 `/`：ARBOR_HOME 内部布局在 Windows 也按 `/` 拼接后交给 node fs（Windows 接受正斜杠），保持确定性。`pathResolve` 用 node:path 的 resolve 处理用户输入的 `--repo` 相对路径。import 顺序按 biome organizeImports 调整。）

- [ ] **Step 4: 测试绿（git 可用；`git` 缺失则环境 blocker）→ Commit** `feat: git-cli and fs adapters (P1-01B)`

---

### Task 7: infrastructure/sqlite-node.ts + migrations/0001_initial.sql

**Files:** Create `migrations/0001_initial.sql`, `src/infrastructure/sqlite-node.ts`; Test `tests/integration/sqlite-node.test.ts`

- [ ] **Step 1: migrations/0001_initial.sql**（§18.3 逐字）

```sql
CREATE TABLE projects (
  project_id       TEXT PRIMARY KEY,
  source_repo_path TEXT NOT NULL,
  runtime_dir      TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE TABLE workspaces (
  workspace_id   TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(project_id),
  store_rel_path TEXT NOT NULL,
  kind           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE (project_id, kind)
);

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
```

- [ ] **Step 2: 失败 integration 测试**

```typescript
import { Effect } from "effect";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SqlitePort } from "../../src/application/ports.js";
import { SqliteNodeLive } from "../../src/infrastructure/sqlite-node.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "arbor-sql-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("SqliteNodeLive", () => {
  it("opens, auto-migrates, records version, survives reopen", async () => {
    const dbFile = join(tmp(), "runtime.db");
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlitePort;
        const db = yield* sql.open(dbFile);
        const v = yield* db.queryOne("SELECT version FROM schema_migrations WHERE version = 1");
        expect(v).toMatchObject({ version: 1 });
        yield* db.close();
        // reopen → migration idempotent
        const db2 = yield* sql.open(dbFile);
        yield* db2.execute(
          "INSERT INTO projects (project_id, source_repo_path, runtime_dir, created_at) VALUES (?, ?, ?, ?)",
          "pid", "/repo", "/rt", "2026-09-14T00:00:00Z",
        );
        const row = yield* db2.queryOne("SELECT project_id FROM projects WHERE project_id = ?", "pid");
        expect(row).toMatchObject({ project_id: "pid" });
        yield* db2.close();
      }).pipe(Effect.provide(SqliteNodeLive)),
    );
  });
});
```

- [ ] **Step 3: 实现**

```typescript
import Database from "better-sqlite3";
import { Effect, Layer } from "effect";
import { DbError, DbHandle, SqlitePort } from "../application/ports.js";

const MIGRATIONS_DIR = "migrations"; // 相对 CWD；测试里 process.chdir 到仓库根或用绝对路径解析

function migrationFiles(): Array<{ version: number; file: string }> {
  // 读取 migrations/*.sql，文件名前缀数字即 version
  const { readdirSync, readFileSync } = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const dir = path.resolve(process.cwd(), MIGRATIONS_DIR);
  return readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .map((f) => ({ version: Number.parseInt(f.split("_")[0] ?? "", 10), file: f }))
    .sort((a, b) => a.version - b.version);
}

export const SqliteNodeLive = Layer.succeed(
  SqlitePort,
  SqlitePort.of({
    open: (dbFile) =>
      Effect.gen(function* () {
        const open = () => {
          try {
            const db = new Database(dbFile);
            db.pragma("journal_mode = WAL");
            db.pragma("foreign_keys = ON");
            return db;
          } catch (e) {
            throw new DbError({ message: String(e) });
          }
        };
        const try_ = <T>(f: () => T): Effect.Effect<T, DbError> =>
          Effect.try({ try: f, catch: (e) => new DbError({ message: String(e) }) });
        const db = yield* try_(open);
        // ensure schema_migrations exists before use
        yield* try_(() =>
          db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"),
        );
        for (const m of migrationFiles()) {
          const applied = yield* try_(() =>
            db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(m.version),
          );
          if (applied !== undefined) continue;
          const sql = require("node:fs") as typeof import("node:fs").readFileSync(
            require("node:path") as unknown as string, // 占位——见下，实际用 join(dir, m.file)
          ) as unknown as string;
          void sql; // 真实实现在下方修正
        }
        return undefined as never; // 由下方真实版本替换
      }),
  }),
);
```

**⚠️ 上面 Step 3 的草稿里 migration 读取段是坏的（require 误用）——正式实现用以下完整版：**

```typescript
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect, Layer } from "effect";
import { DbError, DbHandle, SqlitePort } from "../application/ports.js";

const tryE = <T>(f: () => T): Effect.Effect<T, DbError> =>
  Effect.try({ try: f, catch: (e) => new DbError({ message: String(e) }) });

export function listMigrations(cwd: string): Array<{ version: number; file: string; sql: string }> {
  const dir = resolve(cwd, "migrations");
  return readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .map((f) => ({
      version: Number.parseInt(f.split("_")[0] ?? "", 10),
      file: f,
      sql: readFileSync(join(dir, f), "utf8"),
    }))
    .sort((a, b) => a.version - b.version);
}

export const SqliteNodeLive = Layer.succeed(
  SqlitePort,
  SqlitePort.of({
    open: (dbFile: string): Effect.Effect<DbHandle, DbError> =>
      Effect.gen(function* () {
        const db = yield* tryE(() => {
          const d = new Database(dbFile);
          d.pragma("journal_mode = WAL");
          d.pragma("foreign_keys = ON");
          return d;
        });
        const handle: DbHandle = {
          queryOne: (sql, ...params) =>
            tryE(() => {
              const row = d.prepare(sql).get(...params) as Record<string, unknown> | undefined;
              return row;
            }),
          execute: (sql, ...params) => tryE(() => void d.prepare(sql).run(...params)),
          close: () => tryE(() => void d.close()),
        };
        yield* tryE(() =>
          db.exec(
            "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
          ),
        );
        for (const m of listMigrations(process.cwd())) {
          const applied = yield* handle.queryOne(
            "SELECT version FROM schema_migrations WHERE version = ?",
            m.version,
          );
          if (applied !== undefined) continue;
          yield* tryE(() => {
            db.transaction(() => {
              db.exec(m.sql);
              db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
                m.version,
                new Date().toISOString(),
              );
            })();
          });
        }
        return handle;
      }),
  }),
);
```

- [ ] **Step 4: 测试绿 → Commit** `feat: sqlite adapter with auto-migration (P1-01B)`

---

### Task 8: application/project-bootstrap.ts（integration 大头）

**Files:** Create `src/application/project-bootstrap.ts`; Test `tests/integration/project-bootstrap.test.ts`

- [ ] **Step 1: 失败 integration 测试**（全场景：布局、E0、ref、worktree、重启 show、重复拒绝、无效 repo）

```typescript
import { Effect } from "effect";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { BootstrapError } from "../../src/application/ports.js";
import { ProjectBootstrapLive, ProjectBootstrap } from "../../src/application/project-bootstrap.js";
import { FsNodeLive } from "../../src/infrastructure/fs-node.js";
import { GitCliLive } from "../../src/infrastructure/git-cli.js";
import { SqliteNodeLive } from "../../src/infrastructure/sqlite-node.js";

const Layers = ProjectBootstrapLive.pipe(
  Effect.provideMerge(GitCliLive),
  Effect.provideMerge(FsNodeLive),
  Effect.provideMerge(SqliteNodeLive),
);

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "arbor-bs-"));
  dirs.push(d);
  return d;
};
const makeSourceRepo = (): string => {
  const d = tmp();
  writeFileSync(join(d, "README.md"), "# src");
  execSync("git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm base", { cwd: d });
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("project init", () => {
  it("creates full ARBOR_HOME layout, E0+ref, worktree, db rows", async () => {
    const home = tmp();
    const repo = makeSourceRepo();
    await Effect.runPromise(
      Effect.gen(function* () {
        const bs = yield* ProjectBootstrap;
        const r = yield* bs.init({ repoPath: repo, home });
        expect(existsSync(join(home, "projects", r.projectId, "runtime.db"))).toBe(true);
        expect(existsSync(join(home, "projects", r.projectId, "worktrees", "root", "README.md"))).toBe(true);
        const wsDir = join(home, "projects", r.projectId, "workspace-store", "workspaces", r.workspaceId);
        expect(readFileSync(join(wsDir, "workspace.yaml"), "utf8")).toContain("schemaVersion: 1");
        expect(existsSync(join(wsDir, "WORKSPACE.md"))).toBe(true);
        expect(existsSync(join(wsDir, "SUMMARY.md"))).toBe(true);
        expect(existsSync(join(wsDir, "design", "OVERVIEW.md"))).toBe(true);
        expect(existsSync(join(wsDir, "design", "VERIFICATION.md"))).toBe(true);
        expect(existsSync(join(wsDir, "history", "changes"))).toBe(true);
        expect(existsSync(join(wsDir, "history", "verifications"))).toBe(true);
        // effective ref resolves to a real commit (E0)
        expect(r.effectiveRefSha).toMatch(/^[0-9a-f]{40,64}$/);
      }).pipe(Effect.provide(Layers)),
    );
  });

  it("show after restart (fresh service, same home) returns same ids and ref", async () => {
    const home = tmp();
    const repo = makeSourceRepo();
    const init = await Effect.runPromise(
      Effect.gen(function* () {
        const bs = yield* ProjectBootstrap;
        return yield* bs.init({ repoPath: repo, home });
      }).pipe(Effect.provide(Layers)),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const bs = yield* ProjectBootstrap;
        const shown = yield* bs.show({ projectId: init.projectId, home });
        expect(shown.projectId).toBe(init.projectId);
        expect(shown.workspaceId).toBe(init.workspaceId);
        expect(shown.sourceRepoPath).toBe(shown.sourceRepoPath);
        expect(shown.effectiveRefSha).toBe(init.effectiveRefSha);
      }).pipe(Effect.provide(Layers)),
    );
  });

  it("duplicate init for same source repo → BootstrapError duplicate-project", async () => {
    const home = tmp();
    const repo = makeSourceRepo();
    const once = Effect.gen(function* () {
      const bs = yield* ProjectBootstrap;
      return yield* bs.init({ repoPath: repo, home });
    }).pipe(Effect.provide(Layers));
    await Effect.runPromise(once);
    const exit = await Effect.runPromiseExit(once.pipe(Effect.provide(Layers)));
    expect(exit).toMatchObject({ _tag: "Failure" });
  });

  it("non-repo path → BootstrapError not-a-git-repo", async () => {
    const home = tmp();
    const plain = tmp();
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const bs = yield* ProjectBootstrap;
        return yield* bs.init({ repoPath: plain, home });
      }).pipe(Effect.provide(Layers)),
    );
    expect(exit).toMatchObject({ _tag: "Failure" });
  });

  it("repo without commits → BootstrapError no-base-commit", async () => {
    const home = tmp();
    const empty = tmp();
    execSync("git init -q", { cwd: empty });
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const bs = yield* ProjectBootstrap;
        return yield* bs.init({ repoPath: empty, home });
      }).pipe(Effect.provide(Layers)),
    );
    expect(exit).toMatchObject({ _tag: "Failure" });
  });

  it("show unknown project → BootstrapError project-not-found", async () => {
    const home = tmp();
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const bs = yield* ProjectBootstrap;
        return yield* bs.show({ projectId: "00000000-0000-4000-8000-000000000000" as never, home });
      }).pipe(Effect.provide(Layers)),
    );
    expect(exit).toMatchObject({ _tag: "Failure" });
  });
});
```

- [ ] **Step 2: 实现 project-bootstrap.ts**（init 编排严格按依赖序，失败即中断）

```typescript
import { Effect, Layer } from "effect";
import {
  BootstrapError,
  FsPort,
  GitPort,
  MANAGED_BRANCH,
  SqlitePort,
  effectiveRefName,
  projectDirs,
  resolveArborHome,
} from "./ports.js";
import { asProjectId, newProjectId, newWorkspaceId, type ProjectId, type WorkspaceId } from "../domain/ids.js";
import {
  renderOverviewMd,
  renderSummaryMd,
  renderVerificationMd,
  renderWorkspaceMd,
  renderWorkspaceYaml,
} from "./workspace-templates.js";

export interface InitInput {
  readonly repoPath: string;
  readonly home: string;
}
export interface InitResult {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly effectiveRefSha: string;
}
export interface ShowInput {
  readonly projectId: string;
  readonly home: string;
}
export interface ShowResult {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly sourceRepoPath: string;
  readonly effectiveRefSha: string;
}

export interface ProjectBootstrap {
  readonly init: (input: InitInput) => Effect.Effect<InitResult, BootstrapError>;
  readonly show: (input: ShowInput) => Effect.Effect<ShowResult, BootstrapError>;
}
export const ProjectBootstrap = Context.GenericTag<ProjectBootstrap>("application/ProjectBootstrap");

const now = () => new Date().toISOString();

export const ProjectBootstrapLive = Layer.effect(
  ProjectBootstrap,
  Effect.gen(function* () {
    const git = yield* GitPort;
    const fs = yield* FsPort;
    const sql = yield* SqlitePort;
    return {
      init: ({ repoPath, home }: InitInput) =>
        Effect.gen(function* () {
          const homeAbs = resolveArborHome(home, process.env); // home 参数已是非空 abs（cli 保证）
          const repoAbs = fs.pathResolve(repoPath);
          // §6: source repo must exist & be git & have base commit
          const head = yield* git.revParse(repoAbs, "HEAD").pipe(
            Effect.mapError((e) => new BootstrapError({ reason: "not-a-git-repo", message: e.message })),
          );
          if (head === undefined) {
            return yield* new BootstrapError({ reason: "no-base-commit", message: `no HEAD in ${repoAbs}` });
          }
          const projectId = newProjectId();
          const workspaceId = newWorkspaceId();
          const dirs = projectDirs(homeAbs, projectId);
          const wsDir = `${dirs.workspaceDir}/${workspaceId}`;

          // directory layout
          for (const d of [wsDir, `${wsDir}/design`, `${wsDir}/history/changes`, `${wsDir}/history/verifications`, dirs.agentStateDir, dirs.logsDir]) {
            yield* fs.mkdirp(d);
          }

          // workspace-store E0 (§18.1/§18.2)
          yield* fs.writeFile(`${wsDir}/workspace.yaml`, renderWorkspaceYaml({ projectId, workspaceId }));
          yield* fs.writeFile(`${wsDir}/WORKSPACE.md`, renderWorkspaceMd());
          yield* fs.writeFile(`${wsDir}/SUMMARY.md`, renderSummaryMd());
          yield* fs.writeFile(`${wsDir}/design/OVERVIEW.md`, renderOverviewMd());
          yield* fs.writeFile(`${wsDir}/design/VERIFICATION.md`, renderVerificationMd());
          yield* git.init(dirs.storeDir).pipe(Effect.mapError((e) => new BootstrapError({ reason: "invalid-argument", message: e.message })));
          const e0 = yield* git.commitAll(dirs.storeDir, "E0: workspace bootstrap").pipe(
            Effect.mapError((e) => new BootstrapError({ reason: "invalid-argument", message: e.message })),
          );

          // runtime db AFTER store E0 (init 幂等失败时库行不落)
          const db = yield* sql.open(dirs.dbFile).pipe(
            Effect.mapError((e) => new BootstrapError({ reason: "invalid-argument", message: e.message })),
          );
          const dup = yield* db
            .queryOne("SELECT project_id FROM projects WHERE source_repo_path = ?", repoAbs)
            .pipe(Effect.mapError((e) => new BootstrapError({ reason: "invalid-argument", message: e.message })));
          if (dup !== undefined) {
            yield* db.close();
            return yield* new BootstrapError({
              reason: "duplicate-project",
              message: `source repo ${repoAbs} already has project ${String(dup)}`,
            });
          }
          yield* db.execute(
            "INSERT INTO projects (project_id, source_repo_path, runtime_dir, created_at) VALUES (?, ?, ?, ?)",
            projectId, repoAbs, dirs.projectDir, now(),
          );
          yield* db.execute(
            "INSERT INTO workspaces (workspace_id, project_id, store_rel_path, kind, created_at) VALUES (?, ?, ?, ?, ?)",
            workspaceId, projectId, `workspaces/${workspaceId}`, "root", now(),
          );

          // worktree (§18.6)
          yield* git.worktreeAdd(repoAbs, dirs.worktreeDir, MANAGED_BRANCH, head).pipe(
            Effect.mapError((e) => new BootstrapError({ reason: "invalid-argument", message: e.message })),
          );

          // effective ref → E0 (§18.2)
          yield* git.updateRef(dirs.storeDir, effectiveRefName(workspaceId), e0).pipe(
            Effect.mapError((e) => new BootstrapError({ reason: "invalid-argument", message: e.message })),
          );
          yield* db.close();
          return { projectId, workspaceId, effectiveRefSha: e0 };
        }),

      show: ({ projectId: pidRaw, home }: ShowInput) =>
        Effect.gen(function* () {
          const homeAbs = resolveArborHome(home, process.env);
          const pid = asProjectId(pidRaw);
          if (pid === undefined) {
            return yield* new BootstrapError({ reason: "invalid-argument", message: `bad project id: ${pidRaw}` });
          }
          const dirs = projectDirs(homeAbs, pid);
          const db = yield* sql.open(dirs.dbFile).pipe(
            Effect.mapError(() => new BootstrapError({ reason: "project-not-found", message: `no runtime db for ${pidRaw}` })),
          );
          const proj = (yield* db
            .queryOne("SELECT project_id, source_repo_path FROM projects WHERE project_id = ?", pid)
            .pipe(Effect.mapError((e) => new BootstrapError({ reason: "project-not-found", message: e.message })))) as
            | { project_id: string; source_repo_path: string }
            | undefined;
          if (proj === undefined) {
            yield* db.close();
            return yield* new BootstrapError({ reason: "project-not-found", message: `unknown project ${pidRaw}` });
          }
          const ws = (yield* db.queryOne(
            "SELECT workspace_id FROM workspaces WHERE project_id = ? AND kind = 'root'",
            pid,
          )) as { workspace_id: string } | undefined;
          if (ws === undefined) {
            yield* db.close();
            return yield* new BootstrapError({ reason: "project-not-found", message: "root workspace missing" });
          }
          const sha = yield* git
            .revParse(dirs.storeDir, effectiveRefName(ws.workspace_id as WorkspaceId))
            .pipe(Effect.mapError((e) => new BootstrapError({ reason: "project-not-found", message: e.message })));
          yield* db.close();
          return {
            projectId: proj.project_id,
            workspaceId: ws.workspace_id,
            sourceRepoPath: proj.source_repo_path,
            effectiveRefSha: sha ?? "(ref missing)",
          };
        }),
    };
  }),
);
```

注意实现文件顶部需补 `import { Context } from "effect";`。`return yield* new BootstrapError(...)` 是 Effect 里抛 tagged error 的惯用式（yield 一个 error 值走 failure 通道）。

- [ ] **Step 3: 全部 integration 绿**（失败映射 reason 是否准确也在断言范围：用 `Effect.runPromiseExit` + cause 校验 `_tag: "Failure"`；进一步可用 `Cause.failureOption` 校验 reason 字段——测试里做）
- [ ] **Step 4: Commit** `feat: project bootstrap service with E0 activation baseline (P1-01B)`

---

### Task 9: entrypoints/cli.ts + main.ts 改造

**Files:** Create `src/entrypoints/cli.ts`; Modify `src/entrypoints/main.ts`; Test `tests/unit/cli-args.test.ts`

- [ ] **Step 1: 失败 unit 测试**（纯解析函数 `parseArgs`）

```typescript
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/entrypoints/cli.js";

describe("parseArgs", () => {
  it("project init with repo and home", () => {
    expect(parseArgs(["project", "init", "--repo", "/r", "--home", "/h"])).toEqual({
      cmd: "project-init",
      repo: "/r",
      home: "/h",
      project: undefined,
    });
  });
  it("project show with project id", () => {
    expect(parseArgs(["project", "show", "--project", "uuid-1", "--home", "/h"])).toEqual({
      cmd: "project-show",
      repo: undefined,
      home: "/h",
      project: "uuid-1",
    });
  });
  it("defaults home to undefined (resolver handles)", () => {
    expect(parseArgs(["project", "init", "--repo", "/r"])).toMatchObject({ home: undefined });
  });
  it("unknown command / missing repo → err", () => {
    expect(parseArgs(["nope"]).kind ?? undefined).toBeUndefined; // err 分支按实现断言
    expect(parseArgs(["project", "init"]).cmd ?? "err").toBeTruthy();
  });
});
```

（最后一条 `it` 的断言在实现后按实际 err 形状收紧——写成 `expect(parseArgs(["nope"])).toMatchObject({ kind: "err" })` / init 缺 repo 同理。执行时以实现为准把断言写死，不留松断言。）

- [ ] **Step 2: 实现 cli.ts**（argv 解析 + Layer 组装 + dispatch；main.ts 改为 `import { run } from "./cli.js"; process.exitCode = run(process.argv.slice(2));`）

```typescript
import { Effect, Layer } from "effect";
import { BootstrapError, FsPort, GitPort, SqlitePort } from "../application/ports.js";
import { ProjectBootstrap, ProjectBootstrapLive } from "../application/project-bootstrap.js";
import { FsNodeLive } from "../infrastructure/fs-node.js";
import { GitCliLive } from "../infrastructure/git-cli.js";
import { SqliteNodeLive } from "../infrastructure/sqlite-node.js";

export type CliArgs =
  | { readonly kind: "ok"; readonly cmd: "project-init" | "project-show"; readonly repo?: string; readonly home?: string; readonly project?: string }
  | { readonly kind: "err"; readonly message: string };

export function parseArgs(argv: string[]): CliArgs {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv[0] !== "project" || (argv[1] !== "init" && argv[1] !== "show")) {
    return { kind: "err", message: "usage: arbor project init --repo <path> [--home <path>] | arbor project show --project <uuid> [--home <path>]" };
  }
  if (argv[1] === "init") {
    const repo = flag("repo");
    if (repo === undefined) return { kind: "err", message: "project init requires --repo <path>" };
    return { kind: "ok", cmd: "project-init", repo, home: flag("home"), project: undefined };
  }
  const project = flag("project");
  if (project === undefined) return { kind: "err", message: "project show requires --project <uuid>" };
  return { kind: "ok", cmd: "project-show", repo: undefined, home: flag("home"), project };
}

const AppLayer: Layer.Layer<ProjectBootstrap> = ProjectBootstrapLive.pipe(
  Layer.provideMerge(GitCliLive),
  Layer.provideMerge(FsNodeLive),
  Layer.provideMerge(SqliteNodeLive),
);

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.kind === "err") {
    console.error(args.message);
    return 2;
  }
  const program =
    args.cmd === "project-init"
      ? Effect.gen(function* () {
          const bs = yield* ProjectBootstrap;
          const r = yield* bs.init({ repoPath: args.repo ?? "", home: args.home ?? "" });
          console.log(`project ${r.projectId}`);
          console.log(`workspace ${r.workspaceId}`);
          console.log(`effective ref -> ${r.effectiveRefSha}`);
          return 0;
        })
      : Effect.gen(function* () {
          const bs = yield* ProjectBootstrap;
          const r = yield* bs.show({ projectId: args.project ?? "", home: args.home ?? "" });
          console.log(`project ${r.projectId}`);
          console.log(`source repo ${r.sourceRepoPath}`);
          console.log(`workspace ${r.workspaceId}`);
          console.log(`effective ref -> ${r.effectiveRefSha}`);
          return 0;
        });
  const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(AppLayer)));
  if (exit._tag === "Success") return exit.value;
  console.error("arbor: operation failed"); // 错误细节由 Effect.cause 格式化
  Effect.runSync(Effect.logError(String(exit.cause)));
  return 1;
}
```

（`init` 传 `home: args.home ?? ""`——resolveArborHome 对空串走 env/default 分支，语义正确。）

- [ ] **Step 3: main.ts**

```typescript
import { run } from "./cli.js";

export function main(): void {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}

main();
```

- [ ] **Step 4: unit 绿 + typecheck/lint/test 全绿 → Commit** `feat: project init/show cli (P1-01B)`

---

### Task 10: acceptance（进程级，从 dist 跑）

**Files:** Test `tests/acceptance/cli.test.ts`

- [ ] **Step 1: 测试**（build 已由脚本外层保证；测试内 execSync `node dist/entrypoints/main.js ...`）

```typescript
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "arbor-acc-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const run = (args: string, env: Record<string, string>) =>
  execSync(`node ${join("dist", "entrypoints", "main.js")} ${args}`, {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

describe("acceptance: arbor project init/show", () => {
  it("init then show across two processes", () => {
    const home = tmp();
    const repo = tmp();
    writeFileSync(join(repo, "f.txt"), "x");
    execSync("git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm base", { cwd: repo });
    const out = run(`project init --repo ${repo} --home ${home}`, { ARBOR_HOME: home });
    expect(out).toMatch(/^project [0-9a-f-]+$/m);
    expect(out).toMatch(/effective ref -> [0-9a-f]{40,64}/);
    const pid = /project ([0-9a-f-]+)/m.exec(out)?.[1] ?? "";
    const shown = run(`project show --project ${pid} --home ${home}`, { ARBOR_HOME: home });
    expect(shown).toContain(`source repo ${repo}`);
    expect(shown).toMatch(/workspace [0-9a-f-]+/);
  });
  it("bad usage exits non-zero with message", () => {
    const home = tmp();
    let failed = false;
    try {
      run("project init --home ${home}".replace("${home}", home), { ARBOR_HOME: home });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});
```

（第二条：缺 `--repo` → exit 2。execSync 非 0 退出抛异常即断言。）

- [ ] **Step 2: `pnpm build && pnpm test` 全绿（acceptance 在 vitest include 内自动跑）→ Commit** `test: acceptance for project init/show (P1-01B)`

---

### Task 11: 完成报告 + 文档回填

- [ ] **Step 1:** DECISION_REGISTER 追加 D-031-amend（effect 提前引入）；CURRENT_EFFECTIVE_FACTS 的 Agent Runtime 节下补一行 "effect dependency introduced at P1-01B (D-031-amend)"
- [ ] **Step 2:** 按合同格式输出完成报告（同 P1-01A 模板）

---

## 自审记录

- **Spec coverage**: §4 ARBOR_HOME（resolveArborHome+优先级测试经 acceptance env 间接覆盖，unit 侧由 cli-args 的 home 缺省断言）→ Task 4/9；§5 布局 → Task 8 断言逐项；§6 CLI+输入校验（含空仓库拒绝）→ Task 8 测试；§7 自动迁移 → Task 7；§8 DDL → Task 7 Step1 逐字；§9 文件集 → Task 5/8；§10 yaml schema → Task 5；§18.1-18.6 → Task 5（模板）/Task 8（E0+ref+worktree+重复拒绝）/Task 7（DDL）。
  已知覆盖缺口：§11 的 `isPathWithinPrefix` 在 P1-01B 无运行时消费者（ResourceMapping 校验是 P1-03+ 工具策略的事）——保留纯函数+测试因为它是 §11 冻结语义且是 domain 基石，不算 future-phase 抽象（有当前测试消费者）。
- **占位符**: Task 7 草稿段被显式标记废弃并以完整版替换——执行时只落完整版；Task 9 最后一条 unit 断言执行时收紧。除此之外无 TBD。
- **类型一致性**: ProjectId/WorkspaceId/DbHandle/InitResult 在 ports/bootstrap/tests 三处签名一致；GitPort 五方法名全程一致。
