import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  acquireP39MaintenanceWriterExclusion,
  acquireP39RuntimeWriterPermit,
  p39WriterLockLayer,
  releaseP39WriterPermit,
} from "../../../adapters/persistence-sqlite/src/index.js";

const childModule = resolve(
  "tests/functional/support/p39-writer-lock-child.mjs",
);

const startHolder = async (
  lockFilename: string,
  mode: "shared" | "exclusive",
): Promise<ChildProcessWithoutNullStreams> => {
  const child = spawn(process.execPath, [childModule, lockFilename, mode], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
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

const stopHolder = async (
  child: ChildProcessWithoutNullStreams,
): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => resolveExit());
  });
  child.stdin.write("release\n");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolveExit) => {
    timer = setTimeout(() => {
      child.kill();
      resolveExit();
    }, 5000);
  });
  await Promise.race([exited, timeout]);
  if (timer !== undefined) clearTimeout(timer);
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

const competeAcrossProcess = async (input: {
  readonly heldMode: "shared" | "exclusive";
  readonly competingMode: "shared" | "exclusive";
}) => {
  const directory = mkdtempSync(join(tmpdir(), "arbor-p39-writer-lock-"));
  const lockFilename = join(directory, "maintenance.sqlite");
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            child = yield* Effect.promise(() =>
              startHolder(lockFilename, input.heldMode),
            );
            const holder = child;
            if (holder === undefined) {
              return yield* Effect.fail(
                new Error("lock holder was not started"),
              );
            }
            const acquire =
              input.competingMode === "exclusive"
                ? acquireP39MaintenanceWriterExclusion()
                : acquireP39RuntimeWriterPermit();
            const blocked = yield* Effect.flip(acquire);
            expect(blocked.code).toBe("P39_WRITER_LOCK_ACQUIRE_FAILED");

            yield* Effect.promise(() => stopHolder(holder));
            const permit = yield* acquire;
            yield* releaseP39WriterPermit(permit);
          }),
          p39WriterLockLayer(lockFilename, 250),
        ),
      ),
    );
  } finally {
    if (child !== undefined) await stopHolder(child);
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("P39 cross-process SQLite writer exclusion", () => {
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

  it("releases a crashed daemon's shared permit through the SQLite VFS handle", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-p39-lock-crash-"));
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
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
