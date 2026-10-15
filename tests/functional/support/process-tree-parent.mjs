import { spawn } from "node:child_process";

const grandchild = spawn(
  process.execPath,
  ["-e", "setInterval(() => {}, 1000)"],
  {
    detached: process.platform === "win32",
    stdio: "ignore",
    windowsHide: true,
  },
);

grandchild.once("spawn", () => {
  process.stdout.write(
    `${JSON.stringify({ tag: "PROCESS_TREE_READY", grandchildPid: grandchild.pid })}\n`,
  );
});

await new Promise(() => {});
