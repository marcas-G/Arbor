export const ALLOWED_EDGES: Record<string, ReadonlyArray<string>> = {
  domain: [],
  ports: ["domain"],
  application: ["domain", "ports"],
  "model-context": ["domain", "ports"],
  "agent-runtime": ["domain", "ports", "application", "model-context"],
  "execution-runtime": ["domain", "ports", "application", "agent-runtime"],
  "verification-runtime": ["domain", "ports", "application"],
  "provider-runtime": ["ports"],
  "tool-runtime": ["domain", "ports"],
  "projection-runtime": ["domain", "ports"],
  "api-contracts": ["domain"],
  testkit: ["domain", "ports", "application"],
  "persistence-sqlite": ["domain", "ports"],
  "environment-local": ["domain", "ports"],
  "worker-local": ["domain", "ports"],
  "provider-fake": ["domain", "ports"],
  "sandbox-local": ["domain", "ports"],
  "blob-local": ["domain", "ports"],
};

export interface PackageManifest {
  readonly name: string;
  readonly internalDependencies: ReadonlyArray<string>;
}

export const checkEdges = (
  packages: ReadonlyArray<PackageManifest>,
  allowed: Record<string, ReadonlyArray<string>> = ALLOWED_EDGES,
): ReadonlyArray<string> => {
  const violations: string[] = [];
  for (const pkg of packages) {
    const allowedDeps = allowed[pkg.name];
    if (allowedDeps === undefined) {
      violations.push(`unknown package: ${pkg.name}`);
      continue;
    }
    for (const dependency of pkg.internalDependencies) {
      if (dependency.includes("/")) {
        violations.push(`deep import: ${pkg.name} -> ${dependency}`);
        continue;
      }
      if (!allowedDeps.includes(dependency)) {
        violations.push(`forbidden edge: ${pkg.name} -> ${dependency}`);
      }
    }
  }
  return violations;
};

const ALLOWED_DOMAIN_SPECIFIERS = /^(\.\/|\.\.\/|effect$|node:)/;

export const checkDomainImports = (
  files: ReadonlyArray<{ readonly path: string; readonly source: string }>,
): ReadonlyArray<string> => {
  const violations: string[] = [];
  const importRe = /from\s+"([^"]+)"/g;
  for (const file of files) {
    for (const match of file.source.matchAll(importRe)) {
      const specifier = match[1] ?? "";
      if (!ALLOWED_DOMAIN_SPECIFIERS.test(specifier)) {
        violations.push(`${file.path}: forbidden import "${specifier}"`);
      }
    }
  }
  return violations;
};

const FORBIDDEN_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly label: string;
}> = [
  { pattern: /\bEffect\.catchAll\s*\(/, label: "catch-all error handling" },
  {
    pattern: /\bEffect\.catchAllCause\s*\(/,
    label: "catch-all cause handling",
  },
  { pattern: /\bContext\.unsafeGet\b/, label: "service locator" },
];

export const checkForbiddenPatterns = (
  files: ReadonlyArray<{ readonly path: string; readonly source: string }>,
): ReadonlyArray<string> => {
  const violations: string[] = [];
  for (const file of files) {
    for (const { pattern, label } of FORBIDDEN_PATTERNS) {
      if (pattern.test(file.source)) {
        violations.push(`${file.path}: forbidden ${label}`);
      }
    }
  }
  return violations;
};
