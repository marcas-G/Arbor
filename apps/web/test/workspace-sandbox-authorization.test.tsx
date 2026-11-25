import type { WorkspaceDetailRes } from "@arbor/api-contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSandboxAuthorizationForm } from "../src/commands/forms/WorkspaceSandboxAuthorizationForm.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const candidateId = `spc2_${"a".repeat(64)}`;
const candidateRead = {
  commonPreconditions: {},
  reason: "InitialDecision",
  candidates: [
    {
      kind: "OsEnforced",
      candidateId,
      providerId: "linux-bwrap",
      profile: "WorkspaceWrite",
      networkMode: "Enabled",
    },
    { kind: "TrustedLocalUnconfinedV1", candidateId: "unconfined" },
  ],
} as unknown as WorkspaceDetailRes["sandboxPolicyCandidateRead"];
const authorization = {
  expectedAuthorizationRevision: 0,
  resourceBoundaryRevision: 3,
  workspacePolicyRevision: 2,
  current: null,
};
const props = {
  actor: "user:local",
  projectId: "prj_current",
  workspaceId: "ws_current",
  authorization,
  candidateRead,
  onSubmitted: vi.fn(),
};
const recordRequests = (loseFirst = false) => {
  const requests: Array<{
    commandId: string;
    commandType: string;
    payload: Record<string, unknown>;
  }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const envelope = JSON.parse(String(init.body));
      requests.push(envelope);
      if (loseFirst && requests.length === 1) throw new Error("response lost");
      return new Response(
        JSON.stringify({
          ok: true,
          body: { commandId: envelope.commandId, resolution: "Committed" },
        }),
        { status: 200 },
      );
    }),
  );
  return requests;
};

describe("Workspace execution environment authorization", () => {
  it("does not expose a manual authorization prompt before system initialization", async () => {
    const requests = recordRequests();
    render(<WorkspaceSandboxAuthorizationForm {...props} />);
    expect(requests).toHaveLength(0);
    expect(screen.getByText(/不能通过手工授权绕过环境资格检查/)).toBeTruthy();
    expect(screen.queryByLabelText("隔离环境")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "授权此工作区使用" }),
    ).toBeNull();
  });

  it("does not create a human authorization request when the response is lost before initialization", async () => {
    const requests = recordRequests(true);
    render(<WorkspaceSandboxAuthorizationForm {...props} />);
    expect(requests).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });

  it("allows explicit revocation even when no host candidate is available", async () => {
    const requests = recordRequests();
    const current = { state: "Granted" } as NonNullable<
      NonNullable<
        WorkspaceDetailRes["workspaceSandboxAuthorization"]
      >["current"]
    >;
    render(
      <WorkspaceSandboxAuthorizationForm
        {...props}
        candidateRead={undefined}
        authorization={{
          ...authorization,
          expectedAuthorizationRevision: 4,
          current,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "撤销执行环境授权" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      commandType: "RevokeWorkspaceSandboxAuthorization",
      payload: { workspaceId: "ws_current", expectedAuthorizationRevision: 4 },
    });
  });

  it("lets the human restore revoked authority with a qualified host candidate", async () => {
    const requests = recordRequests();
    render(
      <WorkspaceSandboxAuthorizationForm
        {...props}
        authorization={{
          ...authorization,
          expectedAuthorizationRevision: 5,
          current: { state: "Revoked" } as NonNullable<
            NonNullable<
              WorkspaceDetailRes["workspaceSandboxAuthorization"]
            >["current"]
          >,
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText("隔离环境"), {
      target: { value: candidateId },
    });
    fireEvent.click(screen.getByRole("button", { name: "授权此工作区使用" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      commandType: "AuthorizeWorkspaceSandbox",
      payload: {
        expectedAuthorizationRevision: 5,
        source: { kind: "Human" },
        profile: "WorkspaceWrite",
        providerId: "linux-bwrap",
        networkPolicy: { version: 1, mode: "Enabled", destinations: [] },
      },
    });
    expect(requests[0]?.payload).not.toHaveProperty("providerVersion");
    expect(requests[0]?.payload).not.toHaveProperty("qualificationEvidenceRef");
  });
});
