/**
 * W-08 — CreateProject form (RHF + Zod over the two user inputs). The full
 * frozen payload is assembled with caller-preallocated prj_/ws_/ses_
 * uuid-v7 ids (DID §4.1 single-transaction bootstrap; ids held across
 * retries like the commandId).
 */
import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Resolver, useForm } from "react-hook-form";
import type { ProjectResourceCatalog } from "../../api/transport.js";
import { fetchProjectResources } from "../../api/transport.js";
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

type ResourceSelection =
  | {
      readonly _tag: "Profile";
      readonly resourceProfileRef: string;
      readonly version: string;
    }
  | { readonly _tag: "ConversationOnly" };

const isSelectionAvailable = (
  catalog: ProjectResourceCatalog | null,
  selection: ResourceSelection | null,
): boolean => {
  if (catalog === null || selection === null) return false;
  if (selection._tag === "ConversationOnly") {
    return catalog.conversationOnlySupported;
  }
  return catalog.profiles.some(
    (profile) =>
      profile.available &&
      profile.resourceProfileRef === selection.resourceProfileRef &&
      profile.version === selection.version,
  );
};

export function CreateProjectForm({
  actor,
  token,
  onSubmitted,
  embedded = false,
  quickStart = false,
}: {
  readonly actor: string;
  readonly token?: string | undefined;
  readonly onSubmitted: (receipt: CommandReceiptView) => void;
  readonly embedded?: boolean | undefined;
  /** Homepage mode: the daemon's current project directory is the implicit
   * primary folder, matching Codex local-project behavior. */
  readonly quickStart?: boolean | undefined;
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
    defaultValues: { name: quickStart ? "新项目" : "" },
  });
  const [catalog, setCatalog] = useState<ProjectResourceCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState(false);
  const [resourceSelection, setResourceSelection] =
    useState<ResourceSelection | null>(null);
  const loadCatalog = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setCatalogLoading(true);
      let outcome: Awaited<ReturnType<typeof fetchProjectResources>>;
      try {
        outcome = await fetchProjectResources({
          token: token ?? null,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        setCatalogLoading(false);
        setCatalogError(true);
        return;
      }
      setCatalogLoading(false);
      if (!outcome.ok) {
        setCatalogError(true);
        return;
      }
      setCatalogError(false);
      setCatalog(outcome.dto);
      setResourceSelection((current) => {
        if (current !== null && isSelectionAvailable(outcome.dto, current)) {
          return current;
        }
        if (current !== null) return null;
        return outcome.dto.conversationOnlySupported
          ? { _tag: "ConversationOnly" }
          : null;
      });
    },
    [token],
  );
  useEffect(() => {
    const controller = new AbortController();
    void loadCatalog(controller.signal);
    return () => controller.abort();
  }, [loadCatalog]);
  const name = watch("name");
  const resourceChoiceLocked =
    state.phase === "submitting" || state.phase === "transport-failed";
  const canCreate =
    !catalogLoading &&
    !catalogError &&
    isSelectionAvailable(catalog, resourceSelection);
  const doSubmit = (event?: FormEvent): void => {
    event?.preventDefault();
    void handleSubmit((values) => {
      const selection = resourceSelection;
      if (
        selection === null ||
        !isSelectionAvailable(catalog, selection) ||
        catalogError
      ) {
        return;
      }
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
          resourceSelection: selection,
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
        label={quickStart ? "项目名称（可选）" : "项目名称"}
        disabled={resourceChoiceLocked}
        placeholder={
          quickStart ? "保留“新项目”或改成一个名称" : "例如：论文写作平台"
        }
        value={name}
        onChange={(next) => {
          setValue("name", next);
        }}
      />
      {formState.errors.name ? (
        <p className="arbor-command-error">{formState.errors.name.message}</p>
      ) : null}
      {quickStart && catalogError ? (
        <div role="alert" className="arbor-command-error">
          <p>默认项目文件夹暂时不可用，请重试。</p>
          <Button type="button" onClick={() => void loadCatalog()}>
            重试
          </Button>
        </div>
      ) : null}
      {state.rejection === "ProjectResourceUnavailable" ? (
        <div role="alert" className="arbor-command-error">
          <p>
            所选项目文件位置不可用或已变化。请重新检查并选择可用位置后再次提交。
          </p>
          <Button type="button" onClick={() => void loadCatalog()}>
            重新检查文件位置
          </Button>
        </div>
      ) : (
        <FormFeedback state={state} onRetry={() => doSubmit()} />
      )}
      <Button
        variant="primary"
        type="submit"
        disabled={resourceChoiceLocked || !canCreate}
      >
        {quickStart ? "开始使用" : "创建项目"}
      </Button>
    </form>
  );
  return embedded ? form : <Card title="创建项目">{form}</Card>;
}
