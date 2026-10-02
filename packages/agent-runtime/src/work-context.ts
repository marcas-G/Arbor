import type { Execution, Work, Workspace } from "@arbor/domain";
import {
  hashInstructionContent,
  type InstructionFragment,
} from "@arbor/model-context";
import { CANONICAL_TRUST } from "./prompt-assets.js";

export interface WorkContextAssembly {
  readonly fragments: ReadonlyArray<InstructionFragment>;
  readonly contents: ReadonlyMap<string, string>;
}

const makeFragment = (value: {
  identity: string;
  revision: number;
  semanticKind: string;
  scope: string;
  authorityRole: "A2" | "A3";
  contentRef: string;
  content: string;
}): InstructionFragment => ({
  identity: value.identity,
  revision: value.revision,
  hash: hashInstructionContent(value.content),
  semanticKind: value.semanticKind,
  source: "Canonical",
  scope: value.scope,
  authorityRole: value.authorityRole,
  strength: "Hard",
  compositionMode: "Constrain",
  activationCondition: "always",
  lifetime: "Protected",
  cacheClass: value.authorityRole === "A2" ? "SemiStable" : "TurnDynamic",
  budgetClass: value.authorityRole === "A2" ? "responsibility" : "work",
  modelCompatibility: [],
  contentRef: value.contentRef,
  provenance: CANONICAL_TRUST,
});

export const assembleWorkContext = (
  workspace: Workspace,
  work: Work | null,
  execution?: Execution,
): WorkContextAssembly => {
  const items = [
    {
      identity: `responsibility:${workspace.workspaceId}`,
      revision: Number(workspace.responsibilityRevision),
      semanticKind: "ResponsibilityDefinition",
      scope: "responsibility-definition",
      authorityRole: "A2" as const,
      contentRef: `responsibility:${workspace.workspaceId}:${workspace.responsibilityRevision}`,
      content: JSON.stringify(workspace.responsibilityDefinition),
    },
    {
      identity: `resource-boundary:${workspace.workspaceId}`,
      revision: Number(workspace.resourceBoundaryRevision),
      semanticKind: "ResourceBoundary",
      scope: "resource-boundary",
      authorityRole: "A2" as const,
      contentRef: `resource-boundary:${workspace.workspaceId}:${workspace.resourceBoundaryRevision}`,
      content: JSON.stringify(workspace.resourceBoundary),
    },
    ...(work === null
      ? []
      : [
          {
            identity: `work-objective:${work.workId}`,
            revision: Number(work.revision),
            semanticKind: "WorkObjective",
            scope: "work-objective",
            authorityRole: "A3" as const,
            contentRef: `work-objective:${work.workId}:${work.revision}`,
            content: `objective: ${work.objective}\nwhy: ${work.why}`,
          },
          {
            identity: `work-constraints:${work.workId}`,
            revision: Number(work.revision),
            semanticKind: "WorkConstraints",
            scope: "work-constraints",
            authorityRole: "A3" as const,
            contentRef: `work-constraints:${work.workId}:${work.revision}`,
            content: JSON.stringify(work.constraints),
          },
          {
            identity: `completion-expectation:${work.workId}`,
            revision: Number(work.revision),
            semanticKind: "CompletionExpectation",
            scope: "completion-expectation",
            authorityRole: "A3" as const,
            contentRef: `completion-expectation:${work.workId}:${work.revision}`,
            content: work.completionExpectation,
          },
          {
            identity: `verification-mission:${work.workId}`,
            revision: Number(work.revision),
            semanticKind: "VerificationMissionSummary",
            scope: "verification-mission-summary",
            authorityRole: "A3" as const,
            contentRef: `verification-mission:${work.workId}:${work.revision}`,
            content: JSON.stringify(work.verificationMission),
          },
        ]),
    ...(execution?.binding._tag === "ExecutionBoundAgentBinding"
      ? [
          {
            identity: `execution-bound-mission:${execution.executionId}`,
            revision: 0,
            semanticKind: "ExecutionBoundMission",
            scope: "execution-bound-mission",
            authorityRole: "A3" as const,
            contentRef: `execution-bound-mission:${execution.executionId}`,
            content: execution.binding.mission,
          },
        ]
      : []),
  ];
  return {
    fragments: items.map(makeFragment),
    contents: new Map(items.map((item) => [item.contentRef, item.content])),
  };
};
