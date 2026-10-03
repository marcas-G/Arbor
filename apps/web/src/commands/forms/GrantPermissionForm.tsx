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
import { Mono } from "../../views/shared.js";
import { HUMAN_ACTIONABLE_COMMANDS } from "../catalog.js";
import { grantPermissionSchema, zodResolver } from "../schemas.js";
import type { CommandReceiptView } from "../submitCommand.js";
import { useCommandSubmission } from "../useCommandSubmission.js";
import { uuidv7 } from "../uuid7.js";
import { FormFeedback } from "./FormFeedback.js";
import "./forms.css";

const CUSTOM = "__custom__";

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
  token,
  onSubmitted,
}: {
  readonly actor: string;
  readonly projectId: string;
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
        target: values.target.trim().length === 0 ? null : values.target.trim(),
        expiresAt:
          values.expiresAt.trim().length === 0
            ? null
            : new Date(values.expiresAt).toISOString(),
      });
    })();
  };
  return (
    <Card title="授予权限（GrantPermission）">
      <form className="arbor-command-form" onSubmit={doSubmit}>
        <Field
          control="select"
          label="授权主体类型"
          value={subjectKind}
          onChange={(next) => {
            setValue("subjectKind", next as GrantValues["subjectKind"]);
          }}
          options={[
            { value: "HumanPrincipal", label: "用户 Principal" },
            { value: "WorkspaceAgent", label: "工作区 Agent" },
            { value: "Execution", label: "单次 Execution" },
          ]}
        />
        <Field
          control="input"
          label="授权主体"
          placeholder="user:… / ws_… / exe_…"
          value={subjectRef}
          onChange={(next) => setValue("subjectRef", next)}
        />
        <Field
          control="select"
          label="capability"
          value={selection}
          onChange={(next) => {
            setSelection(next);
          }}
          options={[
            ...HUMAN_ACTIONABLE_COMMANDS.map((value) => ({
              value,
              label: value,
            })),
            { value: CUSTOM, label: "自定义…" },
          ]}
        />
        {selection === CUSTOM ? (
          <Field
            control="input"
            label="capability（自由输入）"
            placeholder="capability 名"
            value={customCapability}
            onChange={(next) => {
              setCustomCapability(next);
            }}
          />
        ) : null}
        <Field
          control="input"
          label="target（可选）"
          placeholder="如 ws_…；留空 = 不限目标"
          value={target}
          onChange={(next) => {
            setValue("target", next);
          }}
        />
        <Field
          control="input"
          label="过期时间（可选）"
          placeholder="2026-10-04T00:00:00Z；留空 = 直到撤销"
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
        <p className="arbor-command-static">
          issuer（签发者，只读）：<Mono>{actor}</Mono>
        </p>
        <FormFeedback state={state} onRetry={() => doSubmit()} />
        <Button
          variant="primary"
          type="submit"
          disabled={
            state.phase === "submitting" || effectiveCapability.length === 0
          }
        >
          授予
        </Button>
      </form>
    </Card>
  );
}
