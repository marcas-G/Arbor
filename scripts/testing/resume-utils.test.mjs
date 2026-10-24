import assert from "node:assert/strict";
import test from "node:test";
import {
  buildResumePlan,
  collectPreviouslyPassedFiles,
  qualifiesCompleteCoverage,
} from "./resume-utils.mjs";

const selectedFiles = [
  "tests/a.test.ts",
  "tests/b.test.ts",
  "tests/ui.spec.ts",
];
const groupFiles = {
  functionalVitest: selectedFiles.slice(0, 2),
  functionalUi: selectedFiles.slice(2),
};
const previousResult = {
  profile: "release",
  manifestSha256: "manifest",
  gitSha: "base",
  gitDirty: false,
  groups: [
    { name: "build", exitCode: 0 },
    { name: "functionalVitest", exitCode: 1 },
  ],
};
const previousVitestProgress = {
  files: [
    { relativeFile: "tests/a.test.ts", status: "passed" },
    { relativeFile: "tests/b.test.ts", status: "failed" },
  ],
};

test("resume inherits passed files and reruns failed or unrun files", () => {
  const plan = buildResumePlan({
    profileName: "release",
    manifestSha256: "manifest",
    selectedFiles,
    groupFiles,
    previousResult,
    previousVitestProgress,
    changedPaths: [],
    currentGitDirty: false,
  });
  assert.equal(plan.compatible, true);
  assert.deepEqual(plan.inheritedFiles, ["tests/a.test.ts"]);
  assert.deepEqual(plan.executionFiles, [
    "tests/b.test.ts",
    "tests/ui.spec.ts",
  ]);
  assert.equal(plan.inheritBuild, true);
});

test("a changed direct test invalidates only that test evidence", () => {
  const prior = {
    ...previousResult,
    passedFiles: ["tests/a.test.ts", "tests/b.test.ts"],
  };
  const plan = buildResumePlan({
    profileName: "release",
    manifestSha256: "manifest",
    selectedFiles,
    groupFiles,
    previousResult: prior,
    previousVitestProgress: null,
    changedPaths: ["tests/b.test.ts"],
    currentGitDirty: false,
  });
  assert.equal(plan.compatible, true);
  assert.deepEqual(plan.inheritedFiles, ["tests/a.test.ts"]);
  assert.deepEqual(plan.invalidatedFiles, ["tests/b.test.ts"]);
  assert.deepEqual(plan.executionFiles, [
    "tests/b.test.ts",
    "tests/ui.spec.ts",
  ]);
});

test("shared source, config, or support changes fail closed to a full run", () => {
  for (const changedPath of [
    "packages/runtime/src/agent.ts",
    "tests/support/daemon.ts",
    "vitest.functional.config.ts",
  ]) {
    const plan = buildResumePlan({
      profileName: "release",
      manifestSha256: "manifest",
      selectedFiles,
      groupFiles,
      previousResult,
      previousVitestProgress,
      changedPaths: [changedPath],
      currentGitDirty: false,
    });
    assert.equal(plan.compatible, false, changedPath);
    assert.deepEqual(plan.executionFiles, selectedFiles);
  }
});

test("audited resume-runner changes do not invalidate runtime test evidence", () => {
  const plan = buildResumePlan({
    profileName: "release",
    manifestSha256: "manifest",
    selectedFiles,
    groupFiles,
    previousResult,
    previousVitestProgress,
    changedPaths: [
      "scripts/testing/run-suite.mjs",
      "scripts/testing/resume-utils.mjs",
      "scripts/testing/resume-utils.test.mjs",
      "scripts/testing/runner-utils.test.mjs",
      "planning/testing/README.md",
    ],
    currentGitDirty: false,
  });
  assert.equal(plan.compatible, true);
  assert.deepEqual(plan.inheritedFiles, ["tests/a.test.ts"]);
  assert.equal(plan.ignoredOrchestrationChanges.length, 5);
});

test("dirty trees and incompatible manifests never inherit evidence", () => {
  for (const override of [
    { currentGitDirty: true },
    { previousResult: { ...previousResult, gitDirty: true } },
    { manifestSha256: "new-manifest" },
  ]) {
    const plan = buildResumePlan({
      profileName: "release",
      manifestSha256: "manifest",
      selectedFiles,
      groupFiles,
      previousResult,
      previousVitestProgress,
      changedPaths: [],
      currentGitDirty: false,
      ...override,
    });
    assert.equal(plan.compatible, false);
    assert.deepEqual(plan.inheritedFiles, []);
  }
});

test("a fully successful Playwright group is inherited only as a whole", () => {
  const passed = collectPreviouslyPassedFiles({
    previousResult: {
      ...previousResult,
      groups: [...previousResult.groups, { name: "functionalUi", exitCode: 0 }],
    },
    previousVitestProgress,
    selectedFiles,
    groupFiles,
  });
  assert.deepEqual(passed, ["tests/a.test.ts", "tests/ui.spec.ts"]);
});

test("composite evidence claims completeness only with every file and a build", () => {
  const base = {
    status: "passed",
    profileCompleteCoverage: true,
    selectedFiles,
    passedFiles: selectedFiles,
    buildRequired: true,
    inheritedBuild: true,
    groups: [],
  };
  assert.equal(qualifiesCompleteCoverage(base), true);
  assert.equal(
    qualifiesCompleteCoverage({
      ...base,
      passedFiles: selectedFiles.slice(0, 2),
    }),
    false,
  );
  assert.equal(
    qualifiesCompleteCoverage({ ...base, inheritedBuild: false }),
    false,
  );
  assert.equal(
    qualifiesCompleteCoverage({
      ...base,
      inheritedBuild: false,
      groups: [{ name: "build", exitCode: 0 }],
    }),
    true,
  );
  assert.equal(qualifiesCompleteCoverage({ ...base, status: "failed" }), false);
});
