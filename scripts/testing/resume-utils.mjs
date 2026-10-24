const normalized = (path) => String(path).replaceAll("\\", "/");

const successfulGroup = (result, name) =>
  (result.groups ?? []).some(
    (group) => group.name === name && group.exitCode === 0,
  );

const resumeOrchestrationPaths = new Set([
  "scripts/testing/run-suite.mjs",
  "scripts/testing/resume-utils.mjs",
  "scripts/testing/resume-utils.test.mjs",
  "scripts/testing/runner-utils.test.mjs",
  "planning/testing/README.md",
]);

export function collectPreviouslyPassedFiles({
  previousResult,
  previousVitestProgress,
  selectedFiles,
  groupFiles,
}) {
  const selected = new Set(selectedFiles.map(normalized));
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
      if (selected.has(path)) passed.add(path);
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
  });

  if (!previousResult || previousResult.profile !== profileName)
    return incompatible("profile-mismatch");
  if (previousResult.status === "running")
    return incompatible("base-run-still-running");
  if (previousResult.manifestSha256 !== manifestSha256)
    return incompatible("manifest-mismatch");
  if (!previousResult.gitSha) return incompatible("missing-base-git-sha");
  if (previousResult.gitDirty === true || currentGitDirty === true)
    return incompatible("dirty-tree");

  const selected = new Set(selectedFiles.map(normalized));
  const changed = [...new Set(changedPaths.map(normalized))];
  const ignoredOrchestrationChanges = changed.filter((path) =>
    resumeOrchestrationPaths.has(path),
  );
  const sharedChanges = changed.filter(
    (path) => !selected.has(path) && !resumeOrchestrationPaths.has(path),
  );
  if (sharedChanges.length > 0)
    return incompatible(`shared-input-changed:${sharedChanges.join(",")}`);

  const passed = collectPreviouslyPassedFiles({
    previousResult,
    previousVitestProgress,
    selectedFiles,
    groupFiles,
  });
  const changedSet = new Set(changed);
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
