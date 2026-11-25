/**
 * W-08 — CreateProject form (RHF + Zod over the two user inputs). The full
 * frozen payload is assembled with caller-preallocated prj_/ws_/ses_
 * uuid-v7 ids (DID §4.1 single-transaction bootstrap; ids held across
 * retries like the commandId).
 */
import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Resolver, useForm } from "react-hook-form";
import { prepareProjectDirectory } from "../../api/projectDirectories.js";
import { navigate } from "../../api/router.js";
import type {
  ProjectResourceCatalog,
  ProjectResourceProfileEntry,
} from "../../api/transport.js";
import { fetchProjectResources } from "../../api/transport.js";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Field } from "../../components/Field.js";
import { cn } from "../../lib/utils.js";
import { createProjectSchema, zodResolver } from "../schemas.js";
import type { CommandReceiptView } from "../submitCommand.js";
import { useCommandSubmission } from "../useCommandSubmission.js";
import { uuidv7 } from "../uuid7.js";
import { FormFeedback } from "./FormFeedback.js";
import { ProjectFolderPicker } from "./ProjectFolderPicker.js";

type CreateValues = { name: string };

type ResourceSelection =
  | {
      readonly _tag: "Profile";
      readonly resourceProfileRef: string;
      readonly version: string;
    }
  | { readonly _tag: "ConversationOnly" };

const profileSelectionOf = (
  profile: ProjectResourceProfileEntry,
): ResourceSelection => ({
  _tag: "Profile",
  resourceProfileRef: profile.resourceProfileRef,
  version: profile.version,
});

const isSameSelection = (
  left: ResourceSelection | null,
  right: ResourceSelection,
): boolean =>
  left?._tag === right._tag &&
  (right._tag === "ConversationOnly" ||
    (left?._tag === "Profile" &&
      left.resourceProfileRef === right.resourceProfileRef &&
      left.version === right.version));

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
  onProjectOpened,
}: {
  readonly actor: string;
  readonly token?: string | undefined;
  readonly onSubmitted: (receipt: CommandReceiptView) => void;
  readonly embedded?: boolean | undefined;
  /** Homepage mode supplies a default project name before folder selection. */
  readonly quickStart?: boolean | undefined;
  readonly onProjectOpened?: ((projectId: string) => void) | undefined;
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
  const [directoryPath, setDirectoryPath] = useState("");
  const [createDirectory, setCreateDirectory] = useState(false);
  const [conversationOnly, setConversationOnly] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const preparingRef = useRef(false);
  const preparedSelection = useRef<ResourceSelection | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
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
        const available = outcome.dto.profiles.filter(
          (profile) => profile.available,
        );
        return available.length === 1 && available[0] !== undefined
          ? profileSelectionOf(available[0])
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
  const supportsDirectories = catalog?.directorySelectionSupported === true;
  const resourceChoiceLocked =
    preparing ||
    state.phase === "submitting" ||
    state.phase === "transport-failed";
  const canCreate =
    !catalogLoading &&
    !catalogError &&
    (supportsDirectories
      ? conversationOnly || directoryPath.trim().length > 0
      : isSelectionAvailable(catalog, resourceSelection));
  const doSubmit = (event?: FormEvent): void => {
    event?.preventDefault();
    void handleSubmit(async (values) => {
      if (preparingRef.current) return;
      let selection = resourceSelection;
      let projectName = values.name;
      if (supportsDirectories && !conversationOnly) {
        if (
          state.phase === "transport-failed" &&
          preparedSelection.current !== null
        ) {
          selection = preparedSelection.current;
        } else {
          preparingRef.current = true;
          setPreparing(true);
          setDirectoryError(null);
          try {
            const prepared = await prepareProjectDirectory(
              token ?? "local",
              directoryPath,
              createDirectory,
            );
            if (!mountedRef.current) return;
            if (prepared.existingProject !== null) {
              if (onProjectOpened !== undefined)
                onProjectOpened(prepared.existingProject.projectId);
              else
                navigate({
                  name: "workbench",
                  projectId: prepared.existingProject.projectId,
                });
              return;
            }
            selection = prepared.selection;
            preparedSelection.current = selection;
            setDirectoryPath(prepared.path);
            if (projectName === "新项目") projectName = prepared.name;
          } catch (failure) {
            setDirectoryError(
              failure instanceof Error
                ? failure.message
                : "目录选择失败，请重试。",
            );
            return;
          } finally {
            preparingRef.current = false;
            setPreparing(false);
          }
        }
      } else if (supportsDirectories) {
        selection = { _tag: "ConversationOnly" };
      }
      if (
        selection === null ||
        (!supportsDirectories && !isSelectionAvailable(catalog, selection)) ||
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
        name: projectName,
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
          name: projectName,
          responsibilityDefinition: {
            purpose: projectName,
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
    <form className="flex flex-col gap-ui-3" onSubmit={doSubmit}>
      <Field
        control="input"
        label={quickStart ? "项目名称（可选）" : "项目名称"}
        disabled={resourceChoiceLocked}
        placeholder={
          quickStart ? "保留“新项目”或改成一个名称" : "例如：论文写作平台"
        }
        value={name}
        onChange={(next) => {
          setValue("name", next, { shouldDirty: true });
        }}
      />
      {formState.errors.name ? (
        <p
          className={cn(
            "arbor-command-error",
            "m-0 text-small text-destructive",
          )}
        >
          {formState.errors.name.message}
        </p>
      ) : null}
      {supportsDirectories ? (
        <fieldset
          disabled={resourceChoiceLocked}
          className="flex flex-col gap-ui-2 rounded-md border border-border p-ui-3 text-small text-muted-foreground"
        >
          <legend>项目位置</legend>
          {!conversationOnly ? (
            <ProjectFolderPicker
              token={token ?? "local"}
              path={directoryPath}
              create={createDirectory}
              disabled={resourceChoiceLocked}
              onPathChange={(next) => {
                setDirectoryPath(next);
                setDirectoryError(null);
                if (!formState.dirtyFields.name) {
                  const folder = next
                    .replace(/[\\/]+$/u, "")
                    .split(/[\\/]/u)
                    .at(-1);
                  if (folder) setValue("name", folder);
                }
              }}
              onCreateChange={setCreateDirectory}
            />
          ) : (
            <p>此项目暂不绑定文件夹，无法使用项目文件工具。</p>
          )}
          <label>
            <input
              type="checkbox"
              checked={conversationOnly}
              onChange={(event) => setConversationOnly(event.target.checked)}
            />
            暂不绑定文件夹
          </label>
          {directoryError ? (
            <p
              role="alert"
              className={cn(
                "arbor-command-error",
                "m-0 text-small text-destructive",
              )}
            >
              {directoryError}
            </p>
          ) : null}
        </fieldset>
      ) : (
        <fieldset
          className="flex flex-col gap-ui-2 rounded-md border border-border p-ui-3 text-small text-muted-foreground"
          disabled={resourceChoiceLocked}
        >
          <legend>项目文件</legend>
          {catalogLoading ? (
            <p role="status">正在读取可用文件目录…</p>
          ) : catalogError ? (
            <div
              role="alert"
              className={cn(
                "arbor-command-error",
                "m-0 text-small text-destructive",
              )}
            >
              <p>
                {quickStart
                  ? "默认项目文件夹暂时不可用，请重试。"
                  : "无法读取项目文件目录。加载完成前不会创建项目。"}
              </p>
              <Button type="button" onClick={() => void loadCatalog()}>
                重试
              </Button>
            </div>
          ) : catalog !== null ? (
            <>
              {catalog.profiles.map((profile) => {
                const choice = profileSelectionOf(profile);
                return (
                  <label
                    key={`${profile.resourceProfileRef}\u0000${profile.version}`}
                  >
                    <input
                      type="radio"
                      name="project-resource-selection"
                      checked={isSameSelection(resourceSelection, choice)}
                      disabled={!profile.available}
                      onChange={() => setResourceSelection(choice)}
                    />
                    <span>{profile.displayName}</span>
                    <span>{profile.available ? "可用" : "不可用"}</span>
                  </label>
                );
              })}
              {catalog.conversationOnlySupported ? (
                <label>
                  <input
                    type="radio"
                    name="project-resource-selection"
                    checked={resourceSelection?._tag === "ConversationOnly"}
                    onChange={() =>
                      setResourceSelection({ _tag: "ConversationOnly" })
                    }
                  />
                  <span>仅对话</span>
                </label>
              ) : null}
              {catalog.profiles.every((profile) => !profile.available) ? (
                <p>
                  当前没有可用的文件目录。仅对话项目不能使用文件工具，也不能完成需要文件证据的
                  Work；如仍要创建，请明确选择“仅对话”。
                </p>
              ) : catalog.profiles.filter((profile) => profile.available)
                  .length > 1 && resourceSelection === null ? (
                <p>请选择一个可用文件目录，或明确选择“仅对话”。</p>
              ) : null}
            </>
          ) : null}
        </fieldset>
      )}
      {state.rejection === "ProjectResourceUnavailable" ? (
        <div
          role="alert"
          className={cn(
            "arbor-command-error",
            "m-0 text-small text-destructive",
          )}
        >
          <p>
            {supportsDirectories
              ? "目录状态已变化，或已被其他项目使用。请重新选择并提交；已存在的项目会直接打开。"
              : "所选文件目录不可用或配置已变化。请重新加载目录并选择可用资源，或明确选择“仅对话”，然后再次提交。"}
          </p>
          <Button type="button" onClick={() => void loadCatalog()}>
            重新加载目录
          </Button>
        </div>
      ) : (
        <FormFeedback state={state} onRetry={() => doSubmit()} />
      )}
      <Button
        variant="primary"
        type="submit"
        disabled={state.phase === "submitting" || !canCreate}
      >
        {quickStart ? "开始使用" : "创建项目"}
      </Button>
    </form>
  );
  return embedded ? form : <Card title="创建项目">{form}</Card>;
}
