import { randomUUID } from "node:crypto";

/**
 * P13 e2e fixtures — the frozen CreateProject payload shape exactly as the
 * transport contract test (tests/p12-transport.test.ts) assembles it. The
 * web client builds the same shape (apps/web CreateProjectForm); this is the
 * server-side mirror for story-path verification. Memoized per key so
 * multiple story steps address the SAME project.
 */
const memo = new Map<string, ReturnType<typeof build>>();

const build = () => {
  const projectId = `prj_${randomUUID()}`;
  const rootWorkspaceId = `ws_${randomUUID()}`;
  return {
    projectId,
    name: `P13 e2e ${projectId.slice(4, 12)}`,
    revision: 0,
    projectPolicy: {},
    projectPolicyRevision: 0,
    defaultConfiguration: {},
    environmentRef: "local",
    rootWorkspaceId,
    primarySession: {
      sessionId: `ses_${randomUUID()}`,
      contextEpoch: 0,
    },
    rootWorkspace: {
      name: "root",
      responsibilityDefinition: {
        purpose: "p13 e2e root",
        ownedResponsibilities: [],
        obligations: [],
        includes: [],
        excludes: [],
        interfaces: [],
      },
      responsibilityRevision: 0,
      resourceBoundary: {
        basisResponsibilityRevision: 0,
        addresses: [],
      },
      resourceBoundaryRevision: 0,
      agentBinding: {
        _tag: "ResponsibilityBoundAgentBinding",
        workspaceId: rootWorkspaceId,
      },
      workspacePolicy: {},
      workspacePolicyRevision: 0,
      revision: 0,
    },
  };
};

export const createProjectPayloadShape = (key: string) => {
  const existing = memo.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const payload = build();
  memo.set(key, payload);
  return payload;
};
