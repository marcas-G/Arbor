import { useState } from "react";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Field } from "../../components/Field.js";
import type { CommandReceiptView } from "../submitCommand.js";
import { useCommandSubmission } from "../useCommandSubmission.js";
import { FormFeedback } from "./FormFeedback.js";
import "./forms.css";

function assignmentSummary(summary: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(summary);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return null;
    const record = value as Record<string, unknown>;
    return record.action === "AssignWork" &&
      typeof record.objective === "string"
      ? record
      : null;
  } catch {
    return null;
  }
}

export function approvalTitle(summary: string): string {
  const assignment = assignmentSummary(summary);
  return assignment === null
    ? summary
    : `安排工作：${assignment.objective as string}`;
}

function ApprovalSummary({
  summary,
  workspaceId,
  workspaceNames,
}: {
  readonly summary: string;
  readonly workspaceId?: string | undefined;
  readonly workspaceNames?: ReadonlyMap<string, string> | undefined;
}) {
  const assignment = assignmentSummary(summary);
  if (assignment === null) return <p>{summary}</p>;
  const target = assignment.targetWorkspaceId;
  const targetName =
    typeof target === "string"
      ? workspaceNames?.get(target === "current" ? (workspaceId ?? "") : target)
      : undefined;
  const mission = assignment.verificationMission;
  const missionRecord =
    typeof mission === "object" && mission !== null && !Array.isArray(mission)
      ? (mission as Record<string, unknown>)
      : null;
  const fields = [
    ["工作目标", assignment.objective],
    ["原因", assignment.why],
    ["约束", assignment.constraints],
    ["完成标准", assignment.completionExpectation],
  ] as const;
  return (
    <>
      <p>工作交给：{targetName ?? "目标名称暂不可确认，请查看完整请求详情"}</p>
      <dl>
        {fields
          .filter(([, value]) => value !== undefined && value !== null)
          .map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                {Array.isArray(value) &&
                value.every((entry) => typeof entry === "string") ? (
                  value.length === 0 ? (
                    "无"
                  ) : (
                    <ul>
                      {value.map((entry) => (
                        <li key={entry}>{entry}</li>
                      ))}
                    </ul>
                  )
                ) : typeof value === "string" ? (
                  value
                ) : (
                  JSON.stringify(value)
                )}
              </dd>
            </div>
          ))}
      </dl>
      {missionRecord !== null && typeof missionRecord.goal === "string" ? (
        <section aria-label="验证要求">
          <h3>验证要求</h3>
          <p>{missionRecord.goal}</p>
          {Array.isArray(missionRecord.criteria) ? (
            <ul>
              {missionRecord.criteria.map((criterion: unknown) => {
                if (
                  typeof criterion !== "object" ||
                  criterion === null ||
                  !("requirement" in criterion) ||
                  typeof criterion.requirement !== "string"
                )
                  return null;
                return (
                  <li
                    key={
                      "criterionId" in criterion &&
                      typeof criterion.criterionId === "string"
                        ? criterion.criterionId
                        : criterion.requirement
                    }
                  >
                    {criterion.requirement}
                    {"required" in criterion && criterion.required === true
                      ? "（必须）"
                      : ""}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {Array.isArray(missionRecord.riskRequirements) &&
          missionRecord.riskRequirements.every(
            (risk) => typeof risk === "string",
          ) &&
          missionRecord.riskRequirements.length > 0 ? (
            <>
              <p>风险要求</p>
              <ul>
                {missionRecord.riskRequirements.map((risk: string) => (
                  <li key={risk}>{risk}</li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : mission == null ? null : (
        <p>验证要求：{JSON.stringify(mission)}</p>
      )}
      <details>
        <summary>完整请求详情</summary>
        <pre>{summary}</pre>
      </details>
    </>
  );
}

export function ResolveControlApprovalForm({
  actor,
  projectId,
  approvalId,
  approvalRevision,
  summary,
  workspaceId,
  workspaceNames,
  token,
  onSubmitted,
}: {
  readonly actor: string;
  readonly projectId: string;
  readonly approvalId: string;
  readonly approvalRevision: number;
  readonly summary: string;
  readonly workspaceId?: string | undefined;
  readonly workspaceNames?: ReadonlyMap<string, string> | undefined;
  readonly token?: string | undefined;
  readonly onSubmitted: (receipt: CommandReceiptView) => void;
}) {
  const [decision, setDecision] = useState<"Approve" | "Reject">("Approve");
  const [reason, setReason] = useState("");
  const { state, submit } = useCommandSubmission({
    actor,
    token,
    onSubmitted,
  });
  const doSubmit = (): void => {
    void submit("ResolveControlApproval", projectId, {
      approvalId,
      expectedRevision: approvalRevision,
      decision,
      reason: reason.trim().length === 0 ? null : reason.trim(),
    });
  };
  return (
    <Card title="操作审批">
      <div className="arbor-command-form">
        <ApprovalSummary
          summary={summary}
          workspaceId={workspaceId}
          workspaceNames={workspaceNames}
        />
        <Field
          control="select"
          label="审批决定"
          disabled={
            state.phase === "submitting" || state.phase === "transport-failed"
          }
          value={decision}
          onChange={(next) => setDecision(next as "Approve" | "Reject")}
          options={[
            { value: "Approve", label: "批准本次操作" },
            { value: "Reject", label: "拒绝" },
          ]}
        />
        <Field
          control="textarea"
          label="原因（可选）"
          disabled={
            state.phase === "submitting" || state.phase === "transport-failed"
          }
          value={reason}
          onChange={setReason}
        />
        <FormFeedback state={state} onRetry={doSubmit} />
        <Button
          variant={decision === "Approve" ? "primary" : "danger"}
          type="button"
          disabled={
            state.phase === "submitting" || state.phase === "transport-failed"
          }
          onClick={doSubmit}
        >
          {decision === "Approve" ? "批准并继续" : "拒绝动作"}
        </Button>
      </div>
    </Card>
  );
}
