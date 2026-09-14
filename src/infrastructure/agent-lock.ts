import { type FileHandle, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** P2 hardening: one active primary writer per agent transcript (D-041
 * follow-up, P1_EFFECTIVE_ACTIVATION_PROTOCOL §1 write-gate at the agent-run
 * layer). O_EXCL create + pid liveness probe; a lock left by a dead process
 * (SIGKILL orphan) is reclaimable. */

export interface AgentLock {
  readonly release: () => Promise<void>;
}

export type LockResult =
  | { readonly ok: true; readonly lock: AgentLock }
  | { readonly ok: false; readonly heldByPid: number };

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists but owned by another user
  }
};

export async function acquireAgentLock(lockFile: string): Promise<LockResult> {
  await mkdir(dirname(lockFile), { recursive: true });
  const tryCreate = async (): Promise<"created" | "exists" | Error> => {
    let handle: FileHandle | undefined;
    try {
      handle = await open(lockFile, "wx");
      await writeFile(handle, String(process.pid), "utf8");
      return "created";
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : (e as Error);
    } finally {
      if (handle !== undefined) {
        await handle.close().catch(() => {});
      }
    }
  };

  let attempt = await tryCreate();
  if (attempt === "exists") {
    // reclaim if the holder is dead (crash remnant)
    let holderPid = Number.NaN;
    try {
      holderPid = Number.parseInt(await readFile(lockFile, "utf8"), 10);
    } catch {
      holderPid = Number.NaN;
    }
    if (Number.isFinite(holderPid) && pidAlive(holderPid)) {
      return { ok: false, heldByPid: holderPid };
    }
    await unlink(lockFile).catch(() => {});
    attempt = await tryCreate();
  }
  if (attempt !== "created") {
    return { ok: false, heldByPid: -1 };
  }
  let released = false;
  return {
    ok: true,
    lock: {
      release: async () => {
        if (!released) {
          released = true;
          await unlink(lockFile).catch(() => {});
        }
      },
    },
  };
}
