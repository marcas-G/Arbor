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

const payloadOf = (envelope: Envelope): Record<string, unknown> =>
  envelope.payload as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CreateProjectForm", () => {
  it("submits a bootstrap envelope with caller-preallocated prj_ id", async () => {
    const onSubmitted = vi.fn();
    const fetchMock = stubFetch(() => Promise.resolve(committed()));
    render(
      <CreateProjectForm
        actor="human:root"
        token="tok_1"
        onSubmitted={onSubmitted}
      />,
    );
    fireEvent.change(screen.getByLabelText("项目名称"), {
      target: { value: "论文写作平台" },
    });
    fireEvent.change(screen.getByLabelText("根责任目标"), {
      target: { value: "完成论文初稿" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(1));
    const { url, init, envelope } = readCall(fetchMock);
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
    expect(payload.projectId).toBe(envelope.projectId);
    const root = payload.rootWorkspace as Record<string, unknown>;
    expect(
      (root.responsibilityDefinition as Record<string, unknown>).purpose,
    ).toBe("完成论文初稿");
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

  it("reuses the same commandId (and prj_ id) across transport-failure retries", async () => {
    const onSubmitted = vi.fn();
    const fetchMock = stubFetch(() => Promise.resolve(committed()));
    fetchMock.mockImplementationOnce(() =>
      Promise.reject(new Error("network down")),
    );
    render(<CreateProjectForm actor="human:root" onSubmitted={onSubmitted} />);
    fireEvent.change(screen.getByLabelText("项目名称"), {
      target: { value: "p1" },
    });
    fireEvent.change(screen.getByLabelText("根责任目标"), {
      target: { value: "o1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
    await waitFor(() => expect(screen.getByText("服务不可用")).toBeTruthy());
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(screen.getByText(/transport\/unavailable/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2));
    const first = readCall(fetchMock, 0).envelope;
    const second = readCall(fetchMock, 1).envelope;
    expect(second.commandId).toBe(first.commandId);
    expect((payloadOf(second) as Record<string, unknown>).projectId).toBe(
      (payloadOf(first) as Record<string, unknown>).projectId,
    );
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
    expect(screen.getByText(proposal.proposalId)).toBeTruthy();
    expect(screen.getByText(/revision 3/)).toBeTruthy();
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
    fireEvent.change(screen.getByLabelText("纠偏消息"), {
      target: { value: "先完成大纲再动笔" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送纠偏" }));
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
    fireEvent.change(screen.getByLabelText("纠偏消息"), {
      target: { value: "立即停止扩写，回到主题" },
    });
    fireEvent.change(screen.getByLabelText("severity"), {
      target: { value: "Critical" },
    });
    const submit = screen.getByRole("button", {
      name: "发送纠偏",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("确认紧急纠偏"));
    expect(
      (screen.getByRole("button", { name: "发送纠偏" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "发送纠偏" }));
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
  it("submits the frozen acceptance payload with a preallocated acp_ id", async () => {
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
    expect(String(payload.acceptanceId)).toMatch(/^acp_[0-9a-f-]{36}$/);
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
    expect(screen.getByText(/确认停止执行/).textContent).toContain("exe_42");
    expect(screen.getByText(/检索工作区/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(fetchMock.mock.calls.length).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "紧急停止执行" }));
    const confirmStop = screen.getByRole("button", {
      name: "确认停止",
    }) as HTMLButtonElement;
    expect(confirmStop.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("我确认要立即停止该执行"));
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
    fireEvent.click(screen.getByLabelText("我确认要立即停止该执行"));
    fireEvent.click(screen.getByRole("button", { name: "确认停止" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(1));
    await waitFor(() => expect(screen.getByText("服务不可用")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "确认停止" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2));
    const first = readCall(fetchMock, 0).envelope;
    const second = readCall(fetchMock, 1).envelope;
    expect(second.commandId).toBe(first.commandId);
    expect(payloadOf(second).executionId).toBe("exe_42");
  });
});

describe("GrantPermissionForm", () => {
  it("grants a catalog capability with the frozen scope format and issuer", async () => {
    const fetchMock = stubFetch(() => Promise.resolve(committed()));
    render(
      <GrantPermissionForm
        actor="human:admin"
        projectId="prj_1"
        onSubmitted={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("capability"), {
      target: { value: "RecordDecision" },
    });
    fireEvent.change(screen.getByLabelText(/target（可选）/), {
      target: { value: "ws_9" },
    });
    fireEvent.click(screen.getByRole("button", { name: "授予" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(1));
    const { envelope } = readCall(fetchMock);
    expect(envelope.commandType).toBe("GrantPermission");
    expect(envelope.actor).toBe("human:admin");
    const payload = payloadOf(envelope) as Record<string, unknown>;
    expect(payload.scope).toBe("RecordDecision@ws_9");
    expect(payload.issuer).toBe("human:admin");
    expect(payload.lifetime).toBe("PT1H");
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
    fireEvent.change(screen.getByLabelText("capability"), {
      target: { value: "__custom__" },
    });
    fireEvent.change(screen.getByLabelText(/自由输入/), {
      target: { value: "RegisterProjectTool" },
    });
    fireEvent.click(screen.getByRole("button", { name: "授予" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(1));
    const payload = payloadOf(readCall(fetchMock).envelope) as Record<
      string,
      unknown
    >;
    expect(payload.scope).toBe("RegisterProjectTool");
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
    fireEvent.change(screen.getByLabelText("选择 grant"), {
      target: { value: "pgr_2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
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
    expect(screen.getByText("无待撤销的授权")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "撤销" })).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(0);
  });
});
