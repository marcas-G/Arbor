import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installLinuxSandboxEnvironment,
  reinstallLinuxSandboxEnvironment,
} from "../src/transport/linux-environment-install.js";

let root: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});
const prepare = async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "arbor-install-guard-")));
  vi.stubEnv("XDG_DATA_HOME", root);
  const parent = join(root, "Arbor");
  await mkdir(parent, { mode: 0o700 });
  return {
    parent,
    authority: join(parent, "sandbox-authority"),
    outputDirectory: join(root, "checks"),
  };
};

describe.runIf(process.platform === "linux")(
  "Linux first-install guards",
  () => {
    it("preserves an existing authority and does not start qualification", async () => {
      const { parent, authority, outputDirectory } = await prepare();
      await mkdir(authority, { mode: 0o700 });
      await writeFile(
        join(authority, "authority-bundle.json"),
        "preserve-exactly",
      );
      await expect(
        installLinuxSandboxEnvironment({ outputDirectory }),
      ).rejects.toThrow("already exists");
      expect(
        await readFile(join(authority, "authority-bundle.json"), "utf8"),
      ).toBe("preserve-exactly");
      expect(await readdir(parent)).toEqual(["sandbox-authority"]);
      await expect(
        readFile(join(outputDirectory, "result.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
    it("preserves a concurrent install lock instead of removing or replacing it", async () => {
      const { parent, outputDirectory } = await prepare();
      const lock = join(parent, ".sandbox-authority-install.lock");
      await writeFile(lock, "other-installer", { flag: "wx", mode: 0o600 });
      await expect(
        installLinuxSandboxEnvironment({ outputDirectory }),
      ).rejects.toMatchObject({ code: "ELOCKED" });
      expect(await readFile(lock, "utf8")).toBe("other-installer");
      expect(await readdir(parent)).toEqual([
        ".sandbox-authority-install.lock",
      ]);
    });
    it("recovers an abandoned installer lock without replacing existing authority", async () => {
      const { parent, authority, outputDirectory } = await prepare();
      const lock = join(parent, ".sandbox-authority-install.lock");
      await mkdir(lock);
      const abandonedAt = new Date(Date.now() - 60_000);
      await utimes(lock, abandonedAt, abandonedAt);
      await mkdir(authority, { mode: 0o700 });
      await writeFile(join(authority, "sentinel"), "preserved");
      await expect(
        installLinuxSandboxEnvironment({ outputDirectory }),
      ).rejects.toThrow("already exists");
      expect(await readFile(join(authority, "sentinel"), "utf8")).toBe(
        "preserved",
      );
      expect(await readdir(parent)).toEqual(["sandbox-authority"]);
    });
    it("does not follow an authority-directory symlink", async () => {
      const { parent, authority, outputDirectory } = await prepare();
      const external = join(root as string, "external");
      await mkdir(external);
      await writeFile(join(external, "sentinel"), "unchanged");
      await symlink(external, authority);
      await expect(
        installLinuxSandboxEnvironment({ outputDirectory }),
      ).rejects.toThrow("already exists");
      expect(await readFile(join(external, "sentinel"), "utf8")).toBe(
        "unchanged",
      );
      expect(await readdir(parent)).toEqual(["sandbox-authority"]);
    });

    it("does not move an authority-directory symlink during requalification", async () => {
      const { parent, authority, outputDirectory } = await prepare();
      const external = join(root as string, "external-reinstall");
      await mkdir(external);
      await writeFile(join(external, "sentinel"), "unchanged");
      await symlink(external, authority);
      await expect(
        reinstallLinuxSandboxEnvironment({ outputDirectory }),
      ).rejects.toThrow("not a regular directory");
      expect(await readFile(join(external, "sentinel"), "utf8")).toBe(
        "unchanged",
      );
      expect(await readdir(parent)).toEqual(["sandbox-authority"]);
    });
  },
);
