import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { GitPort } from "../../src/application/ports.js";
import { GitCliLive } from "../../src/infrastructure/git-cli.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "arbor-git-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
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
        const viaRef = yield* git.revParse(d, "refs/arbor/effective/w1");
        expect(viaRef).toBe(sha);
      }).pipe(Effect.provide(GitCliLive)),
    );
  });

  it("revParse unknown ref resolves undefined", async () => {
    const d = tmp();
    writeFileSync(join(d, "a.txt"), "x");
    await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* GitPort;
        yield* git.init(d);
        expect(yield* git.revParse(d, "refs/nope")).toBeUndefined();
      }).pipe(Effect.provide(GitCliLive)),
    );
  });

  it("worktreeAdd creates branch and worktree", async () => {
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

  it("git operation outside a repo fails with GitError", async () => {
    const d = tmp();
    mkdirSync(d, { recursive: true });
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const git = yield* GitPort;
        return yield* git.commitAll(d, "nope");
      }).pipe(Effect.provide(GitCliLive)),
    );
    expect(exit._tag).toBe("Failure");
  });
});
