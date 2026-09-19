export type CoverageStatus = "COVERED" | "UNCOVERED";

export interface CoverageEntry {
  readonly id: string;
  readonly kind: "transition" | "criterion";
  readonly owningTask: string;
  readonly testRef: string;
  readonly status: CoverageStatus;
}

export const KNOWN_SUITES = [
  "ids.test.ts",
  "ordinals.test.ts",
  "errors.test.ts",
  "project.test.ts",
  "resources.test.ts",
  "session.test.ts",
  "verification.test.ts",
  "dependency.test.ts",
  "command.test.ts",
  "events.test.ts",
  "authority.test.ts",
  "execution.test.ts",
  "workspace.test.ts",
  "work.test.ts",
  "invariants.test.ts",
] as const;

const transition = (
  id: string,
  owningTask: string,
  testRef: string,
): CoverageEntry => ({
  id,
  kind: "transition",
  owningTask,
  testRef,
  status: "COVERED",
});

const criterion = (
  n: number,
  owningTask: string,
  testRef: string,
): CoverageEntry => ({
  id: `criterion.${n}`,
  kind: "criterion",
  owningTask,
  testRef,
  status: "COVERED",
});

export const REQUIRED_IDS: ReadonlyArray<string> = [
  "project.create",
  "project.updatePolicy",
  "project.close",
  "project.closedTerminal",
  "workspace.createChild",
  "workspace.changeResponsibility",
  "workspace.updateResourceBoundary",
  "workspace.updateWorkspacePolicy",
  "workspace.selectCurrentWork",
  "workspace.replacePrimarySession",
  "workspace.retire",
  "workspace.forbiddenOps",
  "work.assign",
  "work.refine",
  "work.complete",
  "work.cancel",
  "work.terminal",
  "execution.admit",
  "execution.stop",
  "execution.settle",
  "execution.settledTerminal",
  "session.identityDurable",
  "session.entryAppendOnly",
  "session.epochMonotonic",
  "session.noBusinessLifecycle",
  "verification.start",
  "verification.recordEvidence",
  "verification.conclude",
  "verification.concludedTerminal",
  "dependency.declare",
  "dependency.revise",
  "dependency.satisfy",
  "dependency.withdraw",
  "dependency.unfulfillable",
  "dependency.terminal",
  "permission.grant",
  "permission.revoke",
  "permission.revokedTerminal",
  "immutable.deliverable",
  "immutable.acceptance",
  "immutable.concludedVerification",
  "immutable.terminalDependency",
  "immutable.domainEvent",
  "criterion.2",
  "criterion.3",
  "criterion.4",
  "criterion.5",
  "criterion.6",
  "criterion.7",
  "criterion.8",
  "criterion.9",
  "criterion.10",
  "criterion.11",
  "criterion.12",
  "criterion.13",
];

export const COVERAGE_MATRIX: ReadonlyArray<CoverageEntry> = [
  transition("project.create", "P0-005", "project.test.ts"),
  transition("project.updatePolicy", "P0-005", "project.test.ts"),
  transition("project.close", "P0-005", "project.test.ts"),
  transition("project.closedTerminal", "P0-005", "project.test.ts"),
  transition("workspace.createChild", "P0-006", "workspace.test.ts"),
  transition("workspace.changeResponsibility", "P0-006", "workspace.test.ts"),
  transition("workspace.updateResourceBoundary", "P0-006", "workspace.test.ts"),
  transition("workspace.updateWorkspacePolicy", "P0-006", "workspace.test.ts"),
  transition("workspace.selectCurrentWork", "P0-006", "workspace.test.ts"),
  transition("workspace.replacePrimarySession", "P0-006", "workspace.test.ts"),
  transition("workspace.retire", "P0-006", "invariants.test.ts"),
  transition("workspace.forbiddenOps", "P0-006", "workspace.test.ts"),
  transition("work.assign", "P0-008", "work.test.ts"),
  transition("work.refine", "P0-008", "work.test.ts"),
  transition("work.complete", "P0-008", "invariants.test.ts"),
  transition("work.cancel", "P0-008", "work.test.ts"),
  transition("work.terminal", "P0-008", "work.test.ts"),
  transition("execution.admit", "P0-009", "execution.test.ts"),
  transition("execution.stop", "P0-009", "execution.test.ts"),
  transition("execution.settle", "P0-009", "execution.test.ts"),
  transition("execution.settledTerminal", "P0-009", "execution.test.ts"),
  transition("session.identityDurable", "P0-010", "session.test.ts"),
  transition("session.entryAppendOnly", "P0-010", "session.test.ts"),
  transition("session.epochMonotonic", "P0-010", "session.test.ts"),
  transition("session.noBusinessLifecycle", "P0-010", "session.test.ts"),
  transition("verification.start", "P0-011", "verification.test.ts"),
  transition("verification.recordEvidence", "P0-011", "verification.test.ts"),
  transition("verification.conclude", "P0-011", "verification.test.ts"),
  transition(
    "verification.concludedTerminal",
    "P0-011",
    "verification.test.ts",
  ),
  transition("dependency.declare", "P0-012", "dependency.test.ts"),
  transition("dependency.revise", "P0-012", "dependency.test.ts"),
  transition("dependency.satisfy", "P0-012", "invariants.test.ts"),
  transition("dependency.withdraw", "P0-012", "invariants.test.ts"),
  transition("dependency.unfulfillable", "P0-012", "invariants.test.ts"),
  transition("dependency.terminal", "P0-012", "dependency.test.ts"),
  transition("permission.grant", "P0-015", "authority.test.ts"),
  transition("permission.revoke", "P0-015", "authority.test.ts"),
  transition("permission.revokedTerminal", "P0-015", "authority.test.ts"),
  transition("immutable.deliverable", "P0-012", "dependency.test.ts"),
  transition("immutable.acceptance", "P0-012", "dependency.test.ts"),
  transition(
    "immutable.concludedVerification",
    "P0-011",
    "verification.test.ts",
  ),
  transition("immutable.terminalDependency", "P0-012", "dependency.test.ts"),
  transition("immutable.domainEvent", "P0-014", "events.test.ts"),
  criterion(2, "P0-002", "ids.test.ts"),
  criterion(3, "P0-008", "invariants.test.ts"),
  criterion(4, "P0-008", "work.test.ts"),
  criterion(5, "P0-006", "workspace.test.ts"),
  criterion(6, "P0-006", "workspace.test.ts"),
  criterion(7, "P0-007", "resources.test.ts"),
  criterion(8, "P0-011", "verification.test.ts"),
  criterion(9, "P0-009", "execution.test.ts"),
  criterion(10, "P0-009", "execution.test.ts"),
  criterion(11, "P0-012", "dependency.test.ts"),
  criterion(12, "P0-013", "command.test.ts"),
  criterion(13, "P0-015", "authority.test.ts"),
];

export interface CoverageReport {
  readonly missing: ReadonlyArray<string>;
  readonly uncovered: ReadonlyArray<string>;
  readonly blankTestRef: ReadonlyArray<string>;
  readonly unknownTestRef: ReadonlyArray<string>;
  readonly ok: boolean;
}

export const checkCoverage = (
  matrix: ReadonlyArray<CoverageEntry>,
  required: ReadonlyArray<string>,
  knownSuites: ReadonlyArray<string> = KNOWN_SUITES,
): CoverageReport => {
  const byId = new Map(matrix.map((entry) => [entry.id, entry]));
  const missing = required.filter((id) => !byId.has(id));
  const uncovered = matrix
    .filter((entry) => entry.status !== "COVERED")
    .map((entry) => entry.id);
  const blankTestRef = matrix
    .filter((entry) => entry.testRef.trim() === "")
    .map((entry) => entry.id);
  const suites = new Set(knownSuites);
  const unknownTestRef = matrix
    .filter((entry) => !suites.has(entry.testRef))
    .map((entry) => entry.id);
  return {
    missing,
    uncovered,
    blankTestRef,
    unknownTestRef,
    ok:
      missing.length === 0 &&
      uncovered.length === 0 &&
      blankTestRef.length === 0 &&
      unknownTestRef.length === 0,
  };
};
