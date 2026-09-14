import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { acquireAgentLock } from "../../src/infrastructure/agent-lock.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "arbor-lock-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("acquireAgentLock (single-writer gate)", () => {
  it("second acquisition while held is refused with the holder pid", async () => {
    const lockFile = join(tmp(), "a", "transcript.lock");
    const first = await acquireAgentLock(lockFile);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await acquireAgentLock(lockFile);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.heldByPid).toBe(process.pid);
    }
    await first.lock.release();
    const third = await acquireAgentLock(lockFile);
    expect(third.ok).toBe(true);
    if (third.ok) {
      await third.lock.release();
    }
  });

  it("a stale lock from a dead pid is reclaimed", async () => {
    const dir = join(tmp(), "b");
    mkdirSync(dir, { recursive: true });
    const lockFile = join(dir, "transcript.lock");
    // a pid that cannot exist: pid_max is far below this on any real system
    writeFileSync(lockFile, "999999999");
    const r = await acquireAgentLock(lockFile);
    expect(r.ok).toBe(true);
    if (r.ok) {
      await r.lock.release();
    }
  });

  it("double release is safe", async () => {
    const lockFile = join(tmp(), "c", "transcript.lock");
    const r = await acquireAgentLock(lockFile);
    if (!r.ok) throw new Error("unexpected refusal");
    await r.lock.release();
    await r.lock.release(); // no throw
  });
});
