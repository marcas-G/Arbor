import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const run = (command, args, env = process.env) =>
  new Promise((resolveRun, rejectRun) => {
    const options = {
      cwd: root,
      env,
      stdio: "inherit",
    };
    const child =
      process.platform === "win32" && command === pnpm
        ? spawn(
            process.env.ComSpec ?? "cmd.exe",
            ["/d", "/s", "/c", [command, ...args].join(" ")],
            options,
          )
        : spawn(command, args, options);
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(
        new Error(
          `${command} ${args.join(" ")} ${
            signal === null
              ? `exited with code ${code}`
              : `was terminated by ${signal}`
          }`,
        ),
      );
    });
  });

await run(pnpm, ["build"]);
await run(pnpm, ["--filter", "@arbor/web", "build"]);

const port = process.env.ARBOR_HTTP_PORT ?? "8787";
const env = {
  ...process.env,
  ARBOR_HTTP_PORT: port,
  ARBOR_WEB_DIST: resolve(root, "apps/web/dist"),
};

process.stdout.write(`Arbor is starting at http://127.0.0.1:${port}\n`);
await run(process.execPath, ["apps/single-workspace/dist/main.js"], env);
