import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = join(root, "planning/testing/manifest.json");

function fail(message) {
  throw new Error(`test manifest: ${message}`);
}

function walk(directory) {
  const paths = [];
  for (const entry of readdirSync(directory)) {
    if ([".git", "node_modules", "dist", ".test-results"].includes(entry))
      continue;
    const absolute = join(directory, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) paths.push(...walk(absolute));
    else if (stats.isFile())
      paths.push(relative(root, absolute).split(sep).join("/"));
  }
  return paths;
}

const repositoryFiles = walk(root);

function globToRegExp(glob) {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];
    if (char === "*" && next === "*") {
      index += 1;
      if (glob[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameSet(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function readConfigStrings(configText, field) {
  const expression = new RegExp(`${field}:\\s*\\[([\\s\\S]*?)\\]`);
  const block = configText.match(expression)?.[1];
  if (!block) fail(`could not read ${field} from its config`);
  return [...block.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
}

export function validateManifest(
  manifest = JSON.parse(readFileSync(manifestPath, "utf8")),
) {
  const errors = [];
  const report = (message) => errors.push(message);
  const groups = manifest.groups;
  const profiles = manifest.profiles;
  const allPaths = new Set();

  if (manifest.schemaVersion !== 1)
    report(`unsupported schemaVersion ${manifest.schemaVersion}`);
  for (const [groupName, paths] of Object.entries(groups ?? {})) {
    if (!Array.isArray(paths) || paths.length === 0) {
      report(`group ${groupName} must contain at least one exact path`);
      continue;
    }
    const seen = new Set();
    for (const path of paths) {
      if (
        typeof path !== "string" ||
        path.includes("*") ||
        isAbsolute(path) ||
        path.split("/").includes("..")
      ) {
        report(
          `group ${groupName} contains a non-exact or unsafe path: ${path}`,
        );
        continue;
      }
      if (seen.has(path))
        report(`group ${groupName} contains duplicate path ${path}`);
      seen.add(path);
      allPaths.add(path);
      if (!statSync(resolve(root, path), { throwIfNoEntry: false })?.isFile()) {
        report(`manifest path does not exist: ${path}`);
      }
    }
  }

  const functional = manifest.configuredSuites?.functionalVitest;
  const functionalConfigPath = resolve(root, functional?.config ?? "");
  if (
    !functional?.config ||
    !statSync(functionalConfigPath, { throwIfNoEntry: false })?.isFile()
  ) {
    report("functional Vitest config is missing");
  } else {
    const actualPatterns = readConfigStrings(
      readFileSync(functionalConfigPath, "utf8"),
      "include",
    );
    if (!sameSet(sorted(actualPatterns), sorted(functional.include ?? []))) {
      report(
        "manifest functional include patterns differ from vitest.functional.config.ts",
      );
    }
    const actualFiles = sorted(
      actualPatterns.flatMap((pattern) => {
        const expression = globToRegExp(pattern);
        return repositoryFiles.filter((path) => expression.test(path));
      }),
    );
    const manifestFiles = sorted(groups.functionalVitest ?? []);
    if (!sameSet(actualFiles, manifestFiles)) {
      const missing = actualFiles.filter(
        (path) => !manifestFiles.includes(path),
      );
      const extra = manifestFiles.filter((path) => !actualFiles.includes(path));
      report(
        `functional Vitest inventory mismatch (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
      );
    }
    if (new Set(actualFiles).size !== actualFiles.length)
      report("functional Vitest include patterns overlap");
  }

  const ui = manifest.configuredSuites?.functionalUi;
  const uiConfigPath = resolve(root, ui?.config ?? "");
  if (
    !ui?.config ||
    !statSync(uiConfigPath, { throwIfNoEntry: false })?.isFile()
  ) {
    report("functional Playwright config is missing");
  } else {
    const configText = readFileSync(uiConfigPath, "utf8");
    const actualTestDir = configText
      .match(/testDir:\s*["']([^"']+)["']/)?.[1]
      ?.replaceAll("\\", "/");
    if (actualTestDir !== `./${ui.testDir}` && actualTestDir !== ui.testDir) {
      report(
        "manifest Playwright testDir differs from playwright.functional.config.ts",
      );
    }
    if (!/retries:\s*0\b/.test(configText))
      report("functional Playwright config must retain retries: 0");
    const actualFiles = sorted(
      repositoryFiles.filter(
        (path) =>
          path.startsWith(`${ui.testDir}/`) && path.endsWith(ui.extension),
      ),
    );
    const manifestFiles = sorted(groups.functionalUi ?? []);
    if (!sameSet(actualFiles, manifestFiles)) {
      const missing = actualFiles.filter(
        (path) => !manifestFiles.includes(path),
      );
      const extra = manifestFiles.filter((path) => !actualFiles.includes(path));
      report(
        `functional UI inventory mismatch (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
      );
    }
  }

  if (groups.functionalVitest?.length !== 47)
    report(
      `expected 47 configured functional Vitest files, found ${groups.functionalVitest?.length ?? 0}`,
    );
  if (groups.functionalUi?.length !== 6)
    report(
      `expected 6 configured functional UI files, found ${groups.functionalUi?.length ?? 0}`,
    );
  for (const required of [
    "quick",
    "smoke",
    "crashSentinels",
    "package",
    "functionalVitest",
    "functionalUi",
  ]) {
    if (!Array.isArray(groups[required]) || groups[required].length === 0)
      report(`required group is absent: ${required}`);
  }
  const functionalUiOverlap = (groups.functionalVitest ?? []).filter((path) =>
    (groups.functionalUi ?? []).includes(path),
  );
  if (functionalUiOverlap.length > 0)
    report(
      `functional Vitest/UI groups overlap: ${functionalUiOverlap.join(", ")}`,
    );

  for (const [profileName, profile] of Object.entries(profiles ?? {})) {
    if (!Array.isArray(profile.groups) || profile.groups.length === 0) {
      report(`profile ${profileName} must name at least one group`);
      continue;
    }
    const resolved = profile.groups.flatMap(
      (groupName) => groups[groupName] ?? [],
    );
    if (resolved.length === 0)
      report(`profile ${profileName} resolves to no files`);
    if (new Set(resolved).size !== resolved.length)
      report(`profile ${profileName} selects the same file more than once`);
    if (profile.retries !== undefined && profile.retries !== 0)
      report(`profile ${profileName} must not retry tests`);
    if (profileName === "release" || profileName === "all") {
      const requiredGroups = ["functionalVitest", "functionalUi"];
      if (!sameSet(sorted(profile.groups), sorted(requiredGroups)))
        report(
          `profile ${profileName} must require complete functional Vitest and UI groups`,
        );
      if (
        profile.cache !== "never" ||
        profile.retries !== 0 ||
        profile.completeCoverage !== true
      ) {
        report(
          `profile ${profileName} must disable cache, set zero retries, and declare complete coverage`,
        );
      }
    } else if (profile.completeCoverage !== false) {
      report(`profile ${profileName} cannot claim complete release coverage`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    functionalVitestFiles: groups.functionalVitest.length,
    functionalUiFiles: groups.functionalUi.length,
    manifestPaths: allPaths.size,
    profiles: Object.keys(profiles),
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = validateManifest();
    if (!result.ok) {
      console.error(result.errors.map((error) => `- ${error}`).join("\n"));
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
