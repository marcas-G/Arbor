import type { WorkspaceDetailRes } from "@arbor/api-contracts";
import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Field } from "../../components/Field.js";
import { decideSandboxPolicyPayloadFromCandidate } from "../sandbox-policy-selection.js";
import { sandboxPolicySelectionSchema } from "../schemas.js";
import type { CommandReceiptView } from "../submitCommand.js";
import { useCommandSubmission } from "../useCommandSubmission.js";
import { FormFeedback } from "./FormFeedback.js";

type CandidateRead = NonNullable<
  WorkspaceDetailRes["sandboxPolicyCandidateRead"]
>;

const profileLabel = (profile: "ReadOnly" | "WorkspaceWrite"): string =>
  profile === "ReadOnly" ? "只读隔离" : "工作区写入隔离";

const networkLabel = (mode: "Disabled" | "Restricted" | "Enabled"): string =>
  mode === "Disabled"
    ? "禁止网络"
    : mode === "Restricted"
      ? "指定网络目的地"
      : "允许网络（按策略约束）";

export function DecideSandboxPolicyForm({
  projectId,
  workspaceId,
  executionId,
  actor,
  token,
  candidateRead,
  onSubmitted,
  onStaleReceipt,
  onCandidateSelected,
}: {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly executionId: string;
  readonly actor: string;
  readonly token?: string | undefined;
  readonly candidateRead: CandidateRead;
  readonly onSubmitted: (receipt: CommandReceiptView) => void;
  readonly onStaleReceipt: () => void;
  readonly onCandidateSelected: () => void;
}) {
  const { state, submit } = useCommandSubmission({
    actor,
    token,
    onSubmitted,
  });
  const [candidateId, setCandidateId] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [networkDestinationsText, setNetworkDestinationsText] = useState("");
  const [trustedLocalConfirmed, setTrustedLocalConfirmed] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const staleNotified = useRef(false);
  const candidate = candidateRead.candidates.find(
    (item) => item.candidateId === candidateId,
  );
  const destinations = networkDestinationsText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const requiresRestrictedDestinations =
    candidate?.kind === "OsEnforced" && candidate.networkMode === "Restricted";

  useEffect(() => {
    if (
      state.rejection === "StaleSandboxPolicyInputs" &&
      !staleNotified.current
    ) {
      staleNotified.current = true;
      onStaleReceipt();
    }
  }, [onStaleReceipt, state.rejection]);

  const doSubmit = (event?: FormEvent): void => {
    event?.preventDefault();
    if (candidate === undefined) {
      setValidationError("请先明确选择一个策略");
      return;
    }
    const selection = sandboxPolicySelectionSchema.safeParse({
      candidateId,
      decisionExpiresAt: expiresAt,
      networkDestinations: destinations,
      trustedLocalConfirmed,
    });
    if (!selection.success) {
      setValidationError(selection.error.issues[0]?.message ?? "策略选择无效");
      return;
    }
    const mapped = decideSandboxPolicyPayloadFromCandidate({
      read: candidateRead,
      candidateId: selection.data.candidateId,
      projectId,
      workspaceId,
      executionId,
      decisionExpiresAt: selection.data.decisionExpiresAt,
      networkDestinations: selection.data.networkDestinations,
      trustedLocalConfirmed: selection.data.trustedLocalConfirmed,
    });
    if (mapped._tag !== "Ready") {
      setValidationError(
        mapped.reason === "TrustedLocalNeedsExplicitConfirmation"
          ? "TrustedLocal 是不受 OS 隔离的高风险选择，请先单独确认"
          : mapped.reason === "NetworkDestinationsInvalid"
            ? "Restricted 网络策略至少需要一个目的地；其他模式不接受目的地"
            : "候选已不属于当前读取结果，请刷新后重新选择",
      );
      return;
    }
    setValidationError(null);
    void submit("DecideSandboxPolicy", projectId, mapped.payload);
  };

  return (
    <Card title="选择执行沙箱策略">
      <form className="arbor-command-form" onSubmit={doSubmit}>
        <p>
          请选择一个候选。选择只提交现有策略命令，不会启动执行或探测提供方。
        </p>
        <fieldset className="arbor-sandbox-candidate-list">
          <legend>可用策略</legend>
          {candidateRead.candidates.map((item) => {
            const label =
              item.kind === "TrustedLocalUnconfinedV1"
                ? "TrustedLocal：FullAccess，不受 OS 隔离"
                : `${profileLabel(item.profile)} · ${item.providerId} ${item.providerVersion} · capability ${item.capabilityRevision} · ${networkLabel(item.networkMode)}`;
            return (
              <label className="arbor-command-check" key={item.candidateId}>
                <input
                  type="radio"
                  name="sandbox-policy-candidate"
                  value={item.candidateId}
                  checked={candidateId === item.candidateId}
                  onChange={() => {
                    setCandidateId(item.candidateId);
                    setTrustedLocalConfirmed(false);
                    setNetworkDestinationsText("");
                    setValidationError(null);
                    onCandidateSelected();
                  }}
                />
                {label}
              </label>
            );
          })}
        </fieldset>
        {candidate?.kind === "TrustedLocalUnconfinedV1" ? (
          <label className="arbor-command-check">
            <input
              type="checkbox"
              checked={trustedLocalConfirmed}
              onChange={(event) =>
                setTrustedLocalConfirmed(event.currentTarget.checked)
              }
            />
            我了解 TrustedLocal 不提供 OS 隔离、按 FullAccess
            运行，并明确选择此高风险策略
          </label>
        ) : null}
        {requiresRestrictedDestinations ? (
          <Field
            control="textarea"
            label="Restricted 网络目的地（每行一个 HTTPS origin）"
            value={networkDestinationsText}
            onChange={setNetworkDestinationsText}
            placeholder="https://service.example"
          />
        ) : candidate?.kind === "OsEnforced" &&
          candidate.networkMode === "Enabled" ? (
          <p>此候选启用网络访问；具体访问仍受已绑定的网络边界策略约束。</p>
        ) : null}
        <Field
          control="input"
          label="策略过期时间（ISO 8601，需包含时区）"
          value={expiresAt}
          onChange={setExpiresAt}
          placeholder="2030-01-01T00:00:00Z"
        />
        {validationError === null ? null : (
          <p role="alert" className="arbor-form-error">
            {validationError}
          </p>
        )}
        <FormFeedback state={state} onRetry={() => doSubmit()} />
        {state.rejection === "StaleSandboxPolicyInputs" ? (
          <p role="status">策略输入已变化，正在重新读取；请重新选择候选。</p>
        ) : null}
        <div className="arbor-command-actions">
          <Button
            type="submit"
            disabled={
              candidate === undefined ||
              expiresAt.length === 0 ||
              (candidate.kind === "TrustedLocalUnconfinedV1" &&
                !trustedLocalConfirmed) ||
              (requiresRestrictedDestinations && destinations.length === 0) ||
              state.phase === "submitting"
            }
          >
            明确提交此策略
          </Button>
        </div>
      </form>
    </Card>
  );
}
