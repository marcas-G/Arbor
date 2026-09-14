

/** D-045: the single SDK. Every client (web console now; tui/app later) goes
 * through here — types derive from the same contract schemas. No client
 * writes ad-hoc fetch calls against the server. */

export class ArborSdk {
  constructor(private readonly baseUrl: string) {}

  private async call<T>(method: "GET" | "POST", path: string, body?: object): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}), headers: { "content-type": "application/json" } } : {}),
    });
    const json = (await res.json()) as T & { error?: string };
    if (!res.ok) {
      throw new Error(json.error ?? `HTTP ${res.status}`);
    }
    return json;
  }

  initProject(repoPath: string, home?: string) {
    return this.call<{ projectId: string; workspaceId: string; effectiveRefSha: string }>(
      "POST",
      `/api/projects`,
      { repoPath, ...(home !== undefined ? { home } : {}) },
    );
  }
  tree(projectId: string, home?: string) {
    return this.call<{
      nodes: Array<{
        workspaceId: string;
        parentId?: string;
        kind: string;
        writablePrefixes: string[];
        effective: string;
      }>;
      milestone?: { n: number; rootCommit: string; summary: string };
    }>("GET", `/api/tree?projectId=${projectId}${home !== undefined ? `&home=${home}` : ""}`);
  }
  startAgentRun(projectId: string, opts?: { workspaceId?: string; task?: string; home?: string }) {
    return this.call<{ pid: number; agentId: string }>("POST", `/api/agent/runs`, {
      projectId,
      ...(opts?.workspaceId !== undefined ? { workspaceId: opts.workspaceId } : {}),
      ...(opts?.task !== undefined ? { task: opts.task } : {}),
      ...(opts?.home !== undefined ? { home: opts.home } : {}),
    });
  }
  agentEvents(agentId: string, since: number, home?: string) {
    return this.call<{ events: Array<{ sequence: number; type: string; timestamp: string }>; lastSeq: number }>(
      "GET",
      `/api/agents/${agentId}/events?since=${since}${home !== undefined ? `&home=${home}` : ""}`,
    );
  }
  accept(projectId: string, workspaceId: string, home?: string) {
    return this.call<{ status: string; detail?: string; mergedCommit?: string; invalidated?: string[] }>(
      "POST",
      `/api/workspaces/${workspaceId}/accept`,
      { projectId, ...(home !== undefined ? { home } : {}) },
    );
  }
  listApprovals(projectId: string, home?: string) {
    return this.call<{
      approvals: Array<{ id: string; status: string; childWorkspaceId: string; materials: string }>;
    }>("GET", `/api/approvals?projectId=${projectId}${home !== undefined ? `&home=${home}` : ""}`);
  }
  decideApproval(id: string, projectId: string, approve: boolean, home?: string, note?: string) {
    return this.call<{ status: string; continued?: string }>("POST", `/api/approvals/${id}`, {
      projectId,
      approve,
      ...(note !== undefined ? { note } : {}),
      ...(home !== undefined ? { home } : {}),
    });
  }
  fixMilestone(projectId: string, summary: string, home?: string) {
    return this.call<{ n: number; rootCommit: string }>("POST", `/api/milestones`, {
      projectId,
      summary,
      ...(home !== undefined ? { home } : {}),
    });
  }
  openapi() {
    return this.call<object>("GET", `/api/openapi.json`);
  }
}
