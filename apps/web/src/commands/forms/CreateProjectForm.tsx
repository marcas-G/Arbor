/**
 * P13 `02` §2 CreateProject — bootstrap form（项目名 / 根责任定义）。
 * Caller-preallocated ID 约定：CreateProject 是 single-transaction bootstrap
 * （DID §4.1），payload 必须携带 client 预分配的 projectId
 * （`prj_<uuid-v7>`，server 是其接受与否的权威）。预分配 id 与 commandId
 * 一样被表单持有：transport 失败重试复用同一 id；收到 Committed 后释放。
 */

import type { FormEvent } from "react";
import { useRef, useState } from "react";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Field } from "../../components/Field.js";
import type { CommandReceiptView } from "../submitCommand.js";
import { useCommandSubmission } from "../useCommandSubmission.js";
import { uuidv7 } from "../uuid7.js";
import { FormFeedback } from "./FormFeedback.js";
import "./forms.css";

export function CreateProjectForm({
  actor,
  token,
  onSubmitted,
}: {
  readonly actor: string;
  readonly token?: string | undefined;
  readonly onSubmitted: (receipt: CommandReceiptView) => void;
}) {
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const idsRef = useRef<{
    readonly projectId: string;
    readonly rootWorkspaceId: string;
    readonly sessionId: string;
  } | null>(null);
  const handleSubmitted = (receipt: CommandReceiptView): void => {
    idsRef.current = null;
    setName("");
    setObjective("");
    onSubmitted(receipt);
  };
  const { state, submit } = useCommandSubmission({
    actor,
    token,
    onSubmitted: handleSubmitted,
  });
  const doSubmit = (event?: FormEvent): void => {
    event?.preventDefault();
    const ids = idsRef.current ?? {
      projectId: `prj_${uuidv7()}`,
      rootWorkspaceId: `ws_${uuidv7()}`,
      sessionId: `ses_${uuidv7()}`,
    };
    idsRef.current = ids;
    const payload = {
      projectId: ids.projectId,
      name,
      revision: 0,
      projectPolicy: {},
      projectPolicyRevision: 0,
      defaultConfiguration: {},
      environmentRef: "local",
      rootWorkspaceId: ids.rootWorkspaceId,
      primarySession: {
        sessionId: ids.sessionId,
        contextEpoch: 0,
      },
      rootWorkspace: {
        name,
        responsibilityDefinition: {
          purpose: objective,
          ownedResponsibilities: [],
          obligations: [],
          includes: [],
          excludes: [],
          interfaces: [],
        },
        responsibilityRevision: 0,
        resourceBoundary: {
          basisResponsibilityRevision: 0,
          addresses: [],
        },
        resourceBoundaryRevision: 0,
        agentBinding: {
          _tag: "ResponsibilityBoundAgentBinding",
          workspaceId: ids.rootWorkspaceId,
        },
        workspacePolicy: {},
        workspacePolicyRevision: 0,
        revision: 0,
      },
    };
    void submit("CreateProject", ids.projectId, payload);
  };
  return (
    <Card title="创建项目">
      <form className="arbor-command-form" onSubmit={doSubmit}>
        <Field
          control="input"
          label="项目名称"
          placeholder="例如：论文写作平台"
          value={name}
          onChange={setName}
        />
        <Field
          control="textarea"
          label="根责任目标（rootObjective）"
          placeholder="根工作区的责任定义"
          rows={3}
          value={objective}
          onChange={setObjective}
        />
        <FormFeedback state={state} onRetry={() => doSubmit()} />
        <Button
          variant="primary"
          type="submit"
          disabled={state.phase === "submitting"}
        >
          创建项目
        </Button>
      </form>
    </Card>
  );
}
