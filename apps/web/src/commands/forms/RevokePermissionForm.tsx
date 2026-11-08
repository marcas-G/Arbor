/**
 * W-08 — RevokePermission form (RHF + Zod). Frozen payload
 * {permissionGrantId}; grant list comes from a structured source (settings
 * currently shows the empty state pending transport DTO enhancement).
 */
import type { FormEvent } from "react";
import { type Resolver, useForm } from "react-hook-form";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Empty } from "../../components/Empty.js";
import { Field } from "../../components/Field.js";
import { revokePermissionSchema, zodResolver } from "../schemas.js";
import type { CommandReceiptView } from "../submitCommand.js";
import { useCommandSubmission } from "../useCommandSubmission.js";
import { FormFeedback } from "./FormFeedback.js";
import { capabilityLabel } from "./GrantPermissionForm.js";
import "./forms.css";

export interface GrantListItem {
  readonly grantId: string;
  readonly principal: string;
  readonly commandType: string;
}

type RevokeValues = { permissionGrantId: string };

export function RevokePermissionForm({
  actor,
  projectId,
  grants,
  token,
  onSubmitted,
}: {
  readonly actor: string;
  readonly projectId: string;
  readonly grants: ReadonlyArray<GrantListItem>;
  readonly token?: string | undefined;
  readonly onSubmitted: (receipt: CommandReceiptView) => void;
}) {
  const { state, submit } = useCommandSubmission({
    actor,
    token,
    onSubmitted,
  });
  const { handleSubmit, setValue, watch } = useForm<RevokeValues>({
    resolver: zodResolver(revokePermissionSchema) as Resolver<RevokeValues>,
    defaultValues: { permissionGrantId: grants[0]?.grantId ?? "" },
  });
  const permissionGrantId = watch("permissionGrantId");
  const submissionLocked =
    state.phase === "submitting" || state.phase === "transport-failed";
  if (grants.length === 0) {
    return (
      <Card title="撤销额外操作">
        <Empty>暂无可撤销的授权</Empty>
      </Card>
    );
  }
  const doSubmit = (event?: FormEvent): void => {
    event?.preventDefault();
    void handleSubmit((values) =>
      submit("RevokePermission", projectId, {
        permissionGrantId: values.permissionGrantId,
      }),
    )();
  };
  return (
    <Card title="撤销额外操作">
      <form className="arbor-command-form" onSubmit={doSubmit}>
        <Field
          control="select"
          label="选择授权"
          disabled={submissionLocked}
          value={permissionGrantId}
          onChange={(next) => {
            setValue("permissionGrantId", next);
          }}
          options={grants.map((grant) => ({
            value: grant.grantId,
            label: `${grant.principal} · ${capabilityLabel(grant.commandType)}`,
          }))}
        />
        <FormFeedback state={state} onRetry={() => doSubmit()} />
        <Button variant="primary" type="submit" disabled={submissionLocked}>
          撤销授权
        </Button>
      </form>
    </Card>
  );
}
