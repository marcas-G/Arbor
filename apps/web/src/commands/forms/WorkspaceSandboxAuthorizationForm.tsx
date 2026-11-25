import type { WorkspaceDetailRes } from "@arbor/api-contracts";
import { useState } from "react";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Field } from "../../components/Field.js";
import type { CommandReceiptView } from "../submitCommand.js";
import { useCommandSubmission } from "../useCommandSubmission.js";
import { FormFeedback } from "./FormFeedback.js";

type Candidate = NonNullable<
  WorkspaceDetailRes["sandboxPolicyCandidateRead"]
>["candidates"][number];
const canonicalDestinations = (text: string): string[] | undefined => {
  try {
    const values = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const url = new URL(line);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.pathname !== "/" ||
          url.search ||
          url.hash
        )
          throw new Error("HTTPS origin required");
        return url.origin;
      });
    return values.length > 0 && values.length <= 64
      ? [...new Set(values)].sort()
      : undefined;
  } catch {
    return undefined;
  }
};

type AuthorizationRead = NonNullable<
  WorkspaceDetailRes["workspaceSandboxAuthorization"]
>;

export function WorkspaceSandboxAuthorizationForm({
  projectId,
  workspaceId,
  actor,
  token,
  authorization,
  candidateRead,
  onSubmitted,
}: {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly actor: string;
  readonly token?: string | undefined;
  readonly authorization: AuthorizationRead;
  readonly candidateRead?: WorkspaceDetailRes["sandboxPolicyCandidateRead"];
  readonly onSubmitted: (receipt: CommandReceiptView) => void;
}) {
  const { state, submit } = useCommandSubmission({ actor, token, onSubmitted });
  const [candidateId, setCandidateId] = useState("");
  const [duration, setDuration] = useState("persistent");
  const [destinationsText, setDestinationsText] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<"authorize" | "revoke">(
    "authorize",
  );
  const locked =
    state.phase === "submitting" || state.phase === "transport-failed";
  const candidates =
    candidateRead?.candidates.filter(
      (candidate): candidate is Extract<Candidate, { kind: "OsEnforced" }> =>
        candidate.kind === "OsEnforced" &&
        candidate.providerId === "linux-bwrap",
    ) ?? [];
  const candidate = candidates.find((item) => item.candidateId === candidateId);
  if (authorization.current === null) {
    return (
      <Card title="工作区执行环境">
        <p role="status">
          系统尚未为此工作区建立默认的 Linux
          隔离执行环境。请先安装或修复环境；不能通过手工授权绕过环境资格检查。
        </p>
      </Card>
    );
  }
  const send = (action: "authorize" | "revoke") => {
    setLastAction(action);
    if (action === "revoke") {
      void submit("RevokeWorkspaceSandboxAuthorization", projectId, {
        workspaceId,
        expectedAuthorizationRevision:
          authorization.expectedAuthorizationRevision,
      });
      return;
    }
    if (candidate === undefined) {
      setValidationError("请先选择当前可用的隔离环境");
      return;
    }
    const destinations =
      candidate.networkMode === "Restricted"
        ? canonicalDestinations(destinationsText)
        : [];
    if (destinations === undefined) {
      setValidationError(
        "请填写有效的 HTTPS 地址，每行一个，不含路径或登录信息",
      );
      return;
    }
    const networkPolicy = {
      version: 1,
      mode: candidate.networkMode,
      destinations,
    };
    setValidationError(null);
    void submit("AuthorizeWorkspaceSandbox", projectId, {
      workspaceId,
      expectedAuthorizationRevision:
        authorization.expectedAuthorizationRevision,
      expectedResourceBoundaryRevision: authorization.resourceBoundaryRevision,
      expectedWorkspacePolicyRevision: authorization.workspacePolicyRevision,
      profile: candidate.profile,
      providerId: candidate.providerId,
      networkPolicy,
      expiresAt:
        duration === "persistent"
          ? null
          : new Date(Date.now() + Number(duration) * 3_600_000).toISOString(),
      source: { kind: "Human" },
    });
  };
  return (
    <Card title="工作区执行环境授权">
      <form
        className="flex flex-col gap-ui-3"
        onSubmit={(event) => {
          event.preventDefault();
          send("authorize");
        }}
      >
        <p>
          授权只适用于这个工作区的资源范围，对后续任务和重启持续有效。具体命令的审批仍单独处理。
        </p>
        {authorization.current?.state === "Granted" ? (
          <p>
            已保存执行环境授权。可撤销；撤销后 Parent
            不能重新授予，只有你能恢复。
          </p>
        ) : authorization.current?.state === "Revoked" ? (
          <p role="status">
            你已撤销此工作区的执行环境授权。只有你重新授权才能恢复。
          </p>
        ) : (
          <p>尚未授予执行环境权限。</p>
        )}
        {candidates.length === 0 ? (
          <p role="status">
            当前没有可用的 Linux 隔离环境候选；请先完成安装或修复。
          </p>
        ) : null}
        <Field
          control="select"
          label="隔离环境"
          value={candidateId}
          onChange={setCandidateId}
          disabled={locked}
          options={[
            { value: "", label: "请选择隔离环境" },
            ...candidates.map((item) => ({
              value: item.candidateId,
              label: `${item.profile === "WorkspaceWrite" ? "允许修改工作区" : "只读工作区"} · ${item.networkMode === "Enabled" ? "允许联网" : item.networkMode === "Restricted" ? "指定联网地址" : "禁止联网"}`,
            })),
          ]}
        />
        {candidate?.networkMode === "Restricted" ? (
          <Field
            control="textarea"
            label="允许访问的 HTTPS 地址（每行一个）"
            value={destinationsText}
            onChange={setDestinationsText}
            disabled={locked}
          />
        ) : null}
        <Field
          control="select"
          label="执行环境授权有效期"
          value={duration}
          onChange={setDuration}
          disabled={locked}
          options={[
            { value: "persistent", label: "持续有效，直到撤销" },
            { value: "1", label: "1 小时" },
            { value: "8", label: "8 小时" },
            { value: "24", label: "24 小时" },
          ]}
        />
        <Button type="submit" disabled={locked || candidate === undefined}>
          授权此工作区使用
        </Button>
        {authorization.current?.state === "Granted" ? (
          <Button
            type="button"
            variant="quiet"
            disabled={locked}
            onClick={() => send("revoke")}
          >
            撤销执行环境授权
          </Button>
        ) : null}
        {validationError === null ? null : (
          <p role="alert">{validationError}</p>
        )}
        <FormFeedback state={state} onRetry={() => send(lastAction)} />
      </form>
    </Card>
  );
}
