#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import {
  accessSync,
  closeSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  currentBuild,
  databaseFingerprint,
  matchesManagedProcess,
  readRuntime,
  recordBuild,
  sourceFingerprint,
} from "./user-runtime.mjs";

const packageVersion = "0.0.0";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const argumentsList = process.argv.slice(2);
const commands = new Set([
  "open",
  "start",
  "status",
  "stop",
  "doctor",
  "check-environment",
  "install-environment",
  "reinstall-environment",
  "backup",
  "verify-backup",
  "restore",
]);
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
    `Arbor — long-running project workspace\n\nUsage:\n  arbor [command] [options]\n\nCommands:\n  open                   Start Arbor and open the app (default)\n  start                  Start Arbor in the background\n  status                 Show whether Arbor is running\n  stop                   Stop the local Arbor service\n  doctor                 Check whether Arbor is ready to run\n  check-environment      Run real Linux isolation/network checks (about 3 minutes)\n  install-environment    Check and install Linux command environment for this user\n  reinstall-environment  Requalify after an Arbor/provider upgrade; keep the previous authority\n\nOptions:\n  --port <port>          Local web port (default: 8787)\n  --data-dir <path>      Local data directory (overrides ARBOR_DB)\n  --project-root <path>  Directory admitted as the project files Profile\n  --no-open              Start without opening a browser\n  --help                 Show this help\n  --version              Show the Arbor version\n\nExamples:\n  arbor\n  arbor status\n  arbor start --no-open\n`,
  );
  process.stdout.write(
    "\nUser data (Linux, stop Arbor before backup):\n  arbor backup --to <new-backup-directory>\n  arbor verify-backup --from <backup-directory>\n  arbor restore --from <backup-directory> --data-dir <new-data-directory>\n\nBackups include the database, content files and project directory registry.\nProject source files, model credentials and sandbox authority files require separate backups.\nRestore preserves absolute project paths; keep the original installation stopped.\n",
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
const homeDirectory = process.env.HOME ?? process.env.USERPROFILE;
const defaultUserDataRoot =
  process.platform === "win32"
    ? (process.env.LOCALAPPDATA ??
      process.env.APPDATA ??
      (homeDirectory === undefined
        ? resolve(root, ".arbor-user")
        : resolve(homeDirectory, "AppData", "Local")))
    : process.platform === "darwin"
      ? resolve(
          homeDirectory ?? resolve(root, ".arbor-user"),
          "Library",
          "Application Support",
        )
      : (process.env.XDG_DATA_HOME ??
        resolve(
          homeDirectory ?? resolve(root, ".arbor-user"),
          ".local",
          "share",
        ));
const databaseFile =
  dataDirectory !== undefined
    ? resolve(dataDirectory, "arbor.db")
    : resolve(
        process.env.ARBOR_DB ??
          resolve(defaultUserDataRoot, "Arbor", "data", "arbor.db"),
      );
const configuredProjectRoot =
  valueAfter("--project-root") ??
  inlineValue("--project-root") ??
  process.env.ARBOR_PROJECT_ROOT;
const webDist = resolve(root, "apps", "web", "dist");
const daemon = resolve(root, "apps", "single-workspace", "dist", "main.js");
const schemaOperator = resolve(
  root,
  "apps",
  "single-workspace",
  "dist",
  "schema-upgrade.js",
);
const url = `http://127.0.0.1:${port}/`;
const shouldOpen = command === "open" && !process.argv.includes("--no-open");
const background = command === "start";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const openBrowser = () => {
  if (!shouldOpen) return;
  const browserCommand =
    process.platform === "win32"
      ? ["cmd.exe", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const browserProcess = spawn(browserCommand[0], browserCommand[1], {
    cwd: root,
    stdio: "ignore",
    windowsHide: true,
  });
  browserProcess.on("error", () => {
    process.stderr.write(`请在浏览器中打开 ${url}\n`);
  });
  browserProcess.unref();
};

const isRunning = () => readRuntime(url, databaseFile);

const pidFile = resolve(dirname(databaseFile), `arbor-${port}.pid`);

const readPidRecord = () => {
  try {
    const record = JSON.parse(readFileSync(pidFile, "utf8"));
    return typeof record === "object" && record !== null ? record : null;
  } catch {
    return null;
  }
};

const removePid = () => {
  for (const marker of [pidFile]) {
    try {
      unlinkSync(marker);
    } catch {
      // Missing runtime marker is already the desired state.
    }
  }
};

const prepareBuild = () => {
  const existing = currentBuild(root);
  if (
    existing !== null &&
    existsSync(daemon) &&
    existsSync(schemaOperator) &&
    existsSync(resolve(webDist, "index.html"))
  )
    return existing;
  if (!existsSync(resolve(root, "apps/single-workspace/src/main.ts")))
    return null;
  process.stdout.write("正在构建当前源码对应的 Arbor，请稍候…\n");
  try {
    const sourceDigest = sourceFingerprint(root);
    execFileSync(pnpm, ["exec", "tsc", "-b", "--force"], {
      cwd: root,
      stdio: "inherit",
    });
    execFileSync(pnpm, ["--filter", "@arbor/web", "build"], {
      cwd: root,
      stdio: "inherit",
    });
    return recordBuild(root, sourceDigest);
  } catch {
    return null;
  }
};

const start = async () => {
  if (
    command === "check-environment" ||
    command === "install-environment" ||
    command === "reinstall-environment"
  ) {
    if (process.platform !== "linux") {
      console.error("隔离执行环境检查目前仅支持 Linux。");
      process.exitCode = 1;
      return;
    }
    if (prepareBuild() === null) {
      console.error("应用文件未准备好，请重新安装 Arbor。");
      process.exitCode = 1;
      return;
    }
    const { checkLinuxSandboxEnvironment } = await import(
      pathToFileURL(
        resolve(
          root,
          "apps/single-workspace/dist/transport/linux-sandbox-checks.js",
        ),
      ).href
    );
    const names = {
      "artifact-drift": "安装组件完整性",
      "file-rw": "项目文件读写",
      "file-ro": "只读文件保护",
      "file-outside-denied": "项目外文件隔离",
      "env-secret-absent": "宿主凭据隔离",
      "readonly-sharing": "只读共享文件",
      "socket-outside-denied": "宿主服务隔离",
      "host-loopback-denied": "宿主本地网络隔离",
      "same-namespace-tcp": "工作区内部服务连接",
      "namespace-escape-denied": "进程隔离边界",
      "raw-network-denied": "公网连接入口",
      "public-https": "公网 HTTPS 连接",
      "private-target-denied": "内网目标隔离",
      "dns-mixed-denied": "混合网络地址检查",
      "dns-rebinding": "重复连接地址检查",
      "process-limit": "进程数量限制",
      "output-bound": "命令输出限制",
      "resource-memory": "内存限制",
      "resource-cpu": "CPU 时间限制",
      "cancel-before-spawn": "启动前取消",
      "cancel-running-tree": "运行中停止进程树",
      "timeout-tree": "超时后停止进程树",
    };
    console.log("正在实际检查隔离执行环境，约需 3 分钟。检查只使用临时目录。");
    const runEnvironmentOperation =
      command === "install-environment" || command === "reinstall-environment"
        ? (
            await import(
              pathToFileURL(
                resolve(
                  root,
                  "apps/single-workspace/dist/transport/linux-environment-install.js",
                ),
              ).href
            )
          )[
            command === "reinstall-environment"
              ? "reinstallLinuxSandboxEnvironment"
              : "installLinuxSandboxEnvironment"
          ]
        : checkLinuxSandboxEnvironment;
    let report;
    try {
      report = await runEnvironmentOperation({
        outputDirectory: resolve(dirname(databaseFile), "environment-checks"),
        onProgress: (caseId, state) =>
          console.log(
            `${state === "running" ? "…" : state === "PASS" ? "✓" : "!"} ${names[caseId] ?? caseId}`,
          ),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        command === "install-environment" &&
        message.includes("An authority installation already exists")
      ) {
        console.error(
          "隔离执行环境已经安装；未修改现有环境。如需在 Arbor 或 Provider 升级后重新资格检查，请运行 arbor reinstall-environment。",
        );
        process.exitCode = 1;
        return;
      }
      if (
        command === "reinstall-environment" &&
        message.includes("not a regular directory")
      ) {
        console.error(
          "现有隔离执行环境路径不是受 Arbor 管理的普通目录；为避免覆盖可疑文件，未修改任何内容。",
        );
        process.exitCode = 1;
        return;
      }
      console.error(
        `执行环境操作未完成：${error?.code === "ELOCKED" ? "另一项环境安装正在运行；如果上次安装意外中断，请等约 30 秒后重试。" : (error?.message ?? error?.code ?? "请查看本机目录权限与存储条件。")}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`检查记录：${report.output}`);
    if (report.installed) {
      console.log(
        "隔离执行环境已安装。重新启动 Arbor 后可选择隔离执行策略；项目文件权限仍需在工作台授权。",
      );
      if (report.previousAuthorityDirectory !== undefined) {
        console.log(
          `旧隔离环境已保留：${report.previousAuthorityDirectory}。确认新环境稳定后可手动归档。`,
        );
      }
    } else if (report.status === "QualifiedCandidate") {
      console.log(
        "隔离环境检查通过。运行 arbor install-environment 可检查并安装到本机。",
      );
    } else {
      console.error("隔离环境检查未通过，命令任务仍不可用。请查看检查记录。");
      process.exitCode = 1;
    }
    return;
  }
  if (["backup", "verify-backup", "restore"].includes(command)) {
    if (process.platform !== "linux") {
      console.error("用户数据备份恢复目前仅支持 Linux。");
      process.exitCode = 1;
      return;
    }
    const from = valueAfter("--from") ?? inlineValue("--from");
    const to = valueAfter("--to") ?? inlineValue("--to");
    const explicitDataDir =
      valueAfter("--data-dir") ?? inlineValue("--data-dir");
    if (
      (command === "backup" && (!to || to.startsWith("--"))) ||
      (command !== "backup" && (!from || from.startsWith("--"))) ||
      (command === "restore" &&
        (!explicitDataDir || explicitDataDir.startsWith("--")))
    ) {
      console.error(
        "请明确指定备份目录；恢复还需要 --data-dir 指定一个尚不存在的新目录。运行 arbor --help 查看用法。",
      );
      process.exitCode = 1;
      return;
    }
    if (prepareBuild() === null) {
      console.error("应用文件尚未准备好，请检查安装或构建错误。");
      process.exitCode = 1;
      return;
    }
    try {
      const operator = await import(
        pathToFileURL(
          resolve(root, "apps/single-workspace/dist/user-data-backup.js"),
        ).href
      );
      if (command === "backup") {
        const report = await operator.createUserDataBackup(databaseFile, to);
        console.log(
          `备份完成：${resolve(to)}（${report.files.length} 个文件）`,
        );
        if (report.symbolicEnvironmentSnapshotReferences > 0)
          console.log(
            `注意：${report.symbolicEnvironmentSnapshotReferences} 条环境快照记录只有引用标记，未据此恢复内容字节。`,
          );
      } else if (command === "verify-backup") {
        const report = operator.verifyUserDataBackup(from);
        console.log(
          `备份校验通过：${report.files.length} 个文件及数据库内容引用均已核对。`,
        );
        if (report.symbolicEnvironmentSnapshotReferences > 0)
          console.log(
            `注意：${report.symbolicEnvironmentSnapshotReferences} 条环境快照记录只有引用标记，校验不代表这些字节已保存。`,
          );
      } else {
        const report = await operator.restoreUserDataBackup(
          from,
          explicitDataDir,
        );
        console.log(
          `数据已恢复至 ${resolve(explicitDataDir)}；${report.invalidatedLeases} 条旧运行租约已失效。`,
        );
        console.log(
          "项目源码、模型凭据和沙箱授权文件需要另外恢复。保持原实例停止，配置模型后使用此数据目录启动 Arbor；启动时会执行正常恢复检查。",
        );
      }
    } catch (cause) {
      const code =
        cause instanceof Error && "code" in cause
          ? String(cause.code)
          : "invalid-or-incomplete-backup";
      console.error(
        `备份/恢复未完成（${code.replace(/[^a-zA-Z0-9-]/gu, "?").slice(0, 100)}）。请停止 Arbor，检查目录、文件完整性和权限；已有目标目录不会被覆盖。`,
      );
      process.exitCode = 1;
    }
    return;
  }
  if (command === "status") {
    process.stdout.write(
      (await isRunning()) ? "Arbor 正在运行\n" : "Arbor 当前未运行\n",
    );
    return;
  }

  if (command === "stop") {
    const record = readPidRecord();
    const info = await isRunning();
    if (record === null) {
      process.stdout.write(
        info === null
          ? "Arbor 当前未由此启动器管理\n"
          : "此 Arbor 实例没有可核验的启动记录，未发送停止信号。\n",
      );
      return;
    }
    if (
      record.databaseFingerprint !== databaseFingerprint(databaseFile) ||
      !matchesManagedProcess(record, info, daemon)
    ) {
      process.stderr.write("启动记录已失效或属于其他进程，未发送停止信号。\n");
      removePid();
      process.exitCode = 1;
      return;
    }
    try {
      process.kill(record.pid);
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (!matchesManagedProcess(record, await isRunning(), daemon)) {
          removePid();
          process.stdout.write("Arbor 已停止\n");
          return;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
      process.stdout.write(
        "已请求 Arbor 停止，仍在等待进程退出；启动记录已保留。\n",
      );
      process.exitCode = 1;
    } catch {
      removePid();
      process.stdout.write("Arbor 当前未运行\n");
    }
    return;
  }

  if (command === "doctor") {
    const checks = [];
    const buildReady = currentBuild(root) !== null;
    checks.push({
      ok: buildReady,
      pass: "应用文件已准备好",
      fail: "应用文件尚未准备好",
    });
    const dataReady = (() => {
      try {
        mkdirSync(dirname(databaseFile), { recursive: true, mode: 0o700 });
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
      ...(process.env.HOME === undefined
        ? []
        : [resolve(process.env.HOME, ".config", "arbor", "arbor.config.json")]),
    ].filter((value) => typeof value === "string" && value.length > 0);
    let providerReady = false;
    let providerMessage = "尚未配置真实模型；配置完成后才能执行任务";
    for (const candidate of configCandidates) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8"));
        const secret = parsed?.provider?.secret;
        if (
          parsed?.provider !== undefined &&
          parsed.provider.modelRef !== "model-fake"
        ) {
          providerReady =
            secret?.kind === "inline"
              ? typeof secret.value === "string" && secret.value.length > 0
              : secret?.kind === "env"
                ? (process.env[secret.ref] ?? "").length > 0
                : secret?.kind === "file" && typeof secret.ref === "string"
                  ? (() => {
                      try {
                        return (
                          readFileSync(
                            resolve(
                              secret.root ?? dirname(candidate),
                              secret.ref,
                            ),
                            "utf8",
                          ).trim().length > 0
                        );
                      } catch {
                        return false;
                      }
                    })()
                  : false;
          providerMessage = providerReady
            ? "已检测到模型配置和凭据；网络连接尚未验证"
            : "模型配置存在，但凭据不可用";
        }
        break;
      } catch {
        // An absent or malformed optional config is reported by the daemon on start.
      }
    }
    if (
      !providerReady &&
      process.env.ARBOR_MODEL_BASE_URL &&
      process.env.ARBOR_MODEL_NAME &&
      process.env[process.env.ARBOR_MODEL_API_KEY_VAR ?? "ARBOR_MODEL_API_KEY"]
    ) {
      providerReady = true;
      providerMessage = "已检测到环境中的模型配置；网络连接尚未验证";
    }
    checks.push({
      ok: providerReady,
      pass: providerMessage,
      fail: providerMessage,
    });
    if (process.platform === "linux") {
      let linuxSandboxReady = false;
      if (buildReady) {
        try {
          const sandbox = await import(
            pathToFileURL(
              resolve(
                root,
                "apps",
                "single-workspace",
                "dist",
                "sandbox-linux-capability.js",
              ),
            ).href
          );
          const source = (
            await import(
              pathToFileURL(
                resolve(
                  root,
                  "apps",
                  "single-workspace",
                  "dist",
                  "sandbox-authority-default.js",
                ),
              ).href
            )
          ).defaultSandboxAuthoritySource();
          linuxSandboxReady =
            (await sandbox.probeInstalledLinuxSandbox(source)).status ===
            "Supported";
        } catch {
          linuxSandboxReady = false;
        }
      }
      checks.push({
        ok: linuxSandboxReady,
        pass: "Linux 隔离执行环境检查通过",
        fail: "Linux 隔离执行环境未就绪；需要完成环境安装检查，依赖安装、构建和测试暂不可用",
      });
    }
    process.stdout.write(
      `${checks.map((check) => `${check.ok ? "✓" : "!"} ${check.ok ? check.pass : check.fail}`).join("\n")}\n`,
    );
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
    return;
  }

  if (existsSync(resolve(dirname(databaseFile), ".arbor-restore-incomplete"))) {
    console.error(
      "此目录的备份恢复未完成。请恢复到另一个尚不存在的新目录后再启动。",
    );
    process.exitCode = 1;
    return;
  }

  const running = await isRunning();
  if (running !== null) {
    const build = currentBuild(root);
    if (build === null || running.buildId !== build.buildId) {
      process.stderr.write(
        "正在运行的 Arbor 与当前源码/构建不一致。请先运行 arbor stop，再启动以加载更新。\n",
      );
      process.exitCode = 1;
      return;
    }
    if (command === "open") openBrowser();
    process.stdout.write("Arbor 正在运行\n");
    return;
  }
  const build = prepareBuild();
  if (build === null) {
    console.error("Arbor 暂时无法启动，请检查安装是否完整及上方构建错误。");
    process.exitCode = 1;
    return;
  }

  // A fresh install qualifies its actual executor before model setup captures
  // the initial process mode. Existing configurations remain startup snapshots.
  if (process.platform === "linux" && !existsSync(databaseFile)) {
    const { findArborConfigFile } = await import(
      pathToFileURL(
        resolve(root, "apps/single-workspace/dist/provider-config.js"),
      ).href
    );
    const legacyModelConfigured = Boolean(
      process.env.ARBOR_MODEL_BASE_URL || process.env.ARBOR_MODEL_NAME,
    );
    if (findArborConfigFile() === undefined && !legacyModelConfigured) {
      const { defaultSandboxAuthoritySource, defaultSandboxAuthorityPaths } =
        await import(
          pathToFileURL(
            resolve(
              root,
              "apps/single-workspace/dist/sandbox-authority-default.js",
            ),
          ).href
        );
      const { probeInstalledLinuxSandbox } = await import(
        pathToFileURL(
          resolve(
            root,
            "apps/single-workspace/dist/sandbox-linux-capability.js",
          ),
        ).href
      );
      const capability = await probeInstalledLinuxSandbox(
        defaultSandboxAuthoritySource(),
      );
      if (capability.status !== "Supported") {
        if (existsSync(defaultSandboxAuthorityPaths().protectedRoot)) {
          console.error(
            "已有隔离执行环境与当前安装不匹配；原配置和检查记录已保留。请运行 arbor reinstall-environment 重新资格化。",
          );
          process.exitCode = 1;
          return;
        }
        process.stdout.write(
          "首次安装 Arbor：先检查并安装隔离执行环境，再打开模型配置。约需 3 分钟。\n",
        );
        try {
          execFileSync(
            process.execPath,
            [
              fileURLToPath(import.meta.url),
              "install-environment",
              "--data-dir",
              dirname(databaseFile),
            ],
            { cwd: root, env: process.env, stdio: "inherit" },
          );
        } catch {
          console.error(
            "首次命令环境安装未完成。请处理上方诊断，再运行 arbor；也可使用 arbor install-environment 重试。",
          );
          process.exitCode = 1;
          return;
        }
      }
    }
  }

  mkdirSync(dirname(databaseFile), { recursive: true, mode: 0o700 });
  if (!existsSync(databaseFile)) {
    process.stdout.write("正在初始化 Arbor 本地数据库…\n");
    const initializationEnvironment = { ...process.env };
    if (
      initializationEnvironment.ARBOR_DB !== undefined &&
      resolve(initializationEnvironment.ARBOR_DB) === databaseFile
    ) {
      delete initializationEnvironment.ARBOR_DB;
    }
    try {
      execFileSync(
        process.execPath,
        [
          schemaOperator,
          "--mode",
          "fresh",
          "--database",
          databaseFile,
          "--p39-report-db",
          `${databaseFile}.initialization-report.db`,
          "--copy-manifest",
          `${databaseFile}.initialization-manifest.jsonl`,
        ],
        {
          cwd: root,
          stdio: "inherit",
          env: initializationEnvironment,
        },
      );
    } catch {
      process.stderr.write(
        "Arbor 数据库初始化未完成；请保留报告和 manifest，检查目录保护与离线初始化诊断后再启动。\n",
      );
      process.exitCode = 1;
      return;
    }
  }

  const environment = {
    ...process.env,
    ARBOR_DB: databaseFile,
    ARBOR_BUILD_ID: build.buildId,
    ARBOR_HTTP_HOST: process.env.ARBOR_HTTP_HOST ?? "127.0.0.1",
    ARBOR_HTTP_PORT: port,
    ARBOR_WEB_DIST: webDist,
    ARBOR_PROJECT_PROFILE_NAME:
      process.env.ARBOR_PROJECT_PROFILE_NAME ?? "Arbor 项目文件",
    ...(configuredProjectRoot === undefined
      ? {}
      : { ARBOR_PROJECT_ROOT: configuredProjectRoot }),
  };

  const logFile = resolve(dirname(databaseFile), `arbor-${port}.log`);
  const logDescriptor = background ? openSync(logFile, "a", 0o600) : undefined;
  const daemonProcess = spawn(process.execPath, [daemon], {
    cwd: root,
    env: environment,
    stdio:
      logDescriptor === undefined
        ? "inherit"
        : ["ignore", logDescriptor, logDescriptor],
    detached: background,
  });
  if (logDescriptor !== undefined) closeSync(logDescriptor);
  let startupError;
  daemonProcess.once("error", (error) => {
    startupError = error;
  });
  if (background) daemonProcess.unref();

  const waitForWeb = async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (
        startupError !== undefined ||
        daemonProcess.exitCode !== null ||
        daemonProcess.signalCode !== null
      )
        break;
      try {
        const info = await isRunning();
        if (
          info === null ||
          info.pid !== daemonProcess.pid ||
          info.buildId !== build.buildId
        ) {
          throw new Error("waiting for this Arbor instance");
        }
        writeFileSync(pidFile, `${JSON.stringify(info)}\n`, { mode: 0o600 });
        if (command === "open") openBrowser();
        process.stdout.write("Arbor 已启动\n");
        return;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      }
    }
    console.error(
      `Arbor 服务未能在 ${url} 启动。${background ? `诊断日志：${logFile}` : "请检查上方诊断。"}`,
    );
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
