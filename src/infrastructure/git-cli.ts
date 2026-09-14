import { spawn } from "node:child_process";
import { Effect, Layer } from "effect";
import { GitError, GitPort } from "../application/ports.js";

function runGit(
  args: string[],
  cwd: string,
): Effect.Effect<{ stdout: string; stderr: string }, GitError> {
  return Effect.callback<{ stdout: string; stderr: string }, GitError>((resume) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", (err) => {
      resume(Effect.fail(new GitError({ op: args.join(" "), message: String(err) })));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resume(Effect.succeed({ stdout, stderr }));
      } else {
        resume(
          Effect.fail(
            new GitError({ op: args.join(" "), message: `exit=${code} ${stderr.trim()}` }),
          ),
        );
      }
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
        Effect.catchCause(() => Effect.succeed(undefined)),
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
      runGit(
        ["-C", sourceRepo, "worktree", "add", "--quiet", path, "-b", branch, base],
        sourceRepo,
      ).pipe(Effect.asVoid),
  }),
);
