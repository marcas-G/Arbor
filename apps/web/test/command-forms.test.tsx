/**
 * P13-005 command forms: each of the seven Human-actionable forms constructs
 * the frozen envelope (POST /commands, cmd_-prefixed v7 commandId, injected
 * actor/projectId), StopExecution requires explicit confirmation, SteerWork
 * Critical requires the second checkbox, transport-failure retries reuse the
 * SAME commandId until a server receipt (EC: retry idempotency), and
 * TerminalRejected renders CommandInlineError while allowing resubmission
 * under a NEW commandId.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcceptWorkOutcomeForm } from "../src/commands/forms/AcceptWorkOutcomeForm.js";
import { CreateProjectForm } from "../src/commands/forms/CreateProjectForm.js";
import { GrantPermissionForm } from "../src/commands/forms/GrantPermissionForm.js";
import { RecordDecisionForm } from "../src/commands/forms/RecordDecisionForm.js";
import { RevokePermissionForm } from "../src/commands/forms/RevokePermissionForm.js";
import { SteerWorkForm } from "../src/commands/forms/SteerWorkForm.js";
import { StopExecutionForm } from "../src/commands/forms/StopExecutionForm.js";
import {
  currentWorkTypical,
  verificationTypical,
} from "../src/views/fixtures.js";

type Envelope = Record<string, unknown>;

interface FetchMock {
  readonly mock: {
    readonly calls: ReadonlyArray<readonly [string, RequestInit]>;
  };
}

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;
type FetchFn = ReturnType<typeof vi.fn<FetchImpl>> & FetchMock;

const committed = (commandId = "cmd_server_1") =>
  new Response(
    JSON.stringify({
      ok: true,
      status: 200,
      body: { commandId, resolution: "Committed" },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const terminalRejected = (rejection: string) =>
  new Response(
    JSON.stringify({
      ok: true,
      status: 200,
      body: {
        commandId: "cmd_server_rej",
        resolution: "TerminalRejected",
        rejection,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const projectResourceCatalog = (
  profiles: ReadonlyArray<{
    readonly resourceProfileRef: string;
    readonly version: string;
    readonly displayName: string;
    readonly available: boolean;
  }>,
) =>
  new Response(
    JSON.stringify({
      ok: true,
      status: 200,
      body: { profiles, conversationOnlySupported: true },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const singleAvailableProjectProfile = () =>
  projectResourceCatalog([
    {
      resourceProfileRef: "project-root-ref",
      version: "project-root-version",
      displayName: "Project files",
      available: true,
    },
  ]);

function stubFetch(impl: FetchImpl): FetchFn {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock as unknown as FetchFn;
}

function readCall(
  fetchMock: FetchMock,
  index = 0,
): {
  readonly url: string;
  readonly init: RequestInit;
  readonly envelope: Envelope;
} {
  const call = fetchMock.mock.calls[index];
  if (call === undefined) {
    throw new Error(`fetch call ${index} was not made`);
  }
  const [url, init] = call;
  return {
    url,
    init,
    envelope: JSON.parse(String(init.body)) as Envelope,
  };
}

function readCommandCall(fetchMock: FetchMock) {
  const index = fetchMock.mock.calls.findIndex(([url]) => url === "/commands");
  if (index < 0) throw new Error("/commands fetch was not made");
  return readCall(fetchMock, index);
}

const payloadOf = (envelope: Envelope): Record<string, unknown> =>
  envelope.payload as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CreateProjectForm", () => {
  it("submits a bootstrap envelope with caller-preallocated prj_ id", async () => {
    const onSubmitted = vi.fn();
    const fetchMock = stubFetch((url) =>
      Promise.resolve(
        url === "/project-resources"
          ? singleAvailableProjectProfile()
          : committed(),
      ),
    );
    render(
      <CreateProjectForm
        actor="human:root"
        token="tok_1"
        onSubmitted={onSubmitted}
      />,
    );
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "创建项目" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.change(screen.getByLabelText("项目名称"), {
      target: { value: "论文写作平台" },
    });
    expect(screen.queryByLabelText("根责任目标")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => url === "/commands"),
      ).toHaveLength(1),
    );
    const { url, init, envelope } = readCommandCall(fetchMock);
    expect(url).toBe("/commands");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok_1",
    );
    expect(envelope.commandType).toBe("CreateProject");
    expect(String(envelope.commandId)).toMatch(/^cmd_[0-9a-f-]{36}$/);
    expect(envelope.actor).toBe("human:root");
    expect(String(envelope.projectId)).toMatch(/^prj_/);
    const payload = payloadOf(envelope) as Record<string, unknown>;
    expect(payload.name).toBe("论文写作平台");
    expect(payload).not.toHaveProperty("projectId");
    const root = payload.rootWorkspace as Record<string, unknown>;
    expect(root.name).toBe("论文写作平台");
    expect(
      (root.responsibilityDefinition as Record<string, unknown>).purpose,
    ).toBe("论文写作平台");
    expect(String(payload.rootWorkspaceId)).toMatch(/^ws_/);
    expect(
      String((payload.primarySession as Record<string, unknown>).sessionId),
    ).toMatch(/^ses_/);
    expect((root.agentBinding as Record<string, unknown>)._tag).toBe(
      "ResponsibilityBoundAgentBinding",
    );
    expect(Number.isNaN(Date.parse(String(envelope.issuedAt)))).toBe(false);
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
  });

  it("creates without binding a folder even when host Profiles exist", async () => {
    const onSubmitted = vi.fn();
    const hostPath = "C:\\private\\host\\workspace";
    const fetchMock = stubFetch((url) =>
      Promise.resolve(
        url === "/project-resources"
          ? projectResourceCatalog([
              {
                resourceProfileRef: "opaque-profile-secret",
                version: "opaque-version-secret",
                displayName: "Friendly writing workspace",
                available: true,
              },
            ])
          : committed(),
      ),
    );
    render(
      <CreateProjectForm
        actor="human:root"
        token="tok_profile"
        onSubmitted={onSubmitted}
      />,
    );
    expect(
      screen.queryByText(/opaque-profile-secret|opaque-version-secret/u),
    ).toBeNull();
    expect(screen.queryByText(hostPath)).toBeNull();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "创建项目" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.change(screen.getByLabelText("项目名称"), {
      target: { value: "Profile project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => url === "/commands"),
      ).toHaveLength(1),
    );
    const { envelope } = readCommandCall(fetchMock);
    const root = payloadOf(envelope).rootWorkspace as Record<string, unknown>;
    expect(root.resourceSelection).toEqual({ _tag: "ConversationOnly" });
    expect(root).not.toHaveProperty("resourceBoundary");
    expect(JSON.stringify(envelope)).not.toContain(hostPath);
    const catalogCall = fetchMock.mock.calls.find(
      ([url]) => url === "/project-resources",
    );
    expect(catalogCall?.[1].headers).toMatchObject({
      Authorization: "Bearer tok_profile",
    });
  });

  it("does not bind any host Profile when multiple Profiles are available", async () => {
    const onSubmitted = vi.fn();
    const fetchMock = stubFetch((url) =>
      Promise.resolve(
        url === "/project-resources"
          ? projectResourceCatalog([
              {
                resourceProfileRef: "opaque-first",
                version: "v1",
                displayName: "First workspace",
                available: true,
              },
              {
                resourceProfileRef: "opaque-second",
                version: "v2",
                displayName: "Second workspace",
                available: true,
              },
            ])
          : committed(),
      ),
    );
    render(<CreateProjectForm actor="human:root" onSubmitted={onSubmitted} />);
    const create = screen.getByRole("button", { name: "创建项目" });
    await waitFor(() =>
      expect((create as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.change(screen.getByLabelText("项目名称"), {
      target: { value: "Second profile project" },
    });
    fireEvent.click(create);
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    const root = payloadOf(readCommandCall(fetchMock).envelope)
      .rootWorkspace as Record<string, unknown>;
    expect(root.resourceSelection).toEqual({ _tag: "ConversationOnly" });
  });

  it("silently creates a folderless project when no Profile is available", async () => {
    const onSubmitted = vi.fn();
    const fetchMock = stubFetch((url) =>
      Promise.resolve(
        url === "/project-resources" ? projectResourceCatalog([]) : committed(),
      ),
    );
    render(<CreateProjectForm actor="human:root" onSubmitted={onSubmitted} />);
    const create = screen.getByRole("button", { name: "创建项目" });
    await waitFor(() =>
      expect((create as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.change(screen.getByLabelText("项目名称"), {
      target: { value: "Conversation only project" },
    });
    fireEvent.click(create);
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    const root = payloadOf(readCommandCall(fetchMock).envelope)
      .rootWorkspace as Record<string, unknown>;
    expect(root.resourceSelection).toEqual({ _tag: "ConversationOnly" });
    expect(root).not.toHaveProperty("resourceBoundary");
  });

  it("falls back to a folderless project when the configured Profile is unavailable", async () => {
    const fetchMock = stubFetch((url) =>
      Promise.resolve(
        url === "/project-resources"
          ? projectResourceCatalog([
              {
                resourceProfileRef: "opaque-unavailable",
                version: "old-version",
                displayName: "Offline repository",
                available: false,
              },
            ])
          : committed(),
      ),
    );
    render(<CreateProjectForm actor="human:root" onSubmitted={vi.fn()} />);
    const create = screen.getByRole("button", { name: "创建项目" });
    await waitFor(() =>
      expect((create as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.change(screen.getByLabelText("项目名称"), {
      target: { value: "Folderless project" },
    });
    fireEvent.click(create);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === "/commands")).toBe(
        true,
      ),
    );
    const root = payloadOf(readCommandCall(fetchMock).envelope)
      .rootWorkspace as Record<string, unknown>;
    expect(root.resourceSelection).toEqual({ _tag: "ConversationOnly" });
  });

  it("shows a stable readable rejection when a selected Profile becomes stale", async () => {
    const onSubmitted = vi.fn();
    stubFetch((url) =>
      Promise.resolve(
        url === "/project-resources"
          ? projectResourceCatalog([
              {
                resourceProfileRef: "opaque-stale-profile",
                version: "catalog-version",
                displayName: "Selected repository",
                available: true,
              },
            ])
          : terminalRejected("ProjectResourceUnavailable"),
      ),
    );
    render(<CreateProjectForm actor="human:root" onSubmitted={onSubmitted} />);
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "创建项目" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.change(screen.getByLabelText("项目名称"), {
      target: { value: "Stale profile project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(
        /项目文件位置.*不可用|已变化/u,
      ),
    );
    expect(screen.getByRole("alert").textContent).not.toContain(
      "opaque-unavailable",
    );
    expect(screen.getByRole("alert").textContent).not.toContain("old-version");
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it("reuses the same commandId (and prj_ id) across transport-failure retries", async () => {
    const onSubmitted = vi.fn();
    let commandRequests = 0;
    const fetchMock = stubFetch((url) => {
      if (url === "/project-resources") {
        return Promise.resolve(singleAvailableProjectProfile());
      }
      commandRequests += 1;
      return commandRequests === 1
        ? Promise.reject(new Error("network down"))
        : Promise.resolve(committed());
    });
    render(<CreateProjectForm actor="human:root" onSubmitted={onSubmitted} />);
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "创建项目" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.change(screen.getByLabelText("项目名称"), {
      target: { value: "p1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
    await waitFor(() => expect(screen.getByText("服务不可用")).toBeTruthy());
    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/commands"),
    ).toHaveLength(1);
    expect(screen.getByText(/transport\/unavailable/)).toBeTruthy();
    expect(
      (screen.getByLabelText("项目名称") as HTMLInputElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => url === "/commands"),
      ).toHaveLength(2),
    );
    const first = readCommandCall(fetchMock).envelope;
    const secondCommandIndex = fetchMock.mock.calls.findIndex(
      ([url], index) => url === "/commands" && index > 0,
    );
    const second = readCall(fetchMock, secondCommandIndex).envelope;
    expect(second.commandId).toBe(first.commandId);
    expect(second.projectId).toBe(first.projectId);
    expect(payloadOf(second)).not.toHaveProperty("projectId");
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
  });
});

describe("RecordDecisionForm", () => {
  const proposal = {
    proposalId: "fpr_formation_9",
    revision: 3,
    summary: "拆分为写作与检索两个子工作区",
  };

  it("binds the exact pending proposal revision with the frozen outcome ADT", async () => {
    const fetchMock = stubFetch(() => Promise.resolve(committed()));
    render(
      <RecordDecisionForm
        actor="human:root"
        projectId="prj_1"
        target={{
          proposalId: proposal.proposalId,
          proposalRevision: proposal.revision,
          summary: proposal.summary,
        }}
        onSubmitted={vi.fn()}
      />,
    );
    expect(screen.queryByText(/当前提案版本/)).toBeNull();
    fireEvent.change(screen.getByLabelText("决策"), {
      target: { value: "Reject" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交决策" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(1));
    const { envelope } = readCall(fetchMock);
    expect(envelope.commandType).toBe("RecordDecision");
    expect(envelope.actor).toBe("human:root");
    expect(envelope.projectId).toBe("prj_1");
    expect(payloadOf(envelope)).toEqual({
      proposalId: proposal.proposalId,
      expectedProposalRevision: 3,
      outcome: { _tag: "Reject" },
    });
  });

  it("omits the note key when the note is empty", async () => {
    const fetchMock = stubFetch(() => Promise.resolve(committed()));
    render(
      <RecordDecisionForm
        actor="human:root"
        projectId="prj_1"
        target={{
          proposalId: proposal.proposalId,
          proposalRevision: proposal.revision,
          summary: proposal.summary,
        }}
        onSubmitted={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "提交决策" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(1));
    const payload = payloadOf(readCall(fetchMock).envelope);
    expect(payload).toEqual({
      proposalId: proposal.proposalId,
      expectedProposalRevision: 3,
      outcome: { _tag: "Approve" },
    });
  });

  it("TerminalRejected renders CommandInlineError and resubmits under a new commandId", async () => {
    const fetchMock = stubFetch(() => Promise.resolve(committed()));
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        terminalRejected("authority/denied: 缺少 RecordDecision 权限"),
      ),
    );
    render(
      <RecordDecisionForm
        actor="human:root"
        projectId="prj_1"
        target={{
          proposalId: proposal.proposalId,
          proposalRevision: proposal.revision,
          summary: proposal.summary,
        }}
        onSubmitted={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "提交决策" }));
    await waitFor(() =>
      expect(
        screen.getByText("authority/denied: 缺少 RecordDecision 权限"),
      ).toBeTruthy(),
    );
    expect(screen.getByRole("alert").textContent).toContain("重新提交");
    fireEvent.click(screen.getByRole("button", { name: "提交决策" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2));
    const firstId = readCall(fetchMock, 0).envelope.commandId;
    const secondId = readCall(fetchMock, 1).envelope.commandId;
    expect(secondId).not.toBe(firstId);
    expect(String(secondId)).toMatch(/^cmd_/);
  });
});

describe("SteerWorkForm", () => {
  if (currentWorkTypical === null) {
    throw new Error("D0 current-work fixture must carry a Work revision");
  }
  // This carrier is read from the typed current-work server fixture, never a
  // form default or browser-maintained counter.
  const serverSuppliedWorkRevision = currentWorkTypical.revision;

  const setup = () => {
    const fetchMock = stubFetch(() => Promise.resolve(committed()));
    render(
      <SteerWorkForm
        actor="human:root"
        projectId="prj_1"
        workId="wrk_9"
        workspaceId="ws_9"
        objective="完成第二章"
        expectedWorkRevision={serverSuppliedWorkRevision}
        onSubmitted={vi.fn()}
      />,
    );
    return fetchMock;
  };

  it("submits a Normal steer with message and workId", async () => {
    const fetchMock = setup();
    fireEvent.change(screen.getByLabelText("调整说明"), {
      target: { value: "先完成大纲再动笔" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送调整" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(1));
    const { envelope } = readCall(fetchMock);
    expect(envelope.commandType).toBe("SteerWork");
    expect(payloadOf(envelope)).toEqual({
      workId: "wrk_9",
      workspaceId: "ws_9",
      steer: { severity: "Normal", guidance: "先完成大纲再动笔" },
      expectedWorkRevision: serverSuppliedWorkRevision,
      provenance: { source: "HumanInput" },
    });
  });

  it("Critical requires the explicit second confirmation before submit", async () => {
    const fetchMock = setup();
    fireEvent.change(screen.getByLabelText("调整说明"), {
      target: { value: "立即停止扩写，回到主题" },
    });
    fireEvent.change(screen.getByLabelText("紧急程度"), {
      target: { value: "Critical" },
    });
    const submit = screen.getByRole("button", {
      name: "发送调整",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("我确认这项调整需要立即生效"));
    expect(
      (screen.getByRole("button", { name: "发送调整" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "发送调整" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(1));
    expect(payloadOf(readCall(fetchMock).envelope)).toEqual({
      workId: "wrk_9",
      workspaceId: "ws_9",
      steer: { severity: "Critical", guidance: "立即停止扩写，回到主题" },
      expectedWorkRevision: serverSuppliedWorkRevision,
      provenance: { source: "HumanInput" },
    });
  });
});

describe("AcceptWorkOutcomeForm", () => {
  it("submits the frozen acceptance payload with a preallocated acc_ id", async () => {
    const fetchMock = stubFetch(() => Promise.resolve(committed()));
    render(
      <AcceptWorkOutcomeForm
        actor="human:root"
        projectId="prj_1"
        workId="wrk_5"
        targetWorkRevision={3}
        verificationId="ver_5"
        onSubmitted={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "记录验收" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(1));
    const { envelope } = readCall(fetchMock);
    expect(envelope.commandType).toBe("AcceptWorkOutcome");
    const payload = payloadOf(envelope) as Record<string, unknown>;
    expect(payload.workId).toBe("wrk_5");
    expect(payload.targetWorkRevision).toBe(3);
    expect(payload.verificationId).toBe("ver_5");
    expect(String(payload.acceptanceId)).toMatch(/^acc_[0-9a-f-]{36}$/);
  });

  it("keeps a server-supplied target Work revision zero unchanged in the acceptance payload", async () => {
    const fetchMock = stubFetch(() => Promise.resolve(committed()));
    if (
      verificationTypical.verificationId === undefined ||
      verificationTypical.targetWorkRevision === undefined
    ) {
      throw new Error("D0 verification fixture must carry its frozen identity");
    }
    // VerificationView.targetWorkRevision is a frozen server identity value.
    const serverSuppliedTargetWorkRevision =
      verificationTypical.targetWorkRevision;
    render(
      <AcceptWorkOutcomeForm
        actor="human:root"
        projectId="prj_1"
        workId="wrk_5"
        targetWorkRevision={serverSuppliedTargetWorkRevision}
        verificationId={verificationTypical.verificationId}
        onSubmitted={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "记录验收" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(1));
    expect(payloadOf(readCall(fetchMock).envelope)).toMatchObject({
      workId: "wrk_5",
      targetWorkRevision: serverSuppliedTargetWorkRevision,
      verificationId: verificationTypical.verificationId,
    });
  });
});

describe("StopExecutionForm", () => {
  it("does not fetch before the explicit confirmation", async () => {
    const fetchMock = stubFetch(() => Promise.resolve(committed()));
    render(
      <StopExecutionForm
        actor="human:root"
        projectId="prj_1"
        executionId="exe_42"
        workspaceName="检索工作区"
        onSubmitted={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "紧急停止执行" }));
    expect(fetchMock.mock.calls.length).toBe(0);
    expect(screen.getByText(/检索工作区将不再继续当前运行/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(fetchMock.mock.calls.length).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "紧急停止执行" }));
    const confirmStop = screen.getByRole("button", {
      name: "确认停止",
    }) as HTMLButtonElement;
    expect(confirmStop.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("我确认要立即停止"));
    fireEvent.click(screen.getByRole("button", { name: "确认停止" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(1));
    const { envelope } = readCall(fetchMock);
    expect(envelope.commandType).toBe("StopExecution");
    expect(payloadOf(envelope)).toEqual({
      executionId: "exe_42",
      reason: "human-emergency-stop",
    });
  });

  it("reuses the same commandId when the emergency stop hits a transport failure", async () => {
    const fetchMock = stubFetch(() => Promise.resolve(committed()));
    fetchMock.mockImplementationOnce(() =>
      Promise.reject(new Error("network down")),
    );
    render(
      <StopExecutionForm
        actor="human:root"
        projectId="prj_1"
        executionId="exe_42"
        onSubmitted={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "紧急停止执行" }));
    fireEvent.click(screen.getByLabelText("我确认要立即停止"));
    fireEvent.click(screen.getByRole("button", { name: "确认停止" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(1));
    await waitFor(() => expect(screen.getByText("服务不可用")).toBeTruthy());
    expect(
      (screen.getByLabelText("我确认要立即停止") as HTMLInputElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2));
    const first = readCall(fetchMock, 0).envelope;
    const second = readCall(fetchMock, 1).envelope;
    expect(second.commandId).toBe(first.commandId);
    expect(payloadOf(second).executionId).toBe("exe_42");
  });
});

describe("GrantPermissionForm", () => {
  it("grants a capability to an explicit subject and target", async () => {
    const fetchMock = stubFetch(() => Promise.resolve(committed()));
    render(
      <GrantPermissionForm
        actor="human:admin"
        projectId="prj_1"
        onSubmitted={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("允许的操作"), {
      target: { value: "RecordDecision" },
    });
    fireEvent.change(screen.getByLabelText(/适用范围（可选）/), {
      target: { value: "ws_9" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开放操作" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(1));
    const { envelope } = readCall(fetchMock);
    expect(envelope.commandType).toBe("GrantPermission");
    expect(envelope.actor).toBe("human:admin");
    const payload = payloadOf(envelope) as Record<string, unknown>;
    expect(payload.capability).toBe("RecordDecision");
    expect(payload.target).toBe("ws_9");
    expect(payload.subject).toEqual({
      _tag: "HumanPrincipal",
      principal: "human:admin",
    });
    expect(payload.issuer).toBe("human:admin");
    expect(payload.expiresAt).toBeNull();
    expect(String(payload.permissionGrantId)).toMatch(/^pgr_[0-9a-f-]{36}$/);
  });

  it("supports free-text capability and optional target omission", async () => {
    const fetchMock = stubFetch(() => Promise.resolve(committed()));
    render(
      <GrantPermissionForm
        actor="human:admin"
        projectId="prj_1"
        onSubmitted={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("允许的操作"), {
      target: { value: "__custom__" },
    });
    fireEvent.change(screen.getByLabelText("操作名称"), {
      target: { value: "RegisterProjectTool" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开放操作" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(1));
    const payload = payloadOf(readCall(fetchMock).envelope) as Record<
      string,
      unknown
    >;
    expect(payload.capability).toBe("RegisterProjectTool");
    expect(payload.target).toBeNull();
  });
});

describe("RevokePermissionForm", () => {
  const grants = [
    {
      grantId: "pgr_1",
      principal: "human:reviewer",
      commandType: "RecordDecision",
    },
    {
      grantId: "pgr_2",
      principal: "agent:ops",
      commandType: "RegisterProjectTool",
    },
  ];

  it("revokes the selected grant by permissionGrantId only", async () => {
    const fetchMock = stubFetch(() => Promise.resolve(committed()));
    render(
      <RevokePermissionForm
        actor="human:admin"
        projectId="prj_1"
        grants={grants}
        onSubmitted={vi.fn()}
      />,
    );
    expect(screen.queryByText("pgr_1")).toBeNull();
    expect(
      screen.getByRole("option", { name: "human:reviewer · 确认项目决策" }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("选择授权"), {
      target: { value: "pgr_2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "撤销授权" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(1));
    const { envelope } = readCall(fetchMock);
    expect(envelope.commandType).toBe("RevokePermission");
    expect(payloadOf(envelope)).toEqual({ permissionGrantId: "pgr_2" });
  });

  it("renders an empty state and no submit control without grants", () => {
    const fetchMock = stubFetch(() => Promise.resolve(committed()));
    render(
      <RevokePermissionForm
        actor="human:admin"
        projectId="prj_1"
        grants={[]}
        onSubmitted={vi.fn()}
      />,
    );
    expect(screen.getByText("暂无可撤销的授权")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "撤销授权" })).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(0);
  });
});
