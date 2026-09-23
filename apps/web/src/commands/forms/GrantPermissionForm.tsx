/**
 * P13 `02` §2 GrantPermission — admin grant form. Frozen payload =
 * {permissionGrantId, scope, issuer, lifetime}; scope is the frozen
 * `capability@target` grant-scope format (P12 `02`); `permissionGrantId` is
 * caller-preallocated (`pgr_<uuid-v7>`) and held across retries; issuer is
 * the acting principal (the server resolver remains the sole enforcement).
 */
import type { FormEvent } from "react";
import { useRef, useState } from "react";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Field } from "../../components/Field.js";
import { HUMAN_ACTIONABLE_COMMANDS } from "../catalog.js";
import type { CommandReceiptView } from "../submitCommand.js";
import { useCommandSubmission } from "../useCommandSubmission.js";
import { uuidv7 } from "../uuid7.js";
import { FormFeedback } from "./FormFeedback.js";
import "./forms.css";

const CUSTOM = "__custom__";

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
  const [capability, setCapability] = useState<string>(
    HUMAN_ACTIONABLE_COMMANDS[0],
  );
  const [customCapability, setCustomCapability] = useState("");
  const [target, setTarget] = useState("");
  const [lifetime, setLifetime] = useState("PT1H");
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
  const effectiveCapability =
    capability === CUSTOM ? customCapability.trim() : capability;
  const doSubmit = (event?: FormEvent): void => {
    event?.preventDefault();
    if (effectiveCapability.length === 0) {
      return;
    }
    const permissionGrantId = grantIdRef.current ?? `pgr_${uuidv7()}`;
    grantIdRef.current = permissionGrantId;
    const scope =
      target.trim().length === 0
        ? effectiveCapability
        : `${effectiveCapability}@${target.trim()}`;
    void submit("GrantPermission", projectId, {
      permissionGrantId,
      scope,
      issuer: actor,
      lifetime: lifetime.trim().length === 0 ? "PT1H" : lifetime.trim(),
    });
  };
  return (
    <Card title="授予权限（GrantPermission）">
      <form className="arbor-command-form" onSubmit={doSubmit}>
        <Field
          control="select"
          label="capability"
          value={capability}
          onChange={(next) => setCapability(next)}
          options={[
            ...HUMAN_ACTIONABLE_COMMANDS.map((value) => ({
              value,
              label: value,
            })),
            { value: CUSTOM, label: "自定义…" },
          ]}
        />
        {capability === CUSTOM ? (
          <Field
            control="input"
            label="capability（自由输入）"
            placeholder="capability 名"
            value={customCapability}
            onChange={setCustomCapability}
          />
        ) : null}
        <Field
          control="input"
          label="target（可选）"
          placeholder="如 ws_…；留空 = 不限目标"
          value={target}
          onChange={setTarget}
        />
        <Field
          control="input"
          label="lifetime"
          placeholder="如 PT1H"
          value={lifetime}
          onChange={setLifetime}
        />
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
