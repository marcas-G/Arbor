import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { promisify } from "node:util";
import {
  ExecutionId,
  ProjectId,
  parse,
  VerificationId,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "@arbor/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  createVerificationInputCopy,
  type VerificationInputBinding,
} from "../src/verification-input-copy.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);
const binding: VerificationInputBinding = {
  verificationId: parse(VerificationId)(
    "ver_00000000-0000-7000-8000-000000000001",
  ),
  executionId: parse(ExecutionId)("exe_00000000-0000-7000-8000-000000000002"),
  projectId: parse(ProjectId)("prj_00000000-0000-7000-8000-000000000003"),
  workspaceId: parse(WorkspaceId)("ws_00000000-0000-7000-8000-000000000004"),
  workId: parse(WorkId)("wrk_00000000-0000-7000-8000-000000000005"),
  targetWorkRevision: parse(WorkRevision)(6),
};
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "arbor-verification-input-"));
  roots.push(root);
  const sourceDirectory = join(root, "真实 项目");
  const runtimeDirectory = join(root, "private-runtime");
  await mkdir(sourceDirectory, { mode: 0o700 });
  await mkdir(runtimeDirectory, { mode: 0o700 });
  return { root, sourceDirectory, runtimeDirectory, binding };
};
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== "linux")(
  "independent verification input copy",
  () => {
    it("captures actual uncommitted files and safe internal links, with independently writable bytes", async () => {
      const input = await fixture();
      await mkdir(join(input.sourceDirectory, ".git"));
      await writeFile(
        join(input.sourceDirectory, ".git", "HEAD"),
        "ref: refs/heads/main\n",
      );
      await mkdir(join(input.sourceDirectory, "src"));
      await writeFile(
        join(input.sourceDirectory, "src", "index.js"),
        "export const sum = (a,b) => a+b;\n",
      );
      await writeFile(
        join(input.sourceDirectory, "untracked.txt"),
        "not in any commit",
      );
      await symlink("src/index.js", join(input.sourceDirectory, "current.js"));
      await symlink("missing.txt", join(input.sourceDirectory, "dangling"));
      const copy = await createVerificationInputCopy(input);
      expect(await readFile(join(copy.rootPath, "untracked.txt"), "utf8")).toBe(
        "not in any commit",
      );
      expect(
        await readFile(join(copy.rootPath, "current.js"), "utf8"),
      ).toContain("a+b");
      expect(await readlink(join(copy.rootPath, "dangling"))).toBe(
        "missing.txt",
      );
      expect((await stat(join(copy.rootPath, "src", "index.js"))).ino).not.toBe(
        (await stat(join(input.sourceDirectory, "src", "index.js"))).ino,
      );
      await writeFile(
        join(copy.rootPath, "src", "index.js"),
        "changed by verification command",
      );
      await mkdir(join(copy.rootPath, "dist"));
      await writeFile(join(copy.rootPath, "dist", "build.js"), "generated");
      expect(
        await readFile(join(input.sourceDirectory, "src", "index.js"), "utf8"),
      ).toContain("a+b");
      expect(await readdir(input.sourceDirectory)).not.toContain("dist");
      expect(await copy.sourceIsCurrent()).toBe(true);
      const manifest = JSON.parse(copy.manifestJson);
      expect(manifest.binding).toEqual(binding);
      expect(manifest.entries).toContainEqual(
        expect.objectContaining({ path: "untracked.txt", kind: "file" }),
      );
      expect(copy.manifestJson).not.toContain(input.root);
      expect(copy.inputDigest).toBe(
        `sha256:${createHash("sha256").update(copy.manifestJson).digest("hex")}`,
      );
      await copy.dispose();
      await copy.dispose();
      expect(await copy.sourceIsCurrent()).toBe(false);
      expect(await readdir(input.runtimeDirectory)).toEqual([]);
      expect(
        await readFile(join(input.sourceDirectory, "untracked.txt"), "utf8"),
      ).toBe("not in any commit");
    });

    it.each(["../outside.txt", "/etc/passwd"])(
      "rejects an outside link %s and removes the partial copy",
      async (target) => {
        const input = await fixture();
        await writeFile(
          join(input.root, "outside.txt"),
          "private outside bytes",
        );
        await symlink(target, join(input.sourceDirectory, "outside"));
        await expect(createVerificationInputCopy(input)).rejects.toMatchObject({
          code: "EscapingSymlink",
        });
        expect(await readdir(input.runtimeDirectory)).toEqual([]);
      },
    );

    it("rejects a link-chain escape that lexical path normalization would miss", async () => {
      const input = await fixture();
      await mkdir(join(input.sourceDirectory, "a"));
      await symlink("..", join(input.sourceDirectory, "a", "up"));
      await symlink(
        "a/up/../outside.txt",
        join(input.sourceDirectory, "escape"),
      );
      await expect(createVerificationInputCopy(input)).rejects.toMatchObject({
        code: "EscapingSymlink",
      });
      expect(await readdir(input.runtimeDirectory)).toEqual([]);
    });

    it("does not clone pathname sockets into a verification environment", async () => {
      const input = await fixture();
      await execFileAsync("mkfifo", [join(input.sourceDirectory, "host.sock")]);
      try {
        await expect(createVerificationInputCopy(input)).rejects.toMatchObject({
          code: "UnsupportedEntry",
        });
        expect(await readdir(input.runtimeDirectory)).toEqual([]);
      } finally {
        await rm(join(input.sourceDirectory, "host.sock"), { force: true });
      }
    });

    it("fails boundedly instead of silently excluding over-limit input", async () => {
      const input = await fixture();
      await writeFile(join(input.sourceDirectory, "large.txt"), "over limit");
      await expect(
        createVerificationInputCopy({
          ...input,
          limits: { maxEntries: 10, maxBytes: 1, maxDepth: 5, timeoutMs: 5000 },
        }),
      ).rejects.toMatchObject({ code: "InputLimitExceeded" });
      expect(await readdir(input.runtimeDirectory)).toEqual([]);
    });

    it("rejects source mutation during capture and cleans the failed copy", async () => {
      const input = await fixture();
      await writeFile(
        join(input.sourceDirectory, "large.bin"),
        Buffer.alloc(32 * 1024 ** 2, 7),
      );
      let settled = false;
      const operation = createVerificationInputCopy(input)
        .then(
          (copy) => ({ copy }),
          (error: unknown) => ({ error }),
        )
        .finally(() => {
          settled = true;
        });
      let writes = 0;
      while (!settled) {
        await writeFile(
          join(input.sourceDirectory, `new-${writes++}`),
          "concurrent producer change",
        );
        await nextTurn();
      }
      const result = await operation;
      expect(writes).toBeGreaterThan(1);
      expect(result).toMatchObject({ error: { code: "SourceChanged" } });
      expect(await readdir(input.runtimeDirectory)).toEqual([]);
    });

    it("cancels a running capture without deleting or changing producer files", async () => {
      const input = await fixture();
      await writeFile(
        join(input.sourceDirectory, "large.bin"),
        Buffer.alloc(32 * 1024 ** 2, 9),
      );
      const controller = new AbortController();
      const operation = createVerificationInputCopy({
        ...input,
        signal: controller.signal,
      });
      const outcome = expect(operation).rejects.toMatchObject({
        code: "Cancelled",
      });
      await nextTurn();
      controller.abort();
      await outcome;
      expect(await readdir(input.runtimeDirectory)).toEqual([]);
      expect((await stat(join(input.sourceDirectory, "large.bin"))).size).toBe(
        32 * 1024 ** 2,
      );
    });

    it("requires a private runtime root separate from the producer", async () => {
      const input = await fixture();
      await chmod(input.runtimeDirectory, 0o755);
      await expect(createVerificationInputCopy(input)).rejects.toMatchObject({
        code: "UnsafeRuntimeDirectory",
      });
      await chmod(input.runtimeDirectory, 0o700);
      await mkdir(join(input.sourceDirectory, "runtime"), { mode: 0o700 });
      await expect(
        createVerificationInputCopy({
          ...input,
          runtimeDirectory: join(input.sourceDirectory, "runtime"),
        }),
      ).rejects.toMatchObject({ code: "OverlappingDirectories" });
      expect(await readdir(input.runtimeDirectory)).toEqual([]);
    });

    it("creates only a missing private root and rejects a preplaced symlink", async () => {
      const input = await fixture();
      await rm(input.runtimeDirectory, { recursive: true, force: true });
      const copy = await createVerificationInputCopy(input);
      expect((await stat(input.runtimeDirectory)).mode & 0o777).toBe(0o700);
      await copy.dispose();
      await rm(input.runtimeDirectory, { recursive: true, force: true });
      await symlink(input.sourceDirectory, input.runtimeDirectory);
      await expect(createVerificationInputCopy(input)).rejects.toMatchObject({
        code: "UnsafeRuntimeDirectory",
      });
    });
  },
);
