import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, extname, join, resolve, win32 } from "node:path";

export function buildProcessSpec({
  platform,
  executable,
  prefixArgs = [],
  args,
  cwd,
  env,
}) {
  return {
    executable,
    args: [...prefixArgs, ...args],
    options: {
      cwd,
      env,
      shell: false,
      windowsHide: platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  };
}

function isJavaScriptCli(path) {
  return /\.(?:c?js|mjs)$/i.test(path);
}

function directInvocation(candidate, { platform, cwd, nodeExecutable }) {
  if (!candidate) return null;
  const extension = extname(candidate).toLowerCase();
  const absolute =
    platform === "win32"
      ? win32.resolve(cwd, candidate)
      : resolve(cwd, candidate);
  if (!existsSync(absolute)) return null;
  if (isJavaScriptCli(absolute)) {
    return { executable: nodeExecutable, prefixArgs: [absolute] };
  }
  if (extension === ".exe" || (platform !== "win32" && !extension)) {
    return { executable: absolute, prefixArgs: [] };
  }
  if (platform === "win32" && extension === ".cmd") {
    return resolveWindowsCmdShim(absolute, { cwd, nodeExecutable });
  }
  return null;
}

function expandBatchValue(value, variables, shimDirectory) {
  let expanded = value.replace(/%~dp0%?/gi, `${shimDirectory}\\`);
  expanded = expanded.replace(/%([^%]+)%/g, (match, name) => {
    const replacement = variables.get(name.toLowerCase());
    return replacement === undefined ? match : replacement;
  });
  return expanded.trim().replace(/^"|"$/g, "");
}

function resolveWindowsCmdShim(cmdPath, { cwd, nodeExecutable }, depth = 0) {
  if (depth > 3) return null;
  const shimDirectory = win32.dirname(cmdPath);
  const lines = readFileSync(cmdPath, "utf8").split(/\r?\n/);
  const variables = new Map();

  for (const line of lines) {
    const assignment = line.match(
      /^\s*@?set\s+(?:"([^=]+)=([^"]*)"|([^=\s]+)=(.*))\s*$/i,
    );
    if (!assignment) continue;
    const name = (assignment[1] ?? assignment[3]).trim().toLowerCase();
    const value = assignment[2] ?? assignment[4] ?? "";
    variables.set(name, expandBatchValue(value, variables, shimDirectory));
  }

  for (const originalLine of lines) {
    const line = originalLine.trim().replace(/^@/, "");
    if (
      !line ||
      /^(?:echo\b|goto\b|call\s*:|exit\b|rem\b|::|set\b|if\b|for\b|shift\b)/i.test(
        line,
      ) ||
      line.startsWith(":")
    ) {
      continue;
    }

    const match = line.match(/^("[^"]+"|\S+)(?:\s+(.*))?$/);
    if (!match) continue;
    const executableToken = expandBatchValue(
      match[1],
      variables,
      shimDirectory,
    );
    const remainder = match[2] ?? "";
    const executablePath = win32.isAbsolute(executableToken)
      ? win32.normalize(executableToken)
      : win32.resolve(cwd, executableToken);
    const extension = extname(executableToken).toLowerCase();

    if (isJavaScriptCli(executableToken) && existsSync(executablePath)) {
      return { executable: nodeExecutable, prefixArgs: [executablePath] };
    }
    if (extension === ".exe" && existsSync(executablePath)) {
      const remainderMatch = remainder.match(/^\s*("[^"]+"|\S+)/);
      const nextToken = remainderMatch
        ? expandBatchValue(remainderMatch[1], variables, shimDirectory)
        : "";
      if (
        /\\node(?:\.exe)?$/i.test(executablePath) &&
        isJavaScriptCli(nextToken)
      ) {
        const scriptPath = win32.isAbsolute(nextToken)
          ? win32.normalize(nextToken)
          : win32.resolve(shimDirectory, nextToken);
        if (existsSync(scriptPath)) {
          return { executable: nodeExecutable, prefixArgs: [scriptPath] };
        }
      }
      return { executable: executablePath, prefixArgs: [] };
    }

    if (extension === ".cmd" && existsSync(executablePath)) {
      const nested = resolveWindowsCmdShim(
        executablePath,
        { cwd, nodeExecutable },
        depth + 1,
      );
      if (nested) return nested;
    }
  }
  return null;
}

function windowsCandidates(env, cwd, whereExecutable) {
  const candidates = [];
  const where = spawnSync(whereExecutable, ["pnpm"], {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (where.status === 0 && where.stdout) {
    candidates.push(
      ...where.stdout
        .split(/\r?\n/)
        .map((path) => path.trim())
        .filter(Boolean),
    );
  }
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    candidates.push(join(directory, "pnpm.exe"), join(directory, "pnpm.cmd"));
  }
  return [...new Set(candidates)];
}

export function resolvePnpmInvocation({
  platform = process.platform,
  env = process.env,
  cwd = process.cwd(),
  nodeExecutable = process.execPath,
  whereExecutable = "where.exe",
} = {}) {
  if (env.npm_execpath) {
    const fromNpmExecPath = directInvocation(env.npm_execpath, {
      platform,
      cwd,
      nodeExecutable,
    });
    if (fromNpmExecPath) return { ...fromNpmExecPath, source: "npm_execpath" };
  }

  if (platform !== "win32")
    return { executable: "pnpm", prefixArgs: [], source: "path" };

  for (const candidate of windowsCandidates(env, cwd, whereExecutable)) {
    const invocation = directInvocation(candidate, {
      platform,
      cwd,
      nodeExecutable,
    });
    if (invocation) return { ...invocation, source: candidate };
  }
  throw new Error(
    "Could not resolve pnpm to a verified native executable or JavaScript CLI; refusing shell invocation.",
  );
}
