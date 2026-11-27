import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..");

const quoteForCmd = (value: string): string =>
  /[\s&|<>^]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

const run = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  timeout = 300_000,
) => {
  const result =
    process.platform === "win32"
      ? spawnSync(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", [command, ...args].map(quoteForCmd).join(" ")],
          {
            cwd,
            encoding: "utf8",
            timeout,
            maxBuffer: 20 * 1024 * 1024,
            windowsHide: true,
          },
        )
      : spawnSync(command, args, {
          cwd,
          encoding: "utf8",
          timeout,
          maxBuffer: 20 * 1024 * 1024,
        });
  if (result.status !== 0) {
    const stdout = result.stdout?.slice(-8_000) ?? "";
    const stderr = result.stderr?.slice(-8_000) ?? "";
    throw new Error(
      `${command} ${args.join(" ")} failed status=${String(result.status)} signal=${String(result.signal)}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  return result.stdout ?? "";
};

describe("release-functional clean committed checkout", () => {
  it("F20 installs, builds, starts and runs the public black-box from HEAD", () => {
    // P39 deliberately requires a supported local filesystem for SQLite
    // durability and writer-lock qualification. The default OS temp
    // directory is tmpfs on some Linux developer machines, so placing the
    // disposable checkout there makes the release test fail before it tests
    // the release. Keep the temporary clone beside the repository so it
    // inherits the filesystem selected for the checkout itself.
    const temporaryRoot = mkdtempSync(
      join(dirname(repositoryRoot), ".arbor-clean-checkout-"),
    );
    const checkout = join(temporaryRoot, "repo");
    try {
      run(
        "git",
        [
          "clone",
          "--quiet",
          "--no-hardlinks",
          "--local",
          repositoryRoot,
          checkout,
        ],
        temporaryRoot,
      );
      const storeDir = process.env.npm_config_store_dir;
      run(
        "pnpm",
        [
          "install",
          "--frozen-lockfile",
          "--offline",
          ...(storeDir ? ["--store-dir", storeDir] : []),
        ],
        checkout,
      );
      run("pnpm", ["build"], checkout);
      run("pnpm", ["--filter", "@arbor/web", "build"], checkout);
      const output = run(
        "pnpm",
        [
          "exec",
          "vitest",
          "run",
          "--config",
          "tests/configs/vitest.functional.config.ts",
          "tests/capability/black-box/s1-s4-public-api.test.ts",
        ],
        checkout,
      );
      expect(output).toContain("4 passed");
    } finally {
      rmSync(temporaryRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    }
  }, 600_000);
});
