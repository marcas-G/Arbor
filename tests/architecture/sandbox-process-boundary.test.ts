import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { LanguageVariant, SyntaxKind } from "typescript/unstable/ast";
import { createScanner } from "typescript/unstable/ast/scanner";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const productionRoots = ["packages", "apps", "adapters"];
const sourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const skippedDirectories = new Set([
  ".git",
  "coverage",
  "dist",
  "fixtures",
  "node_modules",
  "test",
  "tests",
  "__tests__",
]);
const p39SpawnModule =
  "adapters/persistence-sqlite/src/p39-windows-security.ts";
const p39QueryCallers = new Set([
  "adapters/persistence-sqlite/src/p39-report-database.ts",
  "adapters/persistence-sqlite/src/p39-windows-security.ts",
]);
const p39ValidationCallers = new Set([
  "adapters/persistence-sqlite/src/p39-writer-lock.ts",
]);
const childProcessSpecifier = /^(?:node:)?child_process(?:\/.*)?$/iu;
const nativeSpawnIdentifiers = new Set([
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
  "spawn",
  "spawnSync",
]);

const normalized = (path: string) =>
  relative(repoRoot, path).split(sep).join("/");

const productionFiles = (directory: string): ReadonlyArray<string> => {
  const absolute = join(repoRoot, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const path = join(absolute, entry.name);
    if (entry.isDirectory()) {
      return skippedDirectories.has(entry.name)
        ? []
        : productionFiles(relative(repoRoot, path));
    }
    return entry.isFile() && sourceExtensions.has(extname(entry.name))
      ? [path]
      : [];
  });
};

interface Token {
  readonly kind: SyntaxKind;
  readonly text: string;
  readonly value: string;
}

const tokenize = (source: string): ReadonlyArray<Token> => {
  const scanner = createScanner(
    true,
    LanguageVariant.Standard,
    source,
    0,
    source.length,
  );
  const result: Token[] = [];
  let previousEnd = 0;
  let scans = 0;
  const templateExpressionDepths: number[] = [];
  while (true) {
    let kind = scanner.scan();
    if (kind === SyntaxKind.EndOfFile) return result;
    if (kind === SyntaxKind.BacktickToken) {
      kind = scanner.reScanTemplateHeadOrNoSubstitutionTemplate();
    } else if (
      kind === SyntaxKind.CloseBraceToken &&
      templateExpressionDepths.length > 0
    ) {
      const depth = templateExpressionDepths.at(-1);
      if (depth === undefined) {
        throw new Error("template interpolation stack is inconsistent");
      }
      if (depth === 0) {
        kind = scanner.reScanTemplateToken(false);
      } else {
        templateExpressionDepths[templateExpressionDepths.length - 1] =
          depth - 1;
      }
    }
    if (kind === SyntaxKind.TemplateHead) {
      templateExpressionDepths.push(0);
    } else if (kind === SyntaxKind.LastTemplateToken) {
      templateExpressionDepths.pop();
    } else if (
      kind === SyntaxKind.OpenBraceToken &&
      templateExpressionDepths.length > 0
    ) {
      templateExpressionDepths[templateExpressionDepths.length - 1] =
        (templateExpressionDepths.at(-1) ?? 0) + 1;
    }
    scans += 1;
    if (scans > source.length * 4 + 128) {
      throw new Error("TypeScript scanner did not reach end of source");
    }
    const tokenStart = scanner.getTokenStart();
    const tokenEnd = scanner.getTokenEnd();
    if (tokenEnd <= previousEnd) {
      if (kind === SyntaxKind.PrivateIdentifier && tokenStart === tokenEnd) {
        // The context-free scanner emits a zero-width private identifier for
        // `#` inside a regular-expression literal. Skip the marker and resume.
        scanner.setText(source, tokenStart + 1, source.length - tokenStart - 1);
        previousEnd = tokenStart + 1;
        continue;
      }
      throw new Error("TypeScript scanner produced a zero-width source token");
    }
    previousEnd = tokenEnd;
    const text = scanner.getTokenText();
    const value =
      kind === SyntaxKind.StringLiteral ||
      kind === SyntaxKind.NoSubstitutionTemplateLiteral
        ? scanner.getTokenValue()
        : text;
    result.push({ kind, text, value });
  }
};

const hasSequence = (
  values: ReadonlyArray<string>,
  sequence: ReadonlyArray<string>,
): boolean =>
  values.some((_, start) =>
    sequence.every((value, offset) => values[start + offset] === value),
  );

const callCount = (source: string, name: string): number => {
  const tokens = tokenize(source);
  return tokens.filter(
    (token, index) => token.value === name && tokens[index + 1]?.text === "(",
  ).length;
};

const scanSource = (source: string, path: string): ReadonlyArray<string> => {
  let tokens: ReadonlyArray<Token>;
  try {
    tokens = tokenize(source);
  } catch (cause) {
    return [`${path}: TypeScript token audit failed closed (${String(cause)})`];
  }
  const values = tokens.map(({ value }) => value);
  const findings: string[] = [];
  const isP39 = path === p39SpawnModule;
  const p39SpecifierIndex = isP39
    ? tokens.findIndex(
        (token) =>
          token.value === "node:child_process" &&
          tokens[tokens.indexOf(token) - 1]?.value === "from",
      )
    : -1;

  tokens.forEach((token, index) => {
    if (
      (token.kind === SyntaxKind.StringLiteral ||
        token.kind === SyntaxKind.NoSubstitutionTemplateLiteral) &&
      childProcessSpecifier.test(token.value) &&
      !(isP39 && index === p39SpecifierIndex)
    ) {
      findings.push(
        `${path}: forbidden process module value ${JSON.stringify(token.value)}`,
      );
    }

    if (
      token.kind === SyntaxKind.Identifier &&
      token.value === "createRequire"
    ) {
      findings.push(`${path}: createRequire escape point`);
    }
    if (token.kind === SyntaxKind.Identifier && token.value === "require") {
      findings.push(`${path}: CommonJS require escape point`);
    }

    if (
      token.kind === SyntaxKind.Identifier &&
      (token.value === "eval" || token.value === "Function") &&
      (tokens[index + 1]?.text === "(" ||
        (token.value === "Function" && tokens[index - 1]?.value === "new"))
    ) {
      findings.push(`${path}: dynamic-code escape point ${token.value}`);
    }

    if (
      token.kind === SyntaxKind.Identifier &&
      token.value === "process" &&
      [".", "?."].includes(tokens[index + 1]?.text ?? "") &&
      ["binding", "_linkedBinding", "dlopen"].includes(
        tokens[index + 2]?.value ?? "",
      )
    ) {
      findings.push(`${path}: process native loader/binding escape point`);
    }
    if (
      token.kind === SyntaxKind.Identifier &&
      tokens[index - 1]?.text === "." &&
      ["binding", "_linkedBinding", "dlopen"].includes(token.value) &&
      tokens[index + 1]?.text === "("
    ) {
      findings.push(`${path}: aliased native loader/binding escape point`);
    }
    if (
      token.kind === SyntaxKind.StringLiteral &&
      ["binding", "_linkedBinding", "dlopen"].includes(token.value) &&
      tokens[index + 1]?.text === "]" &&
      tokens[index + 2]?.text === "("
    ) {
      findings.push(`${path}: computed native loader/binding escape point`);
    }

    if (token.kind === SyntaxKind.Identifier && token.value === "import") {
      const dynamic = tokens[index + 1]?.text === "(";
      if (
        dynamic &&
        !(
          (tokens[index + 2]?.kind === SyntaxKind.StringLiteral ||
            tokens[index + 2]?.kind ===
              SyntaxKind.NoSubstitutionTemplateLiteral) &&
          tokens[index + 3]?.text === ")"
        )
      ) {
        findings.push(`${path}: computed dynamic import`);
      }
    }

    if (
      token.kind === SyntaxKind.Identifier &&
      (token.value === "require" ||
        (token.value === "require" && tokens[index - 1]?.text === ".")) &&
      tokens[index + 1]?.text === "("
    ) {
      if (
        tokens[index + 2]?.kind !== SyntaxKind.StringLiteral &&
        tokens[index + 2]?.kind !== SyntaxKind.NoSubstitutionTemplateLiteral
      ) {
        findings.push(`${path}: computed require`);
      }
    }

    const callName = token.value;
    const isCall = tokens[index + 1]?.text === "(";
    if (
      token.kind === SyntaxKind.Identifier &&
      nativeSpawnIdentifiers.has(callName) &&
      isCall &&
      !(isP39 && callName === "execFileSync")
    ) {
      findings.push(`${path}: unregistered native process call ${callName}`);
    }
    if (
      token.kind === SyntaxKind.Identifier &&
      nativeSpawnIdentifiers.has(callName) &&
      tokens[index - 1]?.text === "." &&
      isCall
    ) {
      findings.push(
        `${path}: unregistered native process member call ${callName}`,
      );
    }
    if (
      token.kind === SyntaxKind.Identifier &&
      token.value === "Command" &&
      tokens[index - 1]?.text === "." &&
      tokens[index - 2]?.value === "Deno" &&
      isCall
    ) {
      findings.push(`${path}: Deno process creation`);
    }
  });

  if (isP39) {
    const execFileSyncCalls = tokens.filter(
      (token, index) =>
        token.value === "execFileSync" && tokens[index + 1]?.text === "(",
    ).length;
    const fixedImport = hasSequence(values, [
      "import",
      "{",
      "execFileSync",
      "}",
      "from",
      "node:child_process",
      ";",
    ]);
    const fixedQuery = hasSequence(values, [
      "executor",
      "(",
      "powershell.exe",
      ",",
      "[",
      "-NoProfile",
      ",",
      "-NonInteractive",
      ",",
      "-Command",
      ",",
      "script",
      "]",
      ",",
    ]);
    const fixedTimeout = hasSequence(values, [
      "timeout",
      ":",
      "P39_WINDOWS_SECURITY_QUERY_TIMEOUT_MS",
    ]);
    if (
      execFileSyncCalls !== 1 ||
      !fixedImport ||
      !fixedQuery ||
      !fixedTimeout
    ) {
      findings.push(
        `${path}: P39 process probe is outside its fixed audited template`,
      );
    }
  }
  return findings;
};

describe("SandboxProcessPort architecture boundary", () => {
  it("uses TypeScript compiler tokens to scan every production source module", () => {
    const files = productionRoots.flatMap(productionFiles);
    const inventory = files.map(normalized).sort();
    expect(inventory.length).toBeGreaterThan(0);
    expect(sourceExtensions.has(".mjs")).toBe(true);
    expect(sourceExtensions.has(".cjs")).toBe(true);
    expect(
      files.flatMap((file) =>
        scanSource(readFileSync(file, "utf8"), normalized(file)),
      ),
    ).toEqual([]);
    expect(
      readFileSync(
        join(repoRoot, "packages/ports/src/sandbox-process.ts"),
        "utf8",
      ),
    ).toContain("SandboxProcessPort");
  });

  it.each([
    'import { spawn } from "node:child_process";',
    'await import("child_process/promises");',
    'const cp = require("node:child_process");',
    'const req = createRequire(import.meta.url); req("child_process");',
    'await import("node:" + "child_process");',
    'process.binding("spawn_sync");',
    'process["binding"]("spawn_sync");',
    "const make = createRequire; make(import.meta.url);",
    "const hidden = `node:child_process`;",
  ])("rejects spawn escape fixture %s", (source) => {
    expect(
      scanSource(source, "packages/test-fixture.ts").length,
    ).toBeGreaterThan(0);
  });

  it("keeps the P39 exception limited to registered query and validation call sites", () => {
    const files = productionRoots.flatMap(productionFiles);
    const directQueryCallers = files
      .filter((file) =>
        readFileSync(file, "utf8").includes("executeP39WindowsSecurityQuery"),
      )
      .map(normalized)
      .sort();
    expect(directQueryCallers).toEqual([...p39QueryCallers].sort());
    expect(
      callCount(
        readFileSync(
          join(
            repoRoot,
            "adapters/persistence-sqlite/src/p39-report-database.ts",
          ),
          "utf8",
        ),
        "executeP39WindowsSecurityQuery",
      ),
    ).toBe(1);
    const validationCallers = files
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return (
          source.includes("validateP39WindowsProtectedPaths") &&
          source.includes('from "./p39-windows-security.js"')
        );
      })
      .map(normalized)
      .sort();
    expect(validationCallers).toEqual([...p39ValidationCallers].sort());
    expect(
      callCount(
        readFileSync(
          join(repoRoot, "adapters/persistence-sqlite/src/p39-writer-lock.ts"),
          "utf8",
        ),
        "validateP39WindowsProtectedPaths",
      ),
    ).toBe(1);
    const source = readFileSync(join(repoRoot, p39SpawnModule), "utf8");
    expect(scanSource(source, p39SpawnModule)).toEqual([]);
  });
});
