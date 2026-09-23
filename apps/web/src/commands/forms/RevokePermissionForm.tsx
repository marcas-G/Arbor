/**
 * P13 `02` §2 RevokePermission — admin 表单：从现存 grant 列表中选择一个
 * 撤销（P12 `02` §5；payload 只携带所选 grantId）。
 */

import type { FormEvent } from "react";
import { useState } from "react";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Empty } from "../../components/Empty.js";
import { Field } from "../../components/Field.js";
import type { CommandReceiptView } from "../submitCommand.js";
import { useCommandSubmission } from "../useCommandSubmission.js";
import { FormFeedback } from "./FormFeedback.js";
import "./forms.css";

export interface PermissionGrantOption {
  readonly grantId: string;
  readonly principal: string;
  readonly commandType: string;
}

export function RevokePermissionForm({
  actor,
  projectId,
  grants,
  token,
  onSubmitted,
}: {
  readonly actor: string;
  readonly projectId: string;
  readonly grants: ReadonlyArray<PermissionGrantOption>;
  readonly token?: string | undefined;
  readonly onSubmitted: (receipt: CommandReceiptView) => void;
}) {
  const [grantId, setGrantId] = useState(grants[0]?.grantId ?? "");
  const { state, submit } = useCommandSubmission({
    actor,
    token,
    onSubmitted,
  });
  const doSubmit = (event?: FormEvent): void => {
    event?.preventDefault();
    void submit("RevokePermission", projectId, { grantId });
  };
  return (
    <Card title="撤销权限（RevokePermission）">
      {grants.length === 0 ? (
        <Empty>无待撤销的授权</Empty>
      ) : (
        <form className="arbor-command-form" onSubmit={doSubmit}>
          <Field
            control="select"
            label="选择 grant"
            value={grantId}
            onChange={setGrantId}
            options={grants.map((grant) => ({
              value: grant.grantId,
              label: `${grant.principal} · ${grant.commandType}`,
            }))}
          />
          <FormFeedback state={state} onRetry={() => doSubmit()} />
          <Button
            variant="primary"
            type="submit"
            disabled={
              state.phase === "submitting" ||
              grantId === "" ||
              !grants.some((grant) => grant.grantId === grantId)
            }
          >
            撤销
          </Button>
        </form>
      )}
    </Card>
  );
}
