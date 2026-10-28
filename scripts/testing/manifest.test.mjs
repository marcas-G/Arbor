import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  findCoreFunctionalOverlap,
  globToRegExp,
  validateManifest,
  validateRepoRelativePath,
} from "./check-manifest.mjs";
import { planTestImpact } from "./plan-test-impact.mjs";

const manifest = JSON.parse(
  readFileSync(
    new URL("../../planning/testing/manifest.json", import.meta.url),
    "utf8",
  ),
);

test("checked-in profile inventory matches the configured functional suites", () => {
  const result = validateManifest(manifest);
  assert.equal(result.ok, true, result.errors?.join("\n"));
  assert.equal(result.functionalVitestFiles, 69);
  assert.equal(result.functionalUiFiles, 6);
});

test("validator rejects missing files and duplicates within a profile group", () => {
  const invalid = structuredClone(manifest);
  invalid.groups.quick.push(invalid.groups.quick[0]);
  invalid.groups.smoke.push(
    "tests/functional/process/missing.functional.test.ts",
  );
  const result = validateManifest(invalid);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.includes("contains duplicate path")),
  );
  assert.ok(
    result.errors.some((error) => error.includes("contains an invalid path")),
  );
});

test("manifest paths must be POSIX repository-relative file paths", () => {
  for (const path of [
    "",
    "/outside/package.json",
    "C:/Arbor/package.json",
    "C:\\Arbor\\package.json",
    "tests/D:outside/package.json",
    "\\\\server\\share\\package.json",
    "..\\Arbor\\package.json",
    "tests/../package.json",
    "tests//package.json",
    "tests/./package.json",
  ]) {
    assert.notEqual(validateRepoRelativePath(path), null, path);
    const invalid = structuredClone(manifest);
    invalid.groups.quick[0] = path;
    const result = validateManifest(invalid);
    assert.equal(result.ok, false, path);
    assert.ok(
      result.errors.some((error) => error.includes("contains an invalid path")),
      path,
    );
  }
});

test("glob parser accepts only the documented wildcard subset", () => {
  assert.equal(
    globToRegExp("tests/functional/process/**/*.functional.test.ts").test(
      "tests/functional/process/agent.functional.test.ts",
    ),
    true,
  );
  assert.equal(
    globToRegExp("tests/functional/process/**/*.functional.test.ts").test(
      "tests/functional/process/nested/agent.functional.test.ts",
    ),
    true,
  );
  assert.equal(
    globToRegExp("tests/case?.test.ts").test("tests/case1.test.ts"),
    true,
  );
  assert.equal(
    globToRegExp("tests/case?.test.ts").test("tests/case12.test.ts"),
    false,
  );
  for (const pattern of [
    "!tests/**/*.test.ts",
    "tests/[ab]/**/*.test.ts",
    "tests/{functional,core}/**/*.test.ts",
    "tests/@(functional|core)/**/*.test.ts",
    "tests/!(pending)/**/*.test.ts",
  ]) {
    assert.throws(
      () => globToRegExp(pattern),
      /unsupported glob syntax/,
      pattern,
    );
  }
});

test("release completeness requires the full Vitest and browser sets", () => {
  const invalid = structuredClone(manifest);
  invalid.profiles.release.groups = ["functionalVitest"];
  const result = validateManifest(invalid);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) =>
      error.includes("must require complete functional Vitest and UI groups"),
    ),
  );
});

test("core and functional Vitest inventories must not overlap", () => {
  const overlap = findCoreFunctionalOverlap({
    repositoryFiles: [
      "tests/capability/black-box/s1-s4-public-api.test.ts",
      "tests/functional/process/example.functional.test.ts",
    ],
    coreIncludes: ["tests/**/*.test.ts"],
    coreExcludes: ["tests/functional/**"],
    functionalFiles: [
      "tests/capability/black-box/s1-s4-public-api.test.ts",
      "tests/functional/process/example.functional.test.ts",
    ],
  });
  assert.deepEqual(overlap, [
    "tests/capability/black-box/s1-s4-public-api.test.ts",
  ]);
});

test("impact planner selects only the UI lane for a known Web change", () => {
  const plan = planTestImpact(["apps/web/src/pages/work.tsx"]);
  assert.deepEqual(plan.selectedLanes, ["ui"]);
  assert.equal(plan.lanes.ui.scope, "selected-lane");
  assert.equal(plan.completeCoverage, false);
});

test("shared runtime changes escalate core and process to full lanes", () => {
  const plan = planTestImpact([
    "packages/agent-runtime/src/agent-loop-driver.ts",
  ]);
  assert.deepEqual(plan.selectedLanes, ["core", "process"]);
  assert.ok(plan.highRiskTags.includes("shared-runtime"));
  assert.equal(plan.lanes.core.scope, "full-lane");
  assert.equal(plan.lanes.process.scope, "full-lane");
  assert.equal(plan.completeCoverage, false);
});

test("unknown paths conservatively select every lane and explain why", () => {
  const plan = planTestImpact(["vendor/generated/opaque-output.bin"]);
  assert.equal(plan.mode, "conservative-unknown");
  assert.deepEqual(plan.selectedLanes, [
    "quick",
    "core",
    "process",
    "ui",
    "provider",
    "package",
  ]);
  assert.ok(
    plan.lanes.provider.reasons.some((reason) =>
      reason.includes("unknown path"),
    ),
  );
  assert.equal(plan.completeCoverage, false);
});

test("provider-facing changes keep real-provider qualification explicit", () => {
  const plan = planTestImpact(["adapters/provider-openai/src/client.ts"]);
  assert.ok(plan.selectedLanes.includes("provider"));
  assert.match(plan.realProviderL3, /not-run/);
  assert.equal(plan.completeCoverage, false);
});

test("schema and permission labels escalate their owning lanes", () => {
  const schema = planTestImpact([
    "adapters/persistence-sqlite/src/migrations/0052.ts",
  ]);
  assert.ok(schema.highRiskTags.includes("schema"));
  assert.equal(schema.lanes.package.scope, "full-lane");
  assert.equal(schema.lanes.process.scope, "full-lane");

  const permission = planTestImpact([
    "packages/agent-runtime/src/permission-policy.ts",
  ]);
  assert.ok(permission.highRiskTags.includes("permissions"));
  assert.equal(permission.lanes.ui.scope, "full-lane");
});
