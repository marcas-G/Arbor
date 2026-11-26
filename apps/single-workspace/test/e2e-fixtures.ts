import { randomUUID } from "node:crypto";

const uuidV7 = (): string => {
  const chars = randomUUID().replaceAll("-", "").split("");
  chars[12] = "7";
  chars[16] = "8";
  return [
    chars.slice(0, 8).join(""),
    chars.slice(8, 12).join(""),
    chars.slice(12, 16).join(""),
    chars.slice(16, 20).join(""),
    chars.slice(20).join(""),
  ].join("-");
};

export const p13Id = (prefix: string): string => `${prefix}_${uuidV7()}`;

/**
 * P13 e2e fixtures — the frozen CreateProject payload shape exactly as the
 * transport contract test (tests/p12-transport.test.ts) assembles it. The
 * web client builds the same shape (apps/web CreateProjectForm); this is the
 * server-side mirror for story-path verification. Memoized per key so
 * multiple story steps address the SAME project.
 */
const memo = new Map<string, ReturnType<typeof build>>();

const build = () => {
  const projectId = p13Id("prj");
  const rootWorkspaceId = p13Id("ws");
  return {
    projectId,
    payload: {
      name: `P13 e2e ${projectId.slice(4, 12)}`,
      revision: 0,
      projectPolicy: {},
      projectPolicyRevision: 0,
      defaultConfiguration: {},
      environmentRef: "local",
      rootWorkspaceId,
      primarySession: {
        sessionId: p13Id("ses"),
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
        resourceSelection: { _tag: "ConversationOnly" },
        agentBinding: {
          _tag: "ResponsibilityBoundAgentBinding",
          workspaceId: rootWorkspaceId,
        },
        workspacePolicy: {},
        workspacePolicyRevision: 0,
        revision: 0,
      },
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
