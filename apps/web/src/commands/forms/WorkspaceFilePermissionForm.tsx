import { useRef, useState } from "react";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Field } from "../../components/Field.js";
import type { CommandReceiptView } from "../submitCommand.js";
import { useCommandSubmission } from "../useCommandSubmission.js";
import { uuidv7 } from "../uuid7.js";
import { FormFeedback } from "./FormFeedback.js";

type PermissionProps = {
  readonly actor: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly objective: string;
  readonly token?: string | undefined;
  readonly onSubmitted: (receipt: CommandReceiptView) => void;
};

export function WorkspaceFilePermissionForm(props: PermissionProps) {
  return <WorkspaceToolPermissionForm {...props} capability="fs:write" />;
}

export function WorkspaceCommandPermissionForm(props: PermissionProps) {
  return <WorkspaceToolPermissionForm {...props} capability="shell:exec" />;
}

/** A contextual projection of CAPA v2, with no editable subject or target. */
function WorkspaceToolPermissionForm({
  actor,
  projectId,
  workspaceId,
  objective,
  token,
  onSubmitted,
  capability,
}: PermissionProps & {
  readonly capability: "fs:write" | "shell:exec";
}) {
  const commands = capability === "shell:exec";
  const [hours, setHours] = useState("persistent");
  const grantId = useRef<string | null>(null);
  const { state, submit } = useCommandSubmission({
    actor,
    token,
    onSubmitted: (receipt) => {
      grantId.current = null;
      onSubmitted(receipt);
    },
  });
  const locked =
    state.phase === "submitting" || state.phase === "transport-failed";
  const doSubmit = (): void => {
    const duration = Number(hours);
    if (hours !== "persistent" && ![1, 8, 24].includes(duration)) return;
    const permissionGrantId = grantId.current ?? `pgr_${uuidv7()}`;
    grantId.current = permissionGrantId;
    void submit("GrantPermission", projectId, {
      permissionGrantId,
      issuer: actor,
      subject: { _tag: "WorkspaceAgent", workspaceId },
      capability,
      target: workspaceId,
      expiresAt:
        hours === "persistent"
          ? null
          : new Date(Date.now() + duration * 60 * 60 * 1000).toISOString(),
    });
  };
  return (
    <Card
      title={commands ? "允许当前分工执行项目命令" : "允许当前分工修改项目文件"}
    >
      <form
        className="flex flex-col gap-ui-3"
        onSubmit={(event) => {
          event.preventDefault();
          doSubmit();
        }}
      >
        <p>{objective}</p>
        {commands ? (
          <p>
            允许承担这项工作的当前分工申请运行项目命令。实际执行仍需通过已安装的
            隔离环境、执行策略及具体命令审批；此授权不会开放其他分工或其他目录。
          </p>
        ) : (
          <p>
            允许承担这项工作的当前分工，在已有项目资源边界内创建和修改文件。
            此授权不开放其他目录、其他分工或命令执行。
          </p>
        )}
        <p>
          持续授权适用于此工作区后续任务，重启后保留，可随时撤销；具体敏感操作仍需单独审批。
        </p>
        <Field
          control="select"
          label={commands ? "命令执行权限有效期" : "文件修改权限有效期"}
          disabled={locked}
          value={hours}
          onChange={setHours}
          options={[
            { value: "persistent", label: "持续有效，直到撤销" },
            { value: "1", label: "1 小时" },
            { value: "8", label: "8 小时" },
            { value: "24", label: "24 小时" },
          ]}
        />
        <FormFeedback state={state} onRetry={doSubmit} />
        {state.phase === "committed" ? (
          <p role="status">
            {commands ? "命令权限已授予。" : "文件权限已授予。"}
            点击“调整方向”，提供继续工作的说明；授权本身不会自动重试被拒绝的操作。
          </p>
        ) : null}
        <Button variant="primary" type="submit" disabled={locked}>
          {commands ? "授权执行项目命令" : "授权修改项目文件"}
        </Button>
      </form>
    </Card>
  );
}
