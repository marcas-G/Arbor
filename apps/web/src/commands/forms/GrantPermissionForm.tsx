/**
 * W-08 — GrantPermission form (RHF + Zod). Frozen payload
 * {permissionGrantId, scope, issuer, lifetime}; scope is the frozen
 * `capability@target` format (P12 `02`); `permissionGrantId`
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
  capability: string;
  target: string;
  lifetime: string;
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
      capability: HUMAN_ACTIONABLE_COMMANDS[0],
      target: "",
      lifetime: "PT1H",
    },
  });
  const [selection, setSelection] = useState<string>(
    HUMAN_ACTIONABLE_COMMANDS[0],
  );
  const [customCapability, setCustomCapability] = useState("");
  const target = watch("target");
  const lifetime = watch("lifetime");
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
      const scope =
        values.target.trim().length === 0
          ? values.capability
          : `${values.capability}@${values.target.trim()}`;
      void submit("GrantPermission", projectId, {
        permissionGrantId,
        scope,
        issuer: actor,
        lifetime:
          values.lifetime.trim().length === 0 ? "PT1H" : values.lifetime.trim(),
      });
    })();
  };
  return (
    <Card title="授予权限（GrantPermission）">
      <form className="arbor-command-form" onSubmit={doSubmit}>
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
          label="lifetime"
          placeholder="如 PT1H"
          value={lifetime}
          onChange={(next) => {
            setValue("lifetime", next);
          }}
        />
        {formState.errors.lifetime ? (
          <p className="arbor-command-error">
            {formState.errors.lifetime.message}
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
