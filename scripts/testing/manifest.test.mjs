import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  findCoreFunctionalOverlap,
  validateManifest,
} from "./check-manifest.mjs";

const manifest = JSON.parse(
  readFileSync(
    new URL("../../planning/testing/manifest.json", import.meta.url),
    "utf8",
  ),
);

test("checked-in profile inventory matches the configured functional suites", () => {
  const result = validateManifest(manifest);
  assert.equal(result.ok, true, result.errors?.join("\n"));
  assert.equal(result.functionalVitestFiles, 48);
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
    result.errors.some((error) =>
      error.includes("manifest path does not exist"),
    ),
  );
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
