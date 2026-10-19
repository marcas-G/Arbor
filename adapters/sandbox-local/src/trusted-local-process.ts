import { execFile } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import {
  projectSandboxEnvironment,
  TrustedLocalProcessPort,
  type TrustedLocalProcessRequest,
} from "@arbor/ports";
import { Effect, Layer } from "effect";

const insideRoot = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
};

const executeTrustedLocal = (request: TrustedLocalProcessRequest) =>
  Effect.gen(function* () {
    const mount = request.handle.mounts?.find(
      (candidate) => candidate.ref === request.cwd.mount,
    );
    if (mount === undefined || mount.access !== "ReadWrite") {
      return yield* Effect.fail(new Error("trusted-local cwd mount rejected"));
    }
    const cwd = resolve(mount.rootPath, request.cwd.path);
    if (!insideRoot(mount.rootPath, cwd)) {
      return yield* Effect.fail(new Error("trusted-local cwd escapes mount"));
    }
    const environment = projectSandboxEnvironment(
      request.ambientEnvironment,
      request.policy.environmentAllowlist,
    );
    return yield* Effect.tryPromise({
      try: () =>
        new Promise<{
          readonly exitCode: number;
          readonly stdout: string;
          readonly stderr: string;
          readonly timedOut: boolean;
          readonly truncated: boolean;
        }>((resolveResult, rejectResult) => {
          execFile(
            request.executable,
            [...request.args],
            {
              cwd,
              env: environment,
              timeout: request.timeoutMs,
              maxBuffer:
                request.policy.limits.stdoutBytes +
                request.policy.limits.stderrBytes,
              encoding: "buffer",
              windowsHide: true,
            },
            (error, stdout, stderr) => {
              const output = Buffer.isBuffer(stdout)
                ? stdout
                : Buffer.from(stdout);
              const errors = Buffer.isBuffer(stderr)
                ? stderr
                : Buffer.from(stderr);
              const truncated =
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
              const timedOut =
                typeof error === "object" &&
                error !== null &&
                "killed" in error &&
                error.killed === true;
              const exitCode =
                error !== null &&
                "code" in error &&
                typeof error.code === "number"
                  ? error.code
                  : undefined;
              if (
                error !== null &&
                !timedOut &&
                !truncated &&
                exitCode === undefined
              ) {
                rejectResult(error);
                return;
              }
              resolveResult({
                exitCode: exitCode ?? (timedOut || truncated ? 1 : 0),
                stdout: output
                  .subarray(0, request.policy.limits.stdoutBytes)
                  .toString("utf8"),
                stderr: errors
                  .subarray(0, request.policy.limits.stderrBytes)
                  .toString("utf8"),
                timedOut,
                truncated:
                  truncated ||
                  output.byteLength > request.policy.limits.stdoutBytes ||
                  errors.byteLength > request.policy.limits.stderrBytes,
              });
            },
          );
        }),
      catch: (cause) => cause,
    });
  });

/** Explicit TrustedLocal execution. This is an unconfined local process, not
 * an OS sandbox; policy limits are disclosure/best-effort only. */
export const TrustedLocalProcessPortLive = Layer.effect(
  TrustedLocalProcessPort,
  Effect.succeed(
    TrustedLocalProcessPort.of({
      run: (request) =>
        executeTrustedLocal(request).pipe(
          Effect.map((result) => ({ _tag: "Completed" as const, ...result })),
          Effect.catch(() =>
            Effect.succeed({
              _tag: "Rejected" as const,
              failureCode: "ProcessCapabilityNotBound" as const,
            }),
          ),
        ),
    }),
  ),
);
