import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Duration, Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  acquireP39MaintenanceWriterExclusion,
  acquireP39RuntimeWriterPermit,
  P39WriterLockClient,
  p39WriterLockLayer,
  releaseP39WriterPermit,
} from "../../../adapters/persistence-sqlite/src/index.js";
import {
  isP39PathQualificationEnabled,
  makeP39PrivateTestDirectory,
  p39WindowsAclQualificationAvailable,
  p39WindowsTestEnvironment,
  removeP39PrivateTestDirectory,
} from "../../support/p39-windows-deployment-test.js";

const p39PathQualificationAvailable = isP39PathQualificationEnabled(
  process.platform,
  p39WindowsAclQualificationAvailable(),
);

const childModule = resolve(
  "tests/functional/support/p39-writer-lock-child.mjs",
);
const contenderModule = resolve(
  "tests/functional/support/p39-writer-lock-contender.mjs",
);
const sameLayerContenderModule = resolve(
  "tests/functional/support/p39-lock-same-layer-contender.mjs",
);
const releaseConstructionModule = resolve(
  "tests/functional/support/p39-release-construction-child.mjs",
);

const startHolder = async (
  lockFilename: string,
  mode: "shared" | "exclusive",
): Promise<ChildProcessWithoutNullStreams> => {
  const child = spawn(process.execPath, [childModule, lockFilename, mode], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: p39WindowsTestEnvironment(),
  });
  let output = "";
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(
      () => rejectReady(new Error(`lock holder did not start: ${output}`)),
      10_000,
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes("READY\n")) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.once("exit", (code) => {
      if (!output.includes("READY\n")) {
        clearTimeout(timeout);
        rejectReady(new Error(`lock holder exited ${code}: ${output}`));
      }
    });
  });
  await ready;
  return child;
};

const stopHolderPromises = new WeakMap<
  ChildProcessWithoutNullStreams,
  Promise<void>
>();

const stopHolder = (child: ChildProcessWithoutNullStreams): Promise<void> => {
  const existing = stopHolderPromises.get(child);
  if (existing !== undefined) return existing;
  const stopping = (async () => {
    if (
      child.exitCode !== null ||
      child.signalCode !== null ||
      child.stdin.destroyed ||
      child.stdin.writableEnded ||
      !child.stdin.writable
    ) {
      return;
    }
    const exited = new Promise<void>((resolveExit) => {
      child.once("exit", () => resolveExit());
    });
    const brokenPipe = new Promise<void>((resolvePipe, rejectPipe) => {
      child.stdin.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EPIPE") resolvePipe();
        else rejectPipe(error);
      });
    });
    try {
      child.stdin.write("release\n");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EPIPE"
      ) {
        return;
      }
      throw error;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolveExit) => {
      timer = setTimeout(() => {
        child.kill();
        resolveExit();
      }, 5000);
    });
    await Promise.race([exited, brokenPipe.then(() => exited), timeout]);
    if (timer !== undefined) clearTimeout(timer);
  })();
  stopHolderPromises.set(child, stopping);
  return stopping;
};

const killHolder = async (
  child: ChildProcessWithoutNullStreams,
): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => resolveExit());
  });
  child.kill();
  await exited;
};

const contenderOutput = new WeakMap<
  ReturnType<typeof startContender>,
  { stdout: string; stderr: string }
>();

const startReleaseConstructionChild = (lockFilename: string) => {
  const child = spawn(
    process.execPath,
    [releaseConstructionModule, lockFilename],
    {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: p39WindowsTestEnvironment(),
    },
  );
  const output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output.stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output.stderr += chunk;
  });
  contenderOutput.set(child, output);
  return child;
};

const startContender = (
  lockFilename: string,
  mode: "shared" | "exclusive",
  timeoutMs: number,
  cancelAfterMs?: number,
  module = contenderModule,
) => {
  const child = spawn(
    process.execPath,
    module === sameLayerContenderModule
      ? [module, lockFilename, mode]
      : [
          module,
          lockFilename,
          mode,
          String(timeoutMs),
          ...(cancelAfterMs === undefined ? [] : [String(cancelAfterMs)]),
        ],
    {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: p39WindowsTestEnvironment(),
    },
  );
  const output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output.stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output.stderr += chunk;
  });
  contenderOutput.set(child, output);
  return child;
};

const awaitContenderStage = async (
  child: ReturnType<typeof startContender>,
  stage: string,
  deadlineMs: number,
) => {
  const output = contenderOutput.get(child);
  if (output === undefined) throw new Error("P39 contender output missing");
  if (output.stdout.includes(`${stage}\n`)) return;
  await new Promise<void>((resolveReady, rejectReady) => {
    const onData = () => {
      if (output.stdout.includes(`${stage}\n`)) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolveReady();
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      rejectReady(
        new Error(
          `P39 contender did not reach ${stage} within ${deadlineMs}ms; progress=${output.stdout}; stderr=${output.stderr}`,
        ),
      );
    }, deadlineMs);
    child.stdout.on("data", onData);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      rejectReady(
        new Error(
          `P39 contender exited before ${stage}: code=${String(code)} signal=${String(signal)}; progress=${output.stdout}; stderr=${output.stderr}`,
        ),
      );
    });
  });
};

const awaitContenderPhase = async (
  child: ReturnType<typeof startContender>,
  phase: string,
  deadlineMs = 5_000,
) => {
  const output = contenderOutput.get(child);
  if (output === undefined) throw new Error("P39 contender output missing");
  const readResult = () => {
    for (const line of output.stdout.split(/\r?\n/u)) {
      if (!line.startsWith("{")) continue;
      try {
        const result = JSON.parse(line) as {
          phase?: string;
          _tag: string;
          code?: string;
          elapsedMs?: number;
          timerFired?: boolean;
        };
        if (result.phase === phase) return result;
      } catch {
        // Ignore non-JSON diagnostic fragments.
      }
    }
    return undefined;
  };
  const existing = readResult();
  if (existing !== undefined) return existing;
  return new Promise<NonNullable<ReturnType<typeof readResult>>>(
    (resolvePhase, rejectPhase) => {
      const onData = () => {
        const result = readResult();
        if (result === undefined) return;
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolvePhase(result);
      };
      const timer = setTimeout(() => {
        child.kill();
        rejectPhase(
          new Error(
            `P39 contender phase ${phase} exceeded ${deadlineMs}ms; progress=${output.stdout}; stderr=${output.stderr}`,
          ),
        );
      }, deadlineMs);
      child.stdout.on("data", onData);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        const result = readResult();
        if (result !== undefined) resolvePhase(result);
        else {
          rejectPhase(
            new Error(
              `P39 contender exited before phase ${phase}: code=${String(code)} signal=${String(signal)}; progress=${output.stdout}`,
            ),
          );
        }
      });
    },
  );
};

const awaitContenderExit = async (
  child: ReturnType<typeof startContender>,
  deadlineMs = 2_000,
) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => {
    child.once("close", () => resolveExit());
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    exited,
    new Promise<void>((resolveExit) => {
      timer = setTimeout(() => {
        child.kill();
        resolveExit();
      }, deadlineMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
};

const awaitContender = async (
  child: ReturnType<typeof startContender>,
  deadlineMs = 5_000,
) => {
  const output = contenderOutput.get(child);
  if (output === undefined) throw new Error("P39 contender output missing");
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `P39 contender exceeded ${deadlineMs}ms external deadline; progress=${output.stdout}; stderr=${output.stderr}`,
        ),
      );
    }, deadlineMs);
  });
  try {
    const exit = await Promise.race([closed, timedOut]);
    if (exit.code !== 0) {
      throw new Error(
        `P39 contender exited ${String(exit.code)} signal=${String(exit.signal)}; progress=${output.stdout}; stderr=${output.stderr}`,
      );
    }
    const resultLine = output.stdout
      .split(/\r?\n/u)
      .find((line) => line.startsWith("{"));
    if (resultLine === undefined) {
      throw new Error(
        `P39 contender emitted no result; progress=${output.stdout}`,
      );
    }
    return {
      output: output.stdout,
      result: JSON.parse(resultLine) as {
        _tag: string;
        code?: string;
        errorTag?: string;
        errorMessage?: string;
        elapsedMs?: number;
        released?: boolean;
        timerFired?: boolean;
      },
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const competeAcrossProcess = async (input: {
  readonly heldMode: "shared" | "exclusive";
  readonly competingMode: "shared" | "exclusive";
}) => {
  const directory = makeP39PrivateTestDirectory(
    tmpdir(),
    "arbor-p39-writer-lock-",
  );
  const lockFilename = join(directory, "maintenance.sqlite");
  let child: ChildProcessWithoutNullStreams | undefined;
  let contender: ReturnType<typeof startContender> | undefined;
  try {
    contender = startContender(
      lockFilename,
      input.competingMode,
      250,
      undefined,
      sameLayerContenderModule,
    );
    await awaitContenderStage(contender, "LAYER_READY", 15_000);
    child = await startHolder(lockFilename, input.heldMode);
    contender.stdin.write("acquire\n");
    const firstAttempt = await awaitContenderPhase(contender, "first");
    expect(firstAttempt).toMatchObject({
      _tag: "AcquireFailed",
      code: "P39_WRITER_LOCK_ACQUIRE_FAILED",
      timerFired: true,
    });

    const holder = child;
    await stopHolder(holder);
    child = undefined;
    contender.stdin.write("retry\n");
    const secondAttempt = await awaitContenderPhase(contender, "second");
    expect(secondAttempt).toMatchObject({
      _tag: "Acquired",
      timerFired: false,
    });
    contender.stdin.end();
    await awaitContenderExit(contender);
    contender = undefined;
  } finally {
    if (contender !== undefined && contender.exitCode === null) {
      const exited = new Promise<void>((resolveExit) => {
        contender?.once("exit", () => resolveExit());
      });
      contender.kill();
      await exited;
    }
    if (child !== undefined) await stopHolder(child);
    removeP39PrivateTestDirectory(directory);
  }
};

describe.skipIf(!p39PathQualificationAvailable)(
  "P39 cross-process SQLite writer exclusion",
  () => {
    it("blocks maintenance while another OS process holds a daemon shared permit", async () => {
      await competeAcrossProcess({
        heldMode: "shared",
        competingMode: "exclusive",
      });
    });

    it("blocks a new daemon while another OS process holds maintenance exclusion", async () => {
      await competeAcrossProcess({
        heldMode: "exclusive",
        competingMode: "shared",
      });
    });

    it("starts the acquire deadline when the Effect runs and can run the same Effect twice", async () => {
      const directory = makeP39PrivateTestDirectory(
        tmpdir(),
        "arbor-p39-lock-deferred-acquire-",
      );
      const lockFilename = join(directory, "maintenance.sqlite");
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const client = yield* P39WriterLockClient;
              const acquire = client.acquire("RuntimeShared");
              yield* Effect.sleep(Duration.millis(100));
              const first = yield* acquire;
              yield* client.release(first);
              const second = yield* acquire;
              yield* client.release(second);
            }).pipe(Effect.provide(p39WriterLockLayer(lockFilename, 50))),
          ),
        );
      } finally {
        removeP39PrivateTestDirectory(directory);
      }
    });

    it("tries a free lock once when the configured wait budget is zero", async () => {
      const directory = makeP39PrivateTestDirectory(
        tmpdir(),
        "arbor-p39-lock-zero-budget-free-",
      );
      const lockFilename = join(directory, "maintenance.sqlite");
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const client = yield* P39WriterLockClient;
              const permit = yield* client.acquire("RuntimeShared");
              yield* client.release(permit);
            }).pipe(Effect.provide(p39WriterLockLayer(lockFilename, 0))),
          ),
        );
      } finally {
        removeP39PrivateTestDirectory(directory);
      }
    });

    it("refuses a contended zero-budget lock without retrying", async () => {
      const directory = makeP39PrivateTestDirectory(
        tmpdir(),
        "arbor-p39-lock-zero-budget-busy-",
      );
      const lockFilename = join(directory, "maintenance.sqlite");
      let holder: ChildProcessWithoutNullStreams | undefined;
      let contender: ReturnType<typeof startContender> | undefined;
      try {
        holder = await startHolder(lockFilename, "exclusive");
        contender = startContender(lockFilename, "shared", 0);
        await awaitContenderStage(contender, "LAYER_READY", 15_000);
        contender.stdin.end("acquire\n");
        const observation = await awaitContender(contender);
        contender = undefined;
        expect(observation.result).toMatchObject({
          _tag: "AcquireFailed",
          code: "P39_WRITER_LOCK_ACQUIRE_FAILED",
          timerFired: false,
        });
        expect(observation.result.elapsedMs).toBeLessThan(500);
      } finally {
        if (contender !== undefined && contender.exitCode === null) {
          const exited = new Promise<void>((resolveExit) => {
            contender?.once("exit", () => resolveExit());
          });
          contender.kill();
          await exited;
        }
        if (holder !== undefined) await stopHolder(holder);
        removeP39PrivateTestDirectory(directory);
      }
    });

    it("keeps a constructed-but-unrun release tracked for layer shutdown", async () => {
      const directory = makeP39PrivateTestDirectory(
        tmpdir(),
        "arbor-p39-release-effect-construction-",
      );
      const lockFilename = join(directory, "maintenance.sqlite");
      let holder: ReturnType<typeof startReleaseConstructionChild> | undefined;
      let contender: ReturnType<typeof startContender> | undefined;
      try {
        holder = startReleaseConstructionChild(lockFilename);
        await awaitContenderStage(holder, "LAYER_CLOSED", 5_000);
        contender = startContender(lockFilename, "exclusive", 250);
        await awaitContenderStage(contender, "LAYER_READY", 15_000);
        contender.stdin.end("acquire\n");
        const observation = await awaitContender(contender);
        contender = undefined;
        expect(observation.result).toMatchObject({
          _tag: "Acquired",
          released: true,
        });
        holder.stdin.end("exit\n");
        await awaitContenderExit(holder);
        holder = undefined;
      } finally {
        if (contender !== undefined && contender.exitCode === null) {
          const exited = new Promise<void>((resolveExit) => {
            contender?.once("exit", () => resolveExit());
          });
          contender.kill();
          await exited;
        }
        if (holder !== undefined && holder.exitCode === null) {
          const exited = new Promise<void>((resolveExit) => {
            holder?.once("exit", () => resolveExit());
          });
          holder.kill();
          await exited;
        }
        removeP39PrivateTestDirectory(directory);
      }
    });

    it("retains same-layer shared permits until each matching release", async () => {
      const directory = makeP39PrivateTestDirectory(
        tmpdir(),
        "arbor-p39-same-layer-permits-",
      );
      const lockFilename = join(directory, "maintenance.sqlite");
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const client = yield* P39WriterLockClient;
              const first = yield* client.acquire("RuntimeShared");
              const second = yield* client.acquire("RuntimeShared");

              let timerFired = false;
              const timer = setTimeout(() => {
                timerFired = true;
              }, 25);
              const blockedByBoth = yield* Effect.result(
                client.acquire("MaintenanceExclusive"),
              );
              clearTimeout(timer);
              expect(blockedByBoth._tag).toBe("Failure");
              if (blockedByBoth._tag === "Failure") {
                expect(blockedByBoth.failure._tag).toBe("P39WriterLockFailure");
                if (blockedByBoth.failure._tag === "P39WriterLockFailure") {
                  expect(blockedByBoth.failure.code).toBe(
                    "P39_WRITER_LOCK_ACQUIRE_FAILED",
                  );
                }
              }
              expect(timerFired).toBe(true);

              yield* client.release(first);
              const blockedBySecond = yield* Effect.result(
                client.acquire("MaintenanceExclusive"),
              );
              expect(blockedBySecond._tag).toBe("Failure");
              yield* client.release(second);

              const exclusive = yield* client.acquire("MaintenanceExclusive");
              yield* client.release(exclusive);
            }).pipe(Effect.provide(p39WriterLockLayer(lockFilename, 150))),
          ),
        );
      } finally {
        removeP39PrivateTestDirectory(directory);
      }
    });

    it("keeps the event loop responsive and acquires when maintenance releases before the deadline", async () => {
      const directory = makeP39PrivateTestDirectory(
        tmpdir(),
        "arbor-p39-lock-early-release-",
      );
      const lockFilename = join(directory, "maintenance.sqlite");
      let holder: ChildProcessWithoutNullStreams | undefined;
      let contender: ReturnType<typeof startContender> | undefined;
      let releaseTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        contender = startContender(lockFilename, "shared", 5_000);
        await awaitContenderStage(contender, "LAYER_READY", 15_000);
        holder = await startHolder(lockFilename, "exclusive");
        const heldProcess = holder;
        const releaseHolder = new Promise<void>(
          (resolveRelease, rejectRelease) => {
            releaseTimer = setTimeout(() => {
              void stopHolder(heldProcess).then(() => {
                holder = undefined;
                resolveRelease();
              }, rejectRelease);
            }, 125);
          },
        );
        contender.stdin.end("acquire\n");
        const observation = await awaitContender(contender);
        contender = undefined;
        await releaseHolder;
        expect(observation.result).toMatchObject({
          _tag: "Acquired",
          released: true,
          timerFired: true,
        });
        expect(observation.result.elapsedMs).toBeLessThan(5_000);
      } finally {
        if (releaseTimer !== undefined) clearTimeout(releaseTimer);
        if (contender !== undefined && contender.exitCode === null) {
          const exited = new Promise<void>((resolveExit) => {
            contender?.once("exit", () => resolveExit());
          });
          contender.kill();
          await exited;
        }
        if (holder !== undefined) await stopHolder(holder);
        removeP39PrivateTestDirectory(directory);
      }
    });

    it("cancels a pending retry, closes its connection, then permits a fresh acquisition", async () => {
      const directory = makeP39PrivateTestDirectory(
        tmpdir(),
        "arbor-p39-lock-cancel-",
      );
      const lockFilename = join(directory, "maintenance.sqlite");
      let holder: ChildProcessWithoutNullStreams | undefined;
      let contender: ReturnType<typeof startContender> | undefined;
      try {
        contender = startContender(lockFilename, "shared", 10_000, 125);
        await awaitContenderStage(contender, "LAYER_READY", 15_000);
        holder = await startHolder(lockFilename, "exclusive");
        contender.stdin.end("acquire\n");
        const observation = await awaitContender(contender);
        contender = undefined;
        expect(observation.result).toMatchObject({
          _tag: "Cancelled",
          timerFired: true,
        });

        await stopHolder(holder);
        holder = undefined;
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const permit = yield* acquireP39RuntimeWriterPermit();
              yield* releaseP39WriterPermit(permit);
            }).pipe(Effect.provide(p39WriterLockLayer(lockFilename, 1_000))),
          ),
        );
      } finally {
        if (contender !== undefined && contender.exitCode === null) {
          const exited = new Promise<void>((resolveExit) => {
            contender?.once("exit", () => resolveExit());
          });
          contender.kill();
          await exited;
        }
        if (holder !== undefined) await stopHolder(holder);
        removeP39PrivateTestDirectory(directory);
      }
    });

    it("does not retry a non-busy invalid lock database", async () => {
      const directory = makeP39PrivateTestDirectory(
        tmpdir(),
        "arbor-p39-lock-invalid-schema-",
      );
      const lockFilename = join(directory, "maintenance.sqlite");
      let contender: ReturnType<typeof startContender> | undefined;
      const invalid = new DatabaseSync(lockFilename);
      try {
        invalid.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
      } finally {
        invalid.close();
      }
      try {
        contender = startContender(lockFilename, "shared", 1_000);
        await awaitContenderStage(contender, "LAYER_READY", 15_000);
        contender.stdin.end("acquire\n");
        const observation = await awaitContender(contender);
        contender = undefined;
        expect(observation.result).toMatchObject({
          _tag: "AcquireFailed",
          errorTag: "SqliteAdapterError",
          timerFired: false,
        });
        expect(observation.result.errorMessage).toContain("unsupported schema");
        expect(observation.result.elapsedMs).toBeLessThan(500);
      } finally {
        if (contender !== undefined && contender.exitCode === null) {
          const exited = new Promise<void>((resolveExit) => {
            contender?.once("exit", () => resolveExit());
          });
          contender.kill();
          await exited;
        }
        removeP39PrivateTestDirectory(directory);
      }
    });

    it("releases a crashed daemon's shared permit through the SQLite VFS handle", async () => {
      const directory = makeP39PrivateTestDirectory(
        tmpdir(),
        "arbor-p39-lock-crash-",
      );
      const lockFilename = join(directory, "maintenance.sqlite");
      let child: ChildProcessWithoutNullStreams | undefined;
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.provide(
              Effect.gen(function* () {
                child = yield* Effect.promise(() =>
                  startHolder(lockFilename, "shared"),
                );
                const holder = child;
                if (holder === undefined) {
                  return yield* Effect.fail(
                    new Error("lock holder was not started"),
                  );
                }
                yield* Effect.promise(() => killHolder(holder));
                const permit = yield* acquireP39MaintenanceWriterExclusion();
                yield* releaseP39WriterPermit(permit);
              }),
              p39WriterLockLayer(lockFilename, 1000),
            ),
          ),
        );
      } finally {
        if (child !== undefined) await stopHolder(child);
        removeP39PrivateTestDirectory(directory);
      }
    });
  },
);
