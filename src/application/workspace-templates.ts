export function renderWorkspaceYaml(p: {
  readonly projectId: string;
  readonly workspaceId: string;
}): string {
  return [
    "schemaVersion: 1",
    `projectId: "${p.projectId}"`,
    `workspaceId: "${p.workspaceId}"`,
    "resources:",
    "  writable:",
    '    - "."',
    "verification:",
    "  local:",
    "    commands: []",
    "",
  ].join("\n");
}

export function renderWorkspaceMd(): string {
  return [
    "# Root Workspace",
    "",
    "## Intent",
    "",
    "TBD (user to fill)",
    "",
    "## Responsibility",
    "",
    "TBD (user to fill)",
    "",
    "## Expected Deliverables",
    "",
    "TBD (user to fill)",
    "",
    "## Inherited Constraints",
    "",
    "(none — Root workspace)",
    "",
  ].join("\n");
}

export function renderSummaryMd(): string {
  return "# Summary\n\nBootstrap skeleton. Derived view; not the highest-authority source.\n";
}

export function renderOverviewMd(): string {
  return "# Design Overview\n\nTBD (user to fill)\n";
}

export function renderVerificationMd(): string {
  return "# Verification Design\n\nDescribes properties to be proven. No formal test cases here.\n";
}
