/**
 * P13 `02` §2 GrantPermission — admin 表单（P12 `02` §5 PermissionGrant
 * governance）。principal + 被授权 commandType（选项来自 catalog 七项暴露
 * 集合 + 自由输入——payload.commandType 是 grant 数据，不受表单自身
 * commandType 的暴露约束）；scope 冻结为 "project"。
 */

import type { FormEvent } from "react";
import { useState } from "react";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Field } from "../../components/Field.js";
import { HUMAN_ACTIONABLE_COMMANDS } from "../catalog.js";
import type { CommandReceiptView } from "../submitCommand.js";
import { useCommandSubmission } from "../useCommandSubmission.js";
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
  const [principal, setPrincipal] = useState("");
  const [selection, setSelection] = useState<string>(
    HUMAN_ACTIONABLE_COMMANDS[0],
  );
  const [customCommandType, setCustomCommandType] = useState("");
  const { state, submit } = useCommandSubmission({
    actor,
    token,
    onSubmitted,
  });
  const commandType =
    selection === CUSTOM ? customCommandType.trim() : selection;
  const doSubmit = (event?: FormEvent): void => {
    event?.preventDefault();
    void submit("GrantPermission", projectId, {
      principal: principal.trim(),
      commandType,
      scope: "project",
    });
  };
  return (
    <Card title="授予权限（GrantPermission）">
      <form className="arbor-command-form" onSubmit={doSubmit}>
        <Field
          control="input"
          label="principal"
          placeholder="被授权主体"
          value={principal}
          onChange={setPrincipal}
        />
        <Field
          control="select"
          label="commandType"
          value={selection}
          onChange={setSelection}
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
            label="commandType（自由输入）"
            placeholder="任意 wire 级 commandType"
            value={customCommandType}
            onChange={setCustomCommandType}
          />
        ) : null}
        <Field
          control="input"
          label="边界（scope）"
          value="project"
          disabled
          onChange={() => {}}
        />
        <FormFeedback state={state} onRetry={() => doSubmit()} />
        <Button
          variant="primary"
          type="submit"
          disabled={
            state.phase === "submitting" ||
            principal.trim() === "" ||
            commandType === ""
          }
        >
          授予
        </Button>
      </form>
    </Card>
  );
}
