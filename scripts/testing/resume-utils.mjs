const normalized = (path) => String(path).replaceAll("\\", "/");

const successfulGroup = (result, name) =>
  (result.groups ?? []).some(
    (group) => group.name === name && group.exitCode === 0,
  );

const resumeOrchestrationPaths = new Set([
  "scripts/testing/run-suite.mjs",
  "scripts/testing/resume-utils.mjs",
  "scripts/testing/resume-utils.test.mjs",
  "scripts/testing/runner-startup.test.mjs",
  "scripts/testing/runner-utils.test.mjs",
  "planning/testing/README.md",
]);

const additiveManifestPaths = new Set([
  "planning/testing/manifest.json",
  "scripts/testing/check-manifest.mjs",
  "scripts/testing/manifest.test.mjs",
]);

const isDirectTestFile = (path) =>
  path.startsWith("tests/") &&
  (path.endsWith(".test.ts") || path.endsWith(".spec.ts"));

const isNonExecutablePlanningMarkdown = (path) =>
  path.startsWith("planning/") && path.endsWith(".md");

export function analyzeSelectedFileCompatibility({
  previousSelectedFiles,
  selectedFiles,
  manifestMatches,
}) {
  const previous = (previousSelectedFiles ?? []).map(normalized);
  const current = selectedFiles.map(normalized);
  const incompatible = (reason) => ({
    compatible: false,
    reason,
    mode: "incompatible",
    addedFiles: [],
  });

  if (previous.length === 0) return incompatible("missing-base-selected-files");
  if (new Set(previous).size !== previous.length)
    return incompatible("duplicate-base-selected-files");
  if (new Set(current).size !== current.length)
    return incompatible("duplicate-current-selected-files");

  let previousCursor = 0;
  for (const path of current) {
    if (path === previous[previousCursor]) previousCursor += 1;
  }
  if (previousCursor !== previous.length)
    return incompatible("selected-files-removed-or-reordered");

  const previousSet = new Set(previous);
  const addedFiles = current.filter((path) => !previousSet.has(path));
  if (manifestMatches && addedFiles.length > 0)
    return incompatible("selected-files-changed-without-manifest-change");
  if (!manifestMatches && addedFiles.length === 0)
    return incompatible("manifest-changed-without-added-tests");
  if (!addedFiles.every(isDirectTestFile))
    return incompatible("manifest-added-non-test-file");

  return {
    compatible: true,
    reason: manifestMatches ? "exact-manifest" : "additive-manifest",
    mode: manifestMatches ? "exact" : "additive",
    addedFiles,
  };
}

export function collectPreviouslyPassedFiles({
  previousResult,
  previousVitestProgress,
  selectedFiles,
  groupFiles,
}) {
  const selected = new Set(selectedFiles.map(normalized));
  const previouslySelected = new Set(
    (previousResult.selectedFiles ?? []).map(normalized),
  );
  const passed = new Set(
    (previousResult.passedFiles ?? [])
      .map(normalized)
      .filter((path) => selected.has(path)),
  );

  for (const file of previousVitestProgress?.files ?? []) {
    const path = normalized(file.relativeFile ?? file.file);
    if (file.status === "passed" && selected.has(path)) passed.add(path);
  }

  // Playwright has no per-file checkpoint reporter. A successful group is the
  // only safe evidence for inheriting its complete file set.
  for (const [groupName, files] of Object.entries(groupFiles)) {
    if (!successfulGroup(previousResult, groupName)) continue;
    for (const file of files) {
      const path = normalized(file);
      if (selected.has(path) && previouslySelected.has(path)) passed.add(path);
    }
  }
  return [...passed].sort();
}

export function buildResumePlan({
  profileName,
  manifestSha256,
  selectedFiles,
  groupFiles,
  previousResult,
  previousVitestProgress,
  changedPaths,
  currentGitDirty,
}) {
  const incompatible = (reason) => ({
    compatible: false,
    reason,
    inheritedFiles: [],
    invalidatedFiles: [],
    executionFiles: [...selectedFiles],
    inheritBuild: false,
    ignoredOrchestrationChanges: [],
    ignoredNonExecutableChanges: [],
    promotedPendingPaths: [],
    manifestMode: "incompatible",
    addedFiles: [],
  });

  if (!previousResult || previousResult.profile !== profileName)
    return incompatible("profile-mismatch");
  if (previousResult.status === "running")
    return incompatible("base-run-still-running");
  if (!previousResult.gitSha) return incompatible("missing-base-git-sha");
  if (previousResult.gitDirty === true || currentGitDirty === true)
    return incompatible("dirty-tree");

  const selected = new Set(selectedFiles.map(normalized));
  const changed = [...new Set(changedPaths.map(normalized))];
  const changedSet = new Set(changed);
  const selection = analyzeSelectedFileCompatibility({
    previousSelectedFiles: previousResult.selectedFiles,
    selectedFiles,
    manifestMatches: previousResult.manifestSha256 === manifestSha256,
  });
  if (!selection.compatible) return incompatible(selection.reason);
  if (
    selection.mode === "additive" &&
    (!changedSet.has("planning/testing/manifest.json") ||
      !selection.addedFiles.every((path) => changedSet.has(path)))
  ) {
    return incompatible("additive-manifest-diff-incomplete");
  }
  const ignoredOrchestrationChanges = changed.filter((path) =>
    resumeOrchestrationPaths.has(path),
  );
  const promotedPendingPaths = new Set(
    selection.addedFiles
      .filter((path) => path.startsWith("tests/functional/process/"))
      .map((path) =>
        path.replace("tests/functional/process/", "tests/functional/pending/"),
      ),
  );
  const sharedChanges = changed.filter(
    (path) =>
      !selected.has(path) &&
      !resumeOrchestrationPaths.has(path) &&
      !isNonExecutablePlanningMarkdown(path) &&
      !promotedPendingPaths.has(path) &&
      !(selection.mode === "additive" && additiveManifestPaths.has(path)),
  );
  if (sharedChanges.length > 0)
    return incompatible(`shared-input-changed:${sharedChanges.join(",")}`);
  const ignoredNonExecutableChanges = changed.filter(
    isNonExecutablePlanningMarkdown,
  );

  const passed = collectPreviouslyPassedFiles({
    previousResult,
    previousVitestProgress,
    selectedFiles,
    groupFiles,
  });
  const inheritedFiles = passed.filter((path) => !changedSet.has(path));
  const inheritedSet = new Set(inheritedFiles);
  const executionFiles = selectedFiles.filter(
    (path) => !inheritedSet.has(normalized(path)),
  );

  return {
    compatible: true,
    reason: "compatible",
    inheritedFiles,
    invalidatedFiles: passed.filter((path) => changedSet.has(path)),
    executionFiles,
    inheritBuild: successfulGroup(previousResult, "build"),
    ignoredOrchestrationChanges,
    ignoredNonExecutableChanges,
    promotedPendingPaths: changed.filter((path) =>
      promotedPendingPaths.has(path),
    ),
    manifestMode: selection.mode,
    addedFiles: selection.addedFiles,
  };
}

export function qualifiesCompleteCoverage({
  status,
  profileCompleteCoverage,
  selectedFiles,
  passedFiles,
  buildRequired,
  inheritedBuild,
  groups,
}) {
  const passed = new Set(passedFiles.map(normalized));
  return (
    status === "passed" &&
    profileCompleteCoverage === true &&
    selectedFiles.every((file) => passed.has(normalized(file))) &&
    (!buildRequired || inheritedBuild || successfulGroup({ groups }, "build"))
  );
}
