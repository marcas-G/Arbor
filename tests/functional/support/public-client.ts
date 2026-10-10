import { randomUUID } from "node:crypto";

const uuidV7 = () => {
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

export const functionalId = (prefix: string): string => `${prefix}_${uuidV7()}`;

export const waitForPublic = async <A>(
  read: () => Promise<A>,
  predicate: (value: A) => boolean,
  timeoutMs = 30_000,
): Promise<A> => {
  const deadline = Date.now() + timeoutMs;
  let last: A | undefined;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (predicate(last)) return last;
    } catch {
      // Public process/view races retry until the scenario deadline.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`public functional timeout; last=${JSON.stringify(last)}`);
};

export interface PublicClient {
  readonly command: (
    projectId: string,
    commandType: string,
    payload: unknown,
  ) => Promise<Record<string, unknown>>;
  readonly view: <A>(name: string, request: unknown) => Promise<A>;
}

export const makePublicClient = (baseUrl: string): PublicClient => {
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer local",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (text.length === 0) {
      throw new Error(`${path} ${response.status}: empty response`);
    }
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(`${path} ${response.status}: ${JSON.stringify(parsed)}`);
    }
    return parsed;
  };
  return {
    command: async (projectId, commandType, payload) => {
      const response = await post("/commands", {
        commandType,
        commandId: functionalId("cmd"),
        projectId,
        actor: "user:local",
        issuedAt: new Date().toISOString(),
        payload,
      });
      const resolution = (response.body as { resolution?: string } | undefined)
        ?.resolution;
      if (resolution !== "Committed") {
        throw new Error(
          `${commandType} did not commit: ${JSON.stringify(response)}`,
        );
      }
      return response;
    },
    view: async <A>(name: string, request: unknown): Promise<A> => {
      const response = await post(`/views/${name}`, request);
      return (response.body as { value: A }).value;
    },
  };
};

export interface FunctionalProject {
  readonly projectId: string;
  readonly rootWorkspaceId: string;
  readonly rootSessionId: string;
}

export const createFunctionalProject = async (
  client: PublicClient,
  workspaceDirectory: string,
  name: string,
  options: {
    readonly rootWorkspacePolicy?: Readonly<Record<string, unknown>>;
  } = {},
): Promise<FunctionalProject> => {
  const projectId = functionalId("prj");
  const rootWorkspaceId = functionalId("ws");
  const rootSessionId = functionalId("ses");
  await client.command(projectId, "CreateProject", {
    name,
    revision: 0,
    projectPolicy: { delegationCeiling: 1 },
    projectPolicyRevision: 0,
    defaultConfiguration: {},
    environmentRef: "local",
    rootWorkspaceId,
    primarySession: { sessionId: rootSessionId, contextEpoch: 0 },
    rootWorkspace: {
      name: "root",
      responsibilityDefinition: {
        purpose: name,
        ownedResponsibilities: [],
        obligations: [],
        includes: [],
        excludes: [],
        interfaces: [],
      },
      responsibilityRevision: 0,
      resourceBoundary: {
        basisResponsibilityRevision: 0,
        addresses: [
          { _tag: "FileTree", path: workspaceDirectory },
          { _tag: "GitWorktree", path: workspaceDirectory },
        ],
      },
      resourceBoundaryRevision: 0,
      agentBinding: {
        _tag: "ResponsibilityBoundAgentBinding",
        workspaceId: rootWorkspaceId,
      },
      workspacePolicy: {
        delegationCeiling: 1,
        ...options.rootWorkspacePolicy,
      },
      workspacePolicyRevision: 0,
      revision: 0,
    },
  });
  return { projectId, rootWorkspaceId, rootSessionId };
};

export const submitHumanMessage = (
  client: PublicClient,
  project: FunctionalProject,
  body: string,
) =>
  client.command(project.projectId, "SubmitHumanMessage", {
    messageId: functionalId("msg"),
    targetWorkspaceId: project.rootWorkspaceId,
    bodyRef: body,
  });

export const proposeAndApproveChildWithInitialWork = async (
  client: PublicClient,
  project: FunctionalProject,
  marker: string,
  request: string,
  proposal: Readonly<Record<string, unknown>>,
): Promise<{
  readonly workspaceId: string;
  readonly name: string;
  readonly currentWork: { readonly workId: string; readonly objective: string };
}> => {
  await submitHumanMessage(client, project, request);
  const inbox = await waitForPublic(
    () =>
      client.view<{
        unconsumed: Array<{ entryKey: string; kind: string; summary: string }>;
      }>("inbox-view", { workspaceId: project.rootWorkspaceId }),
    (value) =>
      value.unconsumed.some(
        (entry) =>
          entry.kind === "Governance" &&
          entry.summary.includes(marker) &&
          /^gov:fpr_[^:]+:\d+$/u.test(entry.entryKey),
      ),
  );
  const entry = inbox.unconsumed.find(
    (candidate) =>
      candidate.kind === "Governance" &&
      candidate.summary.includes(marker) &&
      /^gov:fpr_[^:]+:\d+$/u.test(candidate.entryKey),
  );
  const formation =
    entry === undefined
      ? null
      : /^gov:(fpr_[^:]+):(\d+)$/u.exec(entry.entryKey);
  if (formation === null) {
    throw new Error(
      `public Inbox exposed no exact FormationProposal for ${marker}`,
    );
  }

  const before = await client.view<{
    nodes: Array<{ workspaceId: string; parentWorkspaceId: string | null }>;
  }>("responsibility-tree", { projectId: project.projectId });
  expectOnlyRootWorkspace(before.nodes, project.rootWorkspaceId);
  await client.command(project.projectId, "RecordDecision", {
    proposalId: formation[1],
    expectedProposalRevision: Number(formation[2]),
    outcome: { _tag: "Approve" },
  });

  const tree = await waitForPublic(
    () =>
      client.view<{
        nodes: Array<{
          workspaceId: string;
          parentWorkspaceId: string | null;
          name: string;
          currentWork?: { workId?: string; objective: string };
        }>;
      }>("responsibility-tree", { projectId: project.projectId }),
    (value) =>
      value.nodes.some(
        (node) =>
          node.parentWorkspaceId === project.rootWorkspaceId &&
          node.name === proposal.name &&
          node.currentWork?.workId !== undefined,
      ),
    45_000,
  );
  const child = tree.nodes.find(
    (node) =>
      node.parentWorkspaceId === project.rootWorkspaceId &&
      node.name === proposal.name,
  );
  const currentWork = child?.currentWork;
  const workId = currentWork?.workId;
  if (
    child === undefined ||
    currentWork === undefined ||
    workId === undefined
  ) {
    throw new Error(
      `approved FormationProposal did not create child Work for ${marker}`,
    );
  }
  return {
    workspaceId: child.workspaceId,
    name: child.name,
    currentWork: { workId, objective: currentWork.objective },
  };
};

const expectOnlyRootWorkspace = (
  nodes: Array<{ workspaceId: string; parentWorkspaceId: string | null }>,
  rootWorkspaceId: string,
) => {
  if (
    nodes.length !== 1 ||
    nodes[0]?.workspaceId !== rootWorkspaceId ||
    nodes[0]?.parentWorkspaceId !== null
  ) {
    throw new Error(
      "child must not exist before exact FormationProposal approval",
    );
  }
};

export const waitForApproval = async (
  client: PublicClient,
  project: FunctionalProject,
  marker: string,
): Promise<{ approvalId: string; revision: number }> => {
  const inbox = await waitForPublic(
    () =>
      client.view<{
        unconsumed: Array<{
          entryKey: string;
          kind: string;
          summary: string;
        }>;
      }>("inbox-view", { workspaceId: project.rootWorkspaceId }),
    (value) =>
      value.unconsumed.some(
        (entry) =>
          entry.kind === "Governance" &&
          entry.summary.includes(marker) &&
          /^cap:cap_[^:]+:\d+$/u.test(entry.entryKey),
      ),
  );
  const entry = inbox.unconsumed.find(
    (candidate) =>
      candidate.kind === "Governance" &&
      candidate.summary.includes(marker) &&
      /^cap:cap_[^:]+:\d+$/u.test(candidate.entryKey),
  );
  const match =
    entry === undefined
      ? null
      : /^cap:(cap_[^:]+):(\d+)$/u.exec(entry.entryKey);
  if (match === null) {
    throw new Error(`public Inbox exposed no exact approval for ${marker}`);
  }
  return { approvalId: match[1] as string, revision: Number(match[2]) };
};
