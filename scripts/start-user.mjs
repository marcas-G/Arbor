#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import {
  accessSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageVersion = "0.0.0";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const argumentsList = process.argv.slice(2);
const commands = new Set(["open", "start", "status", "stop", "doctor"]);
const command = commands.has(argumentsList[0] ?? "")
  ? argumentsList[0]
  : "open";

const valueAfter = (flag) => {
  const index = argumentsList.indexOf(flag);
  return index >= 0 ? argumentsList[index + 1] : undefined;
};

const inlineValue = (flag) => {
  const prefix = `${flag}=`;
  const argument = argumentsList.find((value) => value.startsWith(prefix));
  return argument?.slice(prefix.length);
};

const help = () => {
  process.stdout.write(
    `Arbor — long-running project workspace\n\nUsage:\n  arbor [command] [options]\n\nCommands:\n  open                   Start Arbor and open the app (default)\n  start                  Start Arbor in the background\n  status                 Show whether Arbor is running\n  stop                   Stop the local Arbor service\n  doctor                 Check whether Arbor is ready to run\n\nOptions:\n  --port <port>          Local web port (default: 8787)\n  --no-open              Start without opening a browser\n  --help                 Show this help\n  --version              Show the Arbor version\n\nExamples:\n  arbor\n  arbor status\n  arbor start --no-open\n`,
  );
};

if (argumentsList.includes("--help") || argumentsList.includes("-h")) {
  help();
  process.exit(0);
}

if (argumentsList.includes("--version") || argumentsList.includes("-v")) {
  process.stdout.write(`Arbor ${packageVersion}\n`);
  process.exit(0);
}

const port =
  valueAfter("--port") ??
  inlineValue("--port") ??
  process.env.ARBOR_HTTP_PORT ??
  "8787";
const dataDirectory =
  valueAfter("--data-dir") ??
  inlineValue("--data-dir") ??
  process.env.ARBOR_DATA_DIR;
const localAppData = process.env.LOCALAPPDATA ?? resolve(root, ".arbor-user");
const databaseFile =
  dataDirectory !== undefined
    ? resolve(dataDirectory, "arbor.db")
    : resolve(localAppData, "Arbor", "data", "arbor.db");
const projectRoot =
  valueAfter("--project-root") ??
  inlineValue("--project-root") ??
  process.env.ARBOR_PROJECT_ROOT ??
  process.cwd();
const webDist = resolve(root, "apps", "web", "dist");
const daemon = resolve(root, "apps", "single-workspace", "dist", "main.js");
const url = `http://127.0.0.1:${port}/`;
const shouldOpen = command === "open" && !process.argv.includes("--no-open");
const background = command === "start";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const openBrowser = () => {
  if (!shouldOpen) return;
  const browserProcess = spawn("cmd.exe", ["/c", "start", "", url], {
    cwd: root,
    stdio: "ignore",
    windowsHide: true,
  });
  browserProcess.unref();
};

const isRunning = async () => {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
};

const pidFile = resolve(dirname(databaseFile), `arbor-${port}.pid`);
const legacyPidFile = resolve(dirname(databaseFile), "arbor.pid");

const readPid = () => {
  for (const marker of [pidFile, legacyPidFile]) {
    try {
      const pid = Number.parseInt(readFileSync(marker, "utf8").trim(), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // Try the next marker for compatibility with an earlier CLI run.
    }
  }
  return null;
};

const removePid = () => {
  for (const marker of [pidFile, legacyPidFile]) {
    try {
      unlinkSync(marker);
    } catch {
      // Missing runtime marker is already the desired state.
    }
  }
};

const prepareBuild = () => {
  if (existsSync(daemon) && existsSync(webDist)) return true;
  process.stdout.write("正在准备 Arbor，请稍候…\n");
  try {
    execFileSync(pnpm, ["build"], { cwd: root, stdio: "ignore" });
    execFileSync(pnpm, ["--filter", "@arbor/web", "build"], {
      cwd: root,
      stdio: "ignore",
    });
    return existsSync(daemon) && existsSync(webDist);
  } catch {
    return false;
  }
};

const start = async () => {
  if (command === "status") {
    process.stdout.write(
      (await isRunning()) ? "Arbor 正在运行\n" : "Arbor 当前未运行\n",
    );
    return;
  }

  if (command === "stop") {
    const pid = readPid();
    if (pid === null) {
      process.stdout.write("Arbor 当前未运行\n");
      return;
    }
    try {
      process.kill(pid);
      removePid();
      process.stdout.write("Arbor 已停止\n");
    } catch {
      removePid();
      process.stdout.write("Arbor 当前未运行\n");
    }
    return;
  }

  if (command === "doctor") {
    const checks = [];
    const buildReady = existsSync(daemon) && existsSync(webDist);
    checks.push({
      ok: buildReady,
      pass: "应用文件已准备好",
      fail: "应用文件尚未准备好",
    });
    const dataReady = (() => {
      try {
        mkdirSync(dirname(databaseFile), { recursive: true });
        accessSync(dirname(databaseFile), fsConstants.R_OK | fsConstants.W_OK);
        return true;
      } catch {
        return false;
      }
    })();
    checks.push({
      ok: dataReady,
      pass: "本地数据存储可用",
      fail: "本地数据存储不可写",
    });
    const running = await isRunning();
    checks.push({
      ok: true,
      pass: running ? "Arbor 服务正在运行" : "Arbor 服务尚未运行（可以启动）",
      fail: "",
    });
    const configCandidates = [
      process.env.ARBOR_CONFIG,
      resolve(process.cwd(), "arbor.config.json"),
    ].filter((value) => typeof value === "string" && value.length > 0);
    let providerMessage = "模型连接使用本地模式";
    for (const candidate of configCandidates) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8"));
        const secret = parsed?.provider?.secret;
        if (
          secret?.kind === "env" &&
          typeof process.env[secret.ref] !== "string"
        ) {
          providerMessage = "模型配置存在，但凭据尚未提供；本地模式仍可使用";
        } else if (parsed?.provider !== undefined) {
          providerMessage = "模型配置已就绪";
        }
        break;
      } catch {
        // An absent or malformed optional config is reported by the daemon on start.
      }
    }
    checks.push({ ok: true, pass: providerMessage, fail: "" });
    process.stdout.write(
      `${checks.map((check) => `${check.ok ? "✓" : "!"} ${check.ok ? check.pass : check.fail}`).join("\n")}\n`,
    );
    if (!buildReady || !dataReady) process.exitCode = 1;
    return;
  }

  if (await isRunning()) {
    if (command === "open") openBrowser();
    process.stdout.write("Arbor 正在运行\n");
    return;
  }
  if (!prepareBuild()) {
    console.error("Arbor 暂时无法启动，请检查安装是否完整。");
    process.exitCode = 1;
    return;
  }

  mkdirSync(dirname(databaseFile), { recursive: true });

  const environment = {
    ...process.env,
    ARBOR_DB: databaseFile,
    ARBOR_HTTP_HOST: process.env.ARBOR_HTTP_HOST ?? "127.0.0.1",
    ARBOR_HTTP_PORT: port,
    ARBOR_WEB_DIST: webDist,
    ARBOR_PROJECT_ROOT: projectRoot,
    ARBOR_PROJECT_PROFILE_NAME:
      process.env.ARBOR_PROJECT_PROFILE_NAME ?? "Arbor 项目文件",
  };

  const daemonProcess = spawn(process.execPath, [daemon], {
    cwd: root,
    env: environment,
    stdio: background ? "ignore" : "inherit",
    detached: background,
  });
  if (background) daemonProcess.unref();
  writeFileSync(pidFile, String(daemonProcess.pid ?? ""), "utf8");

  const waitForWeb = async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await fetch(url);
        if (command === "open") openBrowser();
        process.stdout.write("Arbor 已启动\n");
        return;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      }
    }
    console.error(`Arbor 服务未能在 ${url} 启动。`);
    daemonProcess.kill();
    removePid();
    process.exitCode = 1;
  };

  await waitForWeb();
  if (!background) {
    await new Promise((resolveExit) => daemonProcess.once("exit", resolveExit));
  }
};

await start();
