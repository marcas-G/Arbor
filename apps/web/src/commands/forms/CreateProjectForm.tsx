/**
 * W-08 — CreateProject form (RHF + Zod over the two user inputs). The full
 * frozen payload is assembled with caller-preallocated prj_/ws_/ses_
 * uuid-v7 ids (DID §4.1 single-transaction bootstrap; ids held across
 * retries like the commandId).
 */
import type { FormEvent } from "react";
import { useRef } from "react";
import { type Resolver, useForm } from "react-hook-form";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Field } from "../../components/Field.js";
import { createProjectSchema, zodResolver } from "../schemas.js";
import type { CommandReceiptView } from "../submitCommand.js";
import { useCommandSubmission } from "../useCommandSubmission.js";
import { uuidv7 } from "../uuid7.js";
import { FormFeedback } from "./FormFeedback.js";
import "./forms.css";

type CreateValues = { name: string };

export function CreateProjectForm({
  actor,
  token,
  onSubmitted,
  embedded = false,
}: {
  readonly actor: string;
  readonly token?: string | undefined;
  readonly onSubmitted: (receipt: CommandReceiptView) => void;
  readonly embedded?: boolean | undefined;
}) {
  const idsRef = useRef<{
    readonly projectId: string;
    readonly rootWorkspaceId: string;
    readonly sessionId: string;
  } | null>(null);
  const handleSubmitted = (receipt: CommandReceiptView): void => {
    idsRef.current = null;
    onSubmitted(receipt);
  };
  const { state, submit } = useCommandSubmission({
    actor,
    token,
    onSubmitted: handleSubmitted,
  });
  const { handleSubmit, setValue, watch, formState } = useForm<CreateValues>({
    resolver: zodResolver(createProjectSchema) as Resolver<CreateValues>,
    defaultValues: { name: "" },
  });
  const name = watch("name");
  const doSubmit = (event?: FormEvent): void => {
    event?.preventDefault();
    void handleSubmit((values) => {
      const ids = idsRef.current ?? {
        projectId: `prj_${uuidv7()}`,
        rootWorkspaceId: `ws_${uuidv7()}`,
        sessionId: `ses_${uuidv7()}`,
      };
      idsRef.current = ids;
      void submit("CreateProject", ids.projectId, {
        name: values.name,
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
          name: values.name,
          responsibilityDefinition: {
            purpose: values.name,
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
      });
    })();
  };
  const form = (
    <form className="arbor-command-form" onSubmit={doSubmit}>
      <Field
        control="input"
        label="项目名称"
        placeholder="例如：论文写作平台"
        value={name}
        onChange={(next) => {
          setValue("name", next);
        }}
      />
      {formState.errors.name ? (
        <p className="arbor-command-error">{formState.errors.name.message}</p>
      ) : null}
      <FormFeedback state={state} onRetry={() => doSubmit()} />
      <Button
        variant="primary"
        type="submit"
        disabled={state.phase === "submitting"}
      >
        创建项目
      </Button>
    </form>
  );
  return embedded ? form : <Card title="创建项目">{form}</Card>;
}
