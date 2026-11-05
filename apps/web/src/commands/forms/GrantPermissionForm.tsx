/**
 * W-08 — GrantPermission form (RHF + Zod). Frozen payload
 * CAPA v2 payload binds an explicit subject, capability, target and expiry;
 * `permissionGrantId`
 * caller-preallocated (`pgr_<uuid-v7>`) and held across retries;
 * **issuer = the current authenticated principal, UI read-only**
 * (W-00 proof ④ — no delegated issuance in Web v1).
 */
import type { FormEvent } from "react";
import { useRef, useState } from "react";
import { type Resolver, useForm } from "react-hook-form";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Field } from "../../components/Field.js";
import { HUMAN_ACTIONABLE_COMMANDS } from "../catalog.js";
import { grantPermissionSchema, zodResolver } from "../schemas.js";
import type { CommandReceiptView } from "../submitCommand.js";
import { useCommandSubmission } from "../useCommandSubmission.js";
import { uuidv7 } from "../uuid7.js";
import { FormFeedback } from "./FormFeedback.js";
import "./forms.css";

const CUSTOM = "__custom__";
const ASSIGN_WORK = "core.control.assign-work";

export const capabilityLabel = (capability: string): string =>
  ({
    CreateProject: "创建项目",
    RenameProject: "重命名项目",
    CloseProject: "归档项目",
    RecordDecision: "确认项目决策",
    ResolveControlApproval: "批准敏感操作",
    SteerWork: "调整工作方向",
    AcceptWorkOutcome: "验收工作成果",
    StopExecution: "停止当前运行",
    GrantPermission: "授予权限",
    RevokePermission: "撤销权限",
    SubmitHumanMessage: "发送消息",
    ResumeConversationResponse: "继续生成回复",
    CancelConversationResponse: "取消生成回复",
  })[capability] ?? capability;

type GrantValues = {
  subjectKind: "HumanPrincipal" | "WorkspaceAgent" | "Execution";
  subjectRef: string;
  capability: string;
  target: string;
  expiresAt: string;
};

export function GrantPermissionForm({
  actor,
  projectId,
  workspaceId,
  token,
  onSubmitted,
}: {
  readonly actor: string;
  readonly projectId: string;
  readonly workspaceId?: string | undefined;
  readonly token?: string | undefined;
  readonly onSubmitted: (receipt: CommandReceiptView) => void;
}) {
  const grantIdRef = useRef<string | null>(null);
  const handleSubmitted = (receipt: CommandReceiptView): void => {
    grantIdRef.current = null;
    onSubmitted(receipt);
  };
  const { state, submit } = useCommandSubmission({
    actor,
    token,
    onSubmitted: handleSubmitted,
  });
  const { handleSubmit, setValue, watch, formState } = useForm<GrantValues>({
    resolver: zodResolver(grantPermissionSchema) as Resolver<GrantValues>,
    defaultValues: {
      subjectKind: "HumanPrincipal",
      subjectRef: actor,
      capability: HUMAN_ACTIONABLE_COMMANDS[0],
      target: "",
      expiresAt: "",
    },
  });
  const [selection, setSelection] = useState<string>(
    HUMAN_ACTIONABLE_COMMANDS[0],
  );
  const [customCapability, setCustomCapability] = useState("");
  const target = watch("target");
  const subjectKind = watch("subjectKind");
  const subjectRef = watch("subjectRef");
  const expiresAt = watch("expiresAt");
  const effectiveCapability =
    selection === CUSTOM ? customCapability.trim() : selection;
  const automaticAssignWork =
    subjectKind === "WorkspaceAgent" &&
    effectiveCapability === ASSIGN_WORK &&
    workspaceId !== undefined;
  const submissionLocked =
    state.phase === "submitting" || state.phase === "transport-failed";
  const subjectLabel =
    subjectKind === "HumanPrincipal"
      ? "用户标识"
      : subjectKind === "WorkspaceAgent"
        ? "分工标识"
        : "运行标识";
  const doSubmit = (event?: FormEvent): void => {
    event?.preventDefault();
    if (effectiveCapability.length === 0) {
      setValue("capability", "");
      return;
    }
    setValue("capability", effectiveCapability);
    void handleSubmit((values) => {
      const permissionGrantId = grantIdRef.current ?? `pgr_${uuidv7()}`;
      grantIdRef.current = permissionGrantId;
      void submit("GrantPermission", projectId, {
        permissionGrantId,
        issuer: actor,
        subject:
          values.subjectKind === "HumanPrincipal"
            ? { _tag: "HumanPrincipal", principal: values.subjectRef.trim() }
            : values.subjectKind === "WorkspaceAgent"
              ? {
                  _tag: "WorkspaceAgent",
                  workspaceId: values.subjectRef.trim(),
                }
              : {
                  _tag: "Execution",
                  executionId: values.subjectRef.trim(),
                },
        capability: values.capability,
        target: automaticAssignWork
          ? workspaceId
          : values.target.trim().length === 0
            ? null
            : values.target.trim(),
        expiresAt:
          values.expiresAt.trim().length === 0
            ? null
            : new Date(values.expiresAt).toISOString(),
      });
    })();
  };
  return (
    <Card title="开放额外操作">
      <form className="arbor-command-form" onSubmit={doSubmit}>
        <Field
          control="select"
          label="开放给谁"
          disabled={submissionLocked}
          value={subjectKind}
          onChange={(next) => {
            setValue("subjectKind", next as GrantValues["subjectKind"]);
            setValue(
              "subjectRef",
              next === "WorkspaceAgent" ? (workspaceId ?? "") : actor,
            );
          }}
          options={[
            { value: "HumanPrincipal", label: "用户" },
            { value: "WorkspaceAgent", label: "自动分工" },
            { value: "Execution", label: "本次运行" },
          ]}
        />
        {subjectKind === "WorkspaceAgent" && workspaceId !== undefined ? (
          <p>当前项目分工</p>
        ) : (
          <Field
            control="input"
            label={subjectLabel}
            disabled={submissionLocked}
            placeholder={`输入${subjectLabel}`}
            value={subjectRef}
            onChange={(next) => setValue("subjectRef", next)}
          />
        )}
        <Field
          control="select"
          label="允许的操作"
          disabled={submissionLocked}
          value={selection}
          onChange={(next) => {
            setSelection(next);
          }}
          options={[
            { value: ASSIGN_WORK, label: "安排工作" },
            ...HUMAN_ACTIONABLE_COMMANDS.map((value) => ({
              value,
              label: capabilityLabel(value),
            })),
            { value: CUSTOM, label: "其他操作…" },
          ]}
        />
        {selection === CUSTOM ? (
          <Field
            control="input"
            label="操作名称"
            disabled={submissionLocked}
            placeholder="输入操作名称"
            value={customCapability}
            onChange={(next) => {
              setCustomCapability(next);
            }}
          />
        ) : null}
        <Field
          control="input"
          label="适用范围（可选）"
          disabled={submissionLocked}
          readOnly={automaticAssignWork}
          aria-readonly={automaticAssignWork}
          placeholder="留空表示整个项目"
          value={automaticAssignWork ? "当前项目分工" : target}
          onChange={(next) => {
            if (!automaticAssignWork) setValue("target", next);
          }}
        />
        <Field
          control="input"
          label="过期时间（可选）"
          disabled={submissionLocked}
          placeholder="留空表示持续有效"
          value={expiresAt}
          onChange={(next) => {
            setValue("expiresAt", next);
          }}
        />
        {formState.errors.expiresAt ? (
          <p className="arbor-command-error">
            {formState.errors.expiresAt.message}
          </p>
        ) : null}
        <FormFeedback state={state} onRetry={() => doSubmit()} />
        <Button
          variant="primary"
          type="submit"
          disabled={submissionLocked || effectiveCapability.length === 0}
        >
          开放操作
        </Button>
      </form>
    </Card>
  );
}
