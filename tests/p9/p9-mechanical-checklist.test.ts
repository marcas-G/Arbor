import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type Expression,
  isArrayLiteralExpression,
  isCallExpression,
  isComputedPropertyName,
  isExportAssignment,
  isIdentifier,
  isImportDeclaration,
  isImportSpecifier,
  isNamedImports,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type SourceFile as TypeScriptSourceFile,
} from "typescript/unstable/ast";
import { API as TypeScriptAPI } from "typescript/unstable/sync";
import { describe, expect, it } from "vitest";
import {
  cleanupRunOwnedDurableRoots,
  durableFile,
  expectedThrowCleanupRoots,
  isSafeP9TempRootPath,
  P9_DURABLE_TEMP_PREFIX,
  runOwnedDurableRoots,
  validateRunOwnedDurableRoot,
} from "./support.js";

// ---------------------------------------------------------------------------
// Mechanical assertion checklist (06 §机械断言清单).
// ---------------------------------------------------------------------------

const P9_DIR = join(import.meta.dirname, ".."); // tests/ (file moved into tests/p9/)
const REPO_ROOT = join(P9_DIR, "..");

const requireFromTest = createRequire(import.meta.url);
const requireFromVitest = createRequire(
  requireFromTest.resolve("vitest/package.json"),
);
const picomatch = requireFromVitest("picomatch") as (
  pattern: string,
) => (path: string) => boolean;

const parseArchitectureConfigArgument = (script: string) => {
  if (/[\r\n]/u.test(script) || !/^[A-Za-z0-9_./=:\t -]+$/u.test(script))
    return undefined;
  const tokens = script.trim().split(/[ \t]+/u);
  let argumentsStart: number;
  if (tokens[0] === "vitest" && tokens[1] === "run") {
    argumentsStart = 2;
  } else if (
    tokens[0] === "pnpm" &&
    tokens[1] === "exec" &&
    tokens[2] === "vitest" &&
    tokens[3] === "run"
  ) {
    argumentsStart = 4;
  } else {
    return undefined;
  }

  const arguments_ = tokens.slice(argumentsStart);
  const configOptions = arguments_.filter(
    (token) => token === "--config" || token.startsWith("--config="),
  );
  if (configOptions.length !== 1) return undefined;
  if (configOptions[0] === "--config") {
    if (arguments_.length !== 2) return undefined;
    const configPath = arguments_[1];
    return configPath !== undefined && !configPath.startsWith("-")
      ? configPath
      : undefined;
  }
  if (arguments_.length !== 1) return undefined;
  const configPath = configOptions[0]?.slice("--config=".length);
  return configPath !== undefined &&
    configPath.length > 0 &&
    !configPath.startsWith("-")
    ? configPath
    : undefined;
};

const readUniqueStaticProperties = (object: ObjectLiteralExpression) => {
  const properties = new Map<string, ObjectLiteralElementLike>();
  for (const property of object.properties) {
    if (isSpreadAssignment(property)) return undefined;
    if (isComputedPropertyName(property.name)) return undefined;
    const propertyName =
      isIdentifier(property.name) || isStringLiteral(property.name)
        ? property.name.text
        : undefined;
    if (propertyName === undefined || properties.has(propertyName))
      return undefined;
    properties.set(propertyName, property);
  }
  return properties;
};

const readStaticStringArray = (
  expression: Expression,
): ReadonlyArray<string> | undefined => {
  if (!isArrayLiteralExpression(expression)) return undefined;
  const values: string[] = [];
  for (const element of expression.elements) {
    if (!isStringLiteral(element)) return undefined;
    values.push(element.text);
  }
  return values;
};

const hasTrustedDefineConfigImport = (sourceFile: TypeScriptSourceFile) => {
  const imports = sourceFile.statements.filter(isImportDeclaration);
  if (imports.length !== 1) return false;
  const declaration = imports[0];
  if (
    declaration === undefined ||
    !isStringLiteral(declaration.moduleSpecifier) ||
    declaration.moduleSpecifier.text !== "vitest/config" ||
    declaration.attributes !== undefined
  )
    return false;
  const clause = declaration.importClause;
  if (
    clause === undefined ||
    clause.name !== undefined ||
    clause.phaseModifier !== undefined ||
    clause.namedBindings === undefined ||
    !isNamedImports(clause.namedBindings) ||
    clause.namedBindings.elements.length !== 1
  )
    return false;
  const specifier = clause.namedBindings.elements[0];
  if (
    specifier === undefined ||
    !isImportSpecifier(specifier) ||
    specifier.isTypeOnly ||
    specifier.propertyName !== undefined ||
    specifier.name.text !== "defineConfig"
  )
    return false;

  let defineConfigIdentifierCount = 0;
  const visit = (node: import("typescript/unstable/ast").Node) => {
    if (isIdentifier(node) && node.text === "defineConfig")
      defineConfigIdentifierCount += 1;
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return defineConfigIdentifierCount === 2;
};

const parseArchitectureConfigSource = (sourceFile: TypeScriptSourceFile) => {
  if (!hasTrustedDefineConfigImport(sourceFile)) return undefined;
  const exports = sourceFile.statements.filter(isExportAssignment);
  if (exports.length !== 1 || exports[0]?.isExportEquals !== false)
    return undefined;
  const expression = exports[0].expression;
  if (
    !isCallExpression(expression) ||
    !isIdentifier(expression.expression) ||
    expression.expression.text !== "defineConfig" ||
    expression.arguments.length !== 1
  )
    return undefined;
  const rootConfig = expression.arguments[0];
  if (rootConfig === undefined || !isObjectLiteralExpression(rootConfig))
    return undefined;
  const rootProperties = readUniqueStaticProperties(rootConfig);
  const testProperty = rootProperties?.get("test");
  if (
    testProperty === undefined ||
    !isPropertyAssignment(testProperty) ||
    !isObjectLiteralExpression(testProperty.initializer)
  )
    return undefined;
  const testProperties = readUniqueStaticProperties(testProperty.initializer);
  const includeProperty = testProperties?.get("include");
  if (includeProperty === undefined || !isPropertyAssignment(includeProperty))
    return undefined;
  const include = readStaticStringArray(includeProperty.initializer);
  if (include === undefined) return undefined;
  const excludeProperty = testProperties?.get("exclude");
  if (excludeProperty === undefined) return { include, exclude: [] };
  if (!isPropertyAssignment(excludeProperty)) return undefined;
  const exclude = readStaticStringArray(excludeProperty.initializer);
  return exclude === undefined ? undefined : { include, exclude };
};

const parseArchitectureConfigFiles = (configPaths: ReadonlyArray<string>) => {
  const api = new TypeScriptAPI({ cwd: REPO_ROOT });
  try {
    const documents = configPaths.map((path) => ({
      uri: pathToFileURL(path).href,
    }));
    const snapshot = api.updateSnapshot({ openFiles: documents });
    return documents.map((document, index) => {
      const project = snapshot.getDefaultProjectForFile(document);
      if (project === undefined) return undefined;
      if (project.program.getSyntacticDiagnostics(document).length > 0)
        return undefined;
      const sourceFile = project.program.getSourceFile(document);
      if (sourceFile === undefined) return undefined;
      const configPath = configPaths[index];
      if (
        configPath === undefined ||
        sourceFile.text !== readFileSync(configPath, "utf8")
      )
        return undefined;
      return parseArchitectureConfigSource(sourceFile);
    });
  } catch {
    return configPaths.map(() => undefined);
  } finally {
    api.close();
  }
};
const enumerateTestFilesRecursively = (
  directory: string,
  repositoryRelativeDirectory: string,
): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(directory, entry.name);
    const relativePath = `${repositoryRelativeDirectory}/${entry.name}`;
    if (entry.isDirectory())
      return enumerateTestFilesRecursively(absolutePath, relativePath);
    if (entry.isFile() && entry.name.endsWith(".test.ts"))
      return [relativePath];
    return [];
  });

const isCoveredByVitestGlobs = (
  includeGlobs: ReadonlyArray<string>,
  excludeGlobs: ReadonlyArray<string>,
  testFiles: ReadonlyArray<string>,
) =>
  testFiles.every(
    (testFile) =>
      includeGlobs.some((pattern) => picomatch(pattern)(testFile)) &&
      !excludeGlobs.some((pattern) => picomatch(pattern)(testFile)),
  );

const resolvesToRepositoryFile = (repositoryRoot: string, path: string) => {
  try {
    const realRepositoryRoot = realpathSync(repositoryRoot);
    const realCandidate = realpathSync(resolve(repositoryRoot, path));
    const relativeCandidate = relative(realRepositoryRoot, realCandidate);
    return (
      relativeCandidate !== "" &&
      relativeCandidate !== ".." &&
      !relativeCandidate.startsWith(`..${sep}`) &&
      !isAbsolute(relativeCandidate)
    );
  } catch {
    return false;
  }
};

const hasArchitectureCheckSteps = (checkScript: string) => {
  const steps = checkScript.split("&&").map((step) => step.trim());
  const architectureIndex = steps.indexOf("pnpm architecture");
  const coreTestIndex = steps.indexOf("pnpm test");
  return (
    architectureIndex >= 0 &&
    coreTestIndex >= 0 &&
    architectureIndex < coreTestIndex
  );
};
const P9_SUITE_SCAN_DIRS = [
  P9_DIR,
  join(P9_DIR, "p9-worker-crash"),
  join(P9_DIR, "p9-provider-disconnect"),
  join(P9_DIR, "p9-workflow-interruption"),
];

const p9SuiteSources = () =>
  P9_SUITE_SCAN_DIRS.flatMap((dir) =>
    readdirSync(dir)
      .filter(
        (name) =>
          /^p9-.*\.test\.ts$/.test(name) && name !== "p9-acceptance.test.ts",
      )
      .map((name) => ({
        name,
        source: readFileSync(join(dir, name), "utf8"),
      })),
  );
// biome-ignore format: keep the owning-suite list adjacent to its face rows
const P9_PD_SUITES = [
  "tests/p9-provider-disconnect/p9-provider-disconnect-turns.test.ts",
  "tests/p9-provider-disconnect/p9-provider-disconnect-recovery.test.ts"];

/** Coverage-audit table: matrix face (02 §1–§12) → owning suite files. */
const FACE_SUITES: ReadonlyArray<{
  readonly face: string;
  readonly section: string;
  readonly rowPattern: RegExp;
  readonly suites: ReadonlyArray<string>;
}> = [
  {
    face: "W",
    section: "02 §1 worker crash",
    rowPattern: /\bW[1-5]\b/,
    suites: ["tests/p9-worker-crash/p9-worker-crash-w.test.ts"],
  },
  {
    face: "R",
    section: "02 §2 old-worker resurrection",
    rowPattern: /\bR[1-6]\b/,
    suites: ["tests/p9-worker-crash/p9-resurrection.test.ts"],
  },
  {
    face: "L",
    section: "02 §3 lease expiry",
    rowPattern: /\bL[1-4]\b/,
    suites: ["tests/p9-lease-expiry.test.ts", "tests/p9-lease-renewal.test.ts"],
  },
  {
    face: "D",
    section: "02 §4 daemon crash / dirty restart",
    rowPattern: /\bD[1-6]\b/,
    suites: [
      "tests/p9-recovery-driver.test.ts",
      "tests/p9-timer-refire.test.ts",
      "tests/p9-tool-outcome-unknown.test.ts",
      "tests/p9-workflow-interruption/p9-dispatch-recovery.test.ts",
    ],
  },
  {
    face: "T",
    section: "02 §5 tool outcome unknown",
    rowPattern: /\bT[1-4]\b/,
    suites: ["tests/p9-tool-outcome-unknown.test.ts"],
  },
  {
    face: "PD",
    section: "02 §6 provider disconnect",
    rowPattern: /\bPD[1-4]\b/,
    suites: P9_PD_SUITES,
  },
  {
    face: "CC",
    section: "02 §7 consumer crash",
    rowPattern: /\bCC-?[1-6]\b/,
    suites: ["tests/p9-consumer-crash.test.ts"],
  },
  {
    face: "WF",
    section: "02 §8 P7/P8 workflow interruption replay",
    rowPattern: /\bWF[1-3]\b/,
    suites: ["tests/p9-workflow-interruption/p9-workflow-replay.test.ts"],
  },
  {
    face: "DF",
    section: "02 §9 dispatch failure / lost dispatch",
    rowPattern: /\bDF[1-2]\b/,
    suites: ["tests/p9-workflow-interruption/p9-dispatch-recovery.test.ts"],
  },
  {
    face: "PR",
    section: "02 §10 projection rebuild (generic, GQ2)",
    rowPattern: /\bPR[1-4]\b/,
    suites: ["tests/p9-rebuild-durability.test.ts"],
  },
  {
    face: "PB",
    section: "02 §11 persistence-boundary faults",
    rowPattern: /\bPB[1-3]\b/,
    suites: ["tests/p9-harness-fault-modes.test.ts"],
  },
  {
    face: "DA",
    section: "02 §12 durability-asserted (GQ5)",
    rowPattern: /\bDA[12]\b/,
    suites: ["tests/p9-rebuild-durability.test.ts"],
  },
];

const REGRESSION_GUARDS: ReadonlyArray<{
  readonly phase: string;
  readonly pattern: RegExp;
  readonly minimum: number;
}> = [
  { phase: "P5", pattern: /^p5-.*\.test\.ts$/, minimum: 9 },
  { phase: "P6", pattern: /^p6-.*\.test\.ts$/, minimum: 13 },
  { phase: "P7", pattern: /^p7-.*\.test\.ts$/, minimum: 13 },
  { phase: "P8", pattern: /^p8-.*\.test\.ts$/, minimum: 9 },
];

describe("p9-acceptance mechanical assertions (06 checklist)", () => {
  it("matrix coverage audit: every 02 face has ≥1 mechanical case and its owning suite file exists", () => {
    const sources = p9SuiteSources();
    expect(sources.length).toBeGreaterThanOrEqual(12);
    for (const entry of FACE_SUITES) {
      for (const suite of entry.suites) {
        expect(
          existsSync(join(REPO_ROOT, suite)),
          `${entry.face} owning suite ${suite}`,
        ).toBe(true);
      }
      const hits = sources.filter((file) => entry.rowPattern.test(file.source));
      expect(
        hits.length,
        `${entry.face} (${entry.section}) needs ≥1 case across the p9 suites`,
      ).toBeGreaterThanOrEqual(1);
      // B-10 disambiguation: every suite names the phase.
      for (const file of hits) {
        expect(file.source.includes("P9"), file.name).toBe(true);
      }
    }
  });

  it("guarantee labeling is complete: every harness record carries exactly one of the two frozen classes (GQ5)", () => {
    const sources = p9SuiteSources();
    const callPattern = /labeled\(\s*"[^"]*"\s*,\s*"([^"]*)"\s*\)/g;
    const classes: Record<string, number> = {};
    let calls = 0;
    for (const file of sources) {
      for (const match of file.source.matchAll(callPattern)) {
        calls += 1;
        const guarantee = match[1] ?? "";
        classes[guarantee] = (classes[guarantee] ?? 0) + 1;
      }
    }
    expect(calls).toBeGreaterThanOrEqual(40);
    expect(Object.keys(classes).sort()).toEqual([
      "crash-injected",
      "durability-asserted",
    ]);
    expect(classes["crash-injected"] ?? 0).toBeGreaterThanOrEqual(1);
    expect(classes["durability-asserted"] ?? 0).toBeGreaterThanOrEqual(1);
    // The convention itself is frozen in the harness API (two classes
    // only, never a third).
    const harnessApi = readFileSync(
      join(P9_DIR, "support", "harness-api.ts"),
      "utf8",
    );
    expect(
      harnessApi.includes('"crash-injected" | "durability-asserted"'),
    ).toBe(true);
  });

  it("P5–P8 regression guards present and chained into pnpm check", () => {
    for (const guard of REGRESSION_GUARDS) {
      const inTests = readdirSync(P9_DIR).filter((name) =>
        guard.pattern.test(name),
      );
      const inApps = readdirSync(
        join(REPO_ROOT, "apps", "single-workspace", "test"),
      ).filter((name) => guard.pattern.test(name));
      expect(
        inTests.length + inApps.length,
        `${guard.phase} guard suites`,
      ).toBeGreaterThanOrEqual(guard.minimum);
    }
    const architecture = readdirSync(join(P9_DIR, "architecture"));
    for (const phase of ["p5", "p6", "p7", "p8"]) {
      expect(
        architecture.includes(`${phase}-architecture.test.ts`),
        phase,
      ).toBe(true);
    }
    // The pnpm check reference assertion: the guard chain itself is wired
    // (lint + typecheck + architecture + test, all green together).
    const scripts = (
      JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
        scripts: {
          check?: string;
          architecture?: string;
          test?: string;
        };
      }
    ).scripts;
    const checkScript = scripts.check ?? "";
    expect(hasArchitectureCheckSteps(checkScript)).toBe(true);
    expect(
      hasArchitectureCheckSteps(
        "pnpm lint && pnpm typecheck && pnpm architecture && pnpm --filter @arbor/web test",
      ),
    ).toBe(false);
    expect(
      hasArchitectureCheckSteps(
        "pnpm lint && pnpm typecheck && pnpm test && pnpm architecture",
      ),
    ).toBe(false);

    const architectureScript = scripts.architecture ?? "";
    const architectureConfigPath =
      parseArchitectureConfigArgument(architectureScript);
    expect(architectureConfigPath).toBeDefined();
    if (architectureConfigPath === undefined)
      throw new Error(
        "architecture script must start with Vitest run and one --config",
      );

    expect(
      parseArchitectureConfigArgument(
        "vitest run --config vitest.architecture.config.ts",
      ),
    ).toBe("vitest.architecture.config.ts");
    expect(
      parseArchitectureConfigArgument(
        "pnpm exec vitest run --config vitest.architecture.config.ts",
      ),
    ).toBe("vitest.architecture.config.ts");
    expect(
      parseArchitectureConfigArgument(
        "echo vitest run --config vitest.architecture.config.ts",
      ),
    ).toBeUndefined();
    expect(
      parseArchitectureConfigArgument(
        "pnpm install && vitest run --config vitest.architecture.config.ts",
      ),
    ).toBeUndefined();
    expect(
      parseArchitectureConfigArgument(
        "vitest run --config one.config.ts --config two.config.ts",
      ),
    ).toBeUndefined();
    expect(
      parseArchitectureConfigArgument("vitest run --config --help"),
    ).toBeUndefined();
    expect(
      parseArchitectureConfigArgument(
        "vitest run --config vitest.architecture.config.ts; echo bad",
      ),
    ).toBeUndefined();

    const resolvedArchitectureConfig = resolve(
      REPO_ROOT,
      architectureConfigPath,
    );
    expect(existsSync(resolvedArchitectureConfig)).toBe(true);
    expect(resolvesToRepositoryFile(REPO_ROOT, architectureConfigPath)).toBe(
      true,
    );
    const realArchitectureConfig = realpathSync(resolvedArchitectureConfig);
    const [globs] = parseArchitectureConfigFiles([realArchitectureConfig]);
    expect(globs).toBeDefined();
    if (globs === undefined)
      throw new Error(
        "architecture config must expose static include/exclude arrays",
      );

    const architectureTestFiles = enumerateTestFilesRecursively(
      join(REPO_ROOT, "tests", "architecture"),
      "tests/architecture",
    );
    expect(architectureTestFiles.length).toBeGreaterThan(0);
    expect(
      isCoveredByVitestGlobs(
        globs.include,
        globs.exclude,
        architectureTestFiles,
      ),
    ).toBe(true);

    const nestedRoot = mkdtempSync(join(tmpdir(), "arbor-p9-arch-nested-"));
    try {
      const nestedDirectory = join(nestedRoot, "nested");
      mkdirSync(nestedDirectory);
      writeFileSync(join(nestedDirectory, "nested.test.ts"), "", "utf8");
      const nestedTestFiles = enumerateTestFilesRecursively(
        nestedRoot,
        "tests/architecture",
      );
      expect(nestedTestFiles).toEqual([
        "tests/architecture/nested/nested.test.ts",
      ]);
      expect(
        isCoveredByVitestGlobs(globs.include, globs.exclude, nestedTestFiles),
      ).toBe(true);
      expect(
        isCoveredByVitestGlobs(
          globs.include,
          ["tests/architecture/**/*.test.ts"],
          nestedTestFiles,
        ),
      ).toBe(false);
    } finally {
      rmSync(nestedRoot, { recursive: true, force: true });
    }

    const configSource = (testOptions: string) =>
      `export default defineConfig({ test: { ${testOptions} } });`;
    const invalidConfigSources: ReadonlyArray<readonly [string, string]> = [
      [
        "comment-only",
        configSource('// include: ["tests/architecture/**/*.test.ts"]\n'),
      ],
      ["dynamic-include", configSource("include: getArchitectureIncludes()")],
      [
        "spread",
        configSource('...shared, include: ["tests/architecture/**/*.test.ts"]'),
      ],
      [
        "computed-key",
        configSource('["include"]: ["tests/architecture/**/*.test.ts"]'),
      ],
      [
        "duplicate-include",
        configSource(
          'include: ["tests/architecture/**/*.test.ts"], include: ["tests/**/*.test.ts"]',
        ),
      ],
      [
        "dynamic-exclude",
        configSource(
          'include: ["tests/architecture/**/*.test.ts"], exclude: getExcludes()',
        ),
      ],
      [
        "wrong-define-config-module",
        'import { defineConfig } from "./wrapper";\nexport default defineConfig({ test: { include: ["tests/architecture/**/*.test.ts"] } });',
      ],
      [
        "aliased-define-config-import",
        'import { defineConfig as configure } from "vitest/config";\nexport default configure({ test: { include: ["tests/architecture/**/*.test.ts"] } });',
      ],
      [
        "duplicate-imports",
        'import { defineConfig } from "vitest/config";\nimport { defineConfig as configure } from "vitest/config";\nexport default defineConfig({ test: { include: ["tests/architecture/**/*.test.ts"] } });',
      ],
      [
        "local-define-config-wrapper",
        'const defineConfig = (config: unknown) => config;\nexport default defineConfig({ test: { include: ["tests/architecture/**/*.test.ts"] } });',
      ],
      [
        "shadowed-define-config-import",
        'import { defineConfig } from "vitest/config";\nconst defineConfig = (config: unknown) => config;\nexport default defineConfig({ test: { include: ["tests/architecture/**/*.test.ts"] } });',
      ],
    ];
    const invalidConfigRoot = mkdtempSync(
      join(tmpdir(), "arbor-p9-invalid-architecture-config-"),
    );
    try {
      const invalidConfigPaths = invalidConfigSources.map(([name, source]) => {
        const path = join(invalidConfigRoot, `${name}.config.ts`);
        writeFileSync(path, source, "utf8");
        return path;
      });
      const invalidConfigResults =
        parseArchitectureConfigFiles(invalidConfigPaths);
      expect(invalidConfigResults).toHaveLength(invalidConfigSources.length);
      expect(invalidConfigResults.every((result) => result === undefined)).toBe(
        true,
      );
    } finally {
      rmSync(invalidConfigRoot, { recursive: true, force: true });
    }
    // The escape fixture must live outside the repository. CI exports
    // TMPDIR inside the workspace ($GITHUB_WORKSPACE/.ci-tmp), so tmpdir()
    // alone cannot guarantee that; fall back to the repository's parent.
    const surelyOutsideDirectory = (() => {
      const temporary = realpathSync(tmpdir());
      const relation = relative(realpathSync(REPO_ROOT), temporary);
      return relation === "" ||
        relation === ".." ||
        relation.startsWith(`..${sep}`)
        ? temporary
        : dirname(REPO_ROOT);
    })();
    const outsideRoot = mkdtempSync(
      join(surelyOutsideDirectory, "arbor-p9-architecture-config-escape-"),
    );
    try {
      const outsideConfigPath = join(outsideRoot, "vitest.config.ts");
      writeFileSync(outsideConfigPath, "", "utf8");
      expect(existsSync(outsideConfigPath)).toBe(true);
      expect(resolvesToRepositoryFile(REPO_ROOT, outsideConfigPath)).toBe(
        false,
      );
      const escapedPath = relative(REPO_ROOT, outsideConfigPath)
        .split(sep)
        .join("/");
      expect(
        parseArchitectureConfigArgument(`vitest run --config ${escapedPath}`),
      ).toBe(escapedPath);
      expect(resolvesToRepositoryFile(REPO_ROOT, escapedPath)).toBe(false);
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }

    const firstOwnedFile = durableFile("cleanup-first");
    const secondOwnedFile = durableFile("cleanup-second");
    expect(runOwnedDurableRoots.size).toBe(2);
    cleanupRunOwnedDurableRoots();
    expect(existsSync(dirname(firstOwnedFile))).toBe(false);
    expect(existsSync(dirname(secondOwnedFile))).toBe(false);
    expect(runOwnedDurableRoots.size).toBe(0);
    expect(() => cleanupRunOwnedDurableRoots()).not.toThrow();

    const prefixSpoofRoot = mkdtempSync(
      join(tmpdir(), `${P9_DURABLE_TEMP_PREFIX}not-owned-`),
    );
    try {
      const realSpoofRoot = realpathSync(prefixSpoofRoot);
      expect(() => validateRunOwnedDurableRoot(realSpoofRoot)).toThrow(
        "refusing to remove an unregistered P9 temp root",
      );
      expect(existsSync(realSpoofRoot)).toBe(true);
    } finally {
      rmSync(prefixSpoofRoot, { recursive: true, force: false });
    }

    const containmentSandbox = mkdtempSync(
      join(tmpdir(), "arbor-p9-temp-containment-sandbox-"),
    );
    const validSandboxRoot = mkdtempSync(
      join(containmentSandbox, `${P9_DURABLE_TEMP_PREFIX}valid-`),
    );
    const wrongPrefixRoot = mkdtempSync(
      join(containmentSandbox, "arbor-p9-not-accepted-"),
    );
    const siblingRoot = mkdtempSync(
      join(tmpdir(), `${P9_DURABLE_TEMP_PREFIX}outside-sandbox-`),
    );
    try {
      const realSandbox = realpathSync(containmentSandbox);
      const realValidRoot = realpathSync(validSandboxRoot);
      const realWrongPrefixRoot = realpathSync(wrongPrefixRoot);
      const realSiblingRoot = realpathSync(siblingRoot);
      expect(isSafeP9TempRootPath(realValidRoot, realSandbox)).toBe(true);
      expect(isSafeP9TempRootPath(realWrongPrefixRoot, realSandbox)).toBe(
        false,
      );
      expect(isSafeP9TempRootPath(realSiblingRoot, realSandbox)).toBe(false);

      runOwnedDurableRoots.add(realWrongPrefixRoot);
      expect(() => validateRunOwnedDurableRoot(realWrongPrefixRoot)).toThrow(
        "refusing to remove a P9 temp root with an unexpected name",
      );
      expect(() => cleanupRunOwnedDurableRoots()).toThrow(
        "Failed to clean P9-owned SQLite temp roots",
      );
      expect(existsSync(realWrongPrefixRoot)).toBe(true);
    } finally {
      runOwnedDurableRoots.delete(realpathSync(wrongPrefixRoot));
      rmSync(containmentSandbox, { recursive: true, force: false });
      rmSync(siblingRoot, { recursive: true, force: false });
    }

    const tempCheckoutParent = mkdtempSync(
      join(tmpdir(), "arbor-p9-checkout-under-temp-"),
    );
    const syntheticRepositoryRoot = join(tempCheckoutParent, "checkout");
    mkdirSync(syntheticRepositoryRoot);
    const checkoutOwnedRoot = mkdtempSync(
      join(syntheticRepositoryRoot, `${P9_DURABLE_TEMP_PREFIX}checkout-`),
    );
    const realCheckoutOwnedRoot = realpathSync(checkoutOwnedRoot);
    runOwnedDurableRoots.add(realCheckoutOwnedRoot);
    try {
      expect(validateRunOwnedDurableRoot(realCheckoutOwnedRoot)).toBe(
        realCheckoutOwnedRoot,
      );
      cleanupRunOwnedDurableRoots();
      expect(existsSync(realCheckoutOwnedRoot)).toBe(false);
    } finally {
      runOwnedDurableRoots.delete(realCheckoutOwnedRoot);
      rmSync(tempCheckoutParent, { recursive: true, force: false });
    }

    expect(scripts.test).toBe("node scripts/testing/run-core-tests.mjs");
    const coreRunnerSource = readFileSync(
      join(REPO_ROOT, "scripts", "testing", "run-core-tests.mjs"),
      "utf8",
    );
    expect(coreRunnerSource).toMatch(/require\.resolve\("vitest"\)/);
    expect(coreRunnerSource).toMatch(
      /const listing = run\(process\.execPath,\s*\[cliPath,\s*"list",\s*"--filesOnly"\]/,
    );
    expect(coreRunnerSource).toMatch(
      /\[\s*cliPath,\s*"run",\s*\.\.\.batch,[\s\S]*?"--maxWorkers=1",\s*"--no-file-parallelism",\s*"--retry=0",?\s*\]/,
    );
  });

  it.fails("cleans run-owned SQLite roots after the test body throws", () => {
    const filename = durableFile("expected-throw");
    expectedThrowCleanupRoots.add(dirname(filename));
    throw new Error("synthetic expected P9 test failure");
  });
});
