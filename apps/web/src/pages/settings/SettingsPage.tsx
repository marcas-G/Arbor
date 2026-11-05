/** Frozen Settings capabilities: project/session commands and local layout only. */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { Route } from "../../api/router.js";
import { fetchProjectDirectory } from "../../api/transport.js";
import { FormFeedback } from "../../commands/forms/FormFeedback.js";
import { GrantPermissionForm } from "../../commands/forms/GrantPermissionForm.js";
import { useCommandSubmission } from "../../commands/useCommandSubmission.js";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Empty } from "../../components/Empty.js";
import { useSession } from "../../session/SessionContext.js";
import {
  DEFAULT_WORKBENCH_LAYOUT,
  useWorkbenchLayoutPreference,
} from "../workbench/layoutPreference.js";
import styles from "./settings.module.css";

function PermissionsSection({
  actor,
  projectId,
  workspaceId,
  token,
}: {
  readonly actor: string | null;
  readonly projectId: string;
  readonly workspaceId?: string | undefined;
  readonly token: string | null;
}) {
  return (
    <section className={styles.section} aria-label="权限管理">
      <h2 className={styles.sectionTitle}>高级权限设置</h2>
      {actor === null || token === null ? (
        <Empty>未连接——连接后可管理权限</Empty>
      ) : (
        <details>
          <summary>为特定用户或自动分工开放额外操作</summary>
          <div className={styles.stack}>
            <GrantPermissionForm
              actor={actor}
              projectId={projectId}
              workspaceId={workspaceId}
              token={token}
              onSubmitted={() => undefined}
            />
            <p className={styles.note}>已授予的权限暂时不能在这里撤销。</p>
          </div>
        </details>
      )}
    </section>
  );
}

function ProjectSection({
  actor,
  token,
  projectId,
}: {
  readonly actor: string | null;
  readonly token: string | null;
  readonly projectId: string;
}) {
  const session = useSession();
  const directory = useQuery({
    queryKey: ["project-directory"],
    queryFn: () =>
      fetchProjectDirectory({
        token,
        onUnauthenticated: session.reportUnauthenticated,
      }),
    enabled: token !== null,
  });
  const current =
    directory.data?.ok === true
      ? directory.data.dto.projects.find(
          (project) => project.projectId === projectId,
        )
      : undefined;
  const [name, setName] = useState("");
  const [closeConfirming, setCloseConfirming] = useState(false);
  const rename = useCommandSubmission({
    actor: actor ?? "",
    token: token ?? undefined,
    onSubmitted: () => {
      setName("");
      void directory.refetch();
    },
  });
  const close = useCommandSubmission({
    actor: actor ?? "",
    token: token ?? undefined,
    onSubmitted: () => {
      setCloseConfirming(false);
      void directory.refetch();
    },
  });
  const renameLocked =
    rename.state.phase === "submitting" ||
    rename.state.phase === "transport-failed";
  const closeLocked =
    close.state.phase === "submitting" ||
    close.state.phase === "transport-failed";
  const submitRename = (): void => {
    if (current === undefined) return;
    void rename.submit("RenameProject", projectId, {
      name: name.trim(),
      expectedRevision: current.revision,
    });
  };
  const submitClose = (): void => {
    if (current === undefined) return;
    void close.submit("CloseProject", projectId, {
      expectedRevision: current.revision,
      confirmed: true,
    });
  };
  return (
    <section className={styles.section} aria-label="项目">
      <h2 className={styles.sectionTitle}>项目</h2>
      <p className={styles.note}>
        当前项目：{current?.name ?? "正在获取项目名称"}
        。切换与新建项目统一使用全局项目中心。
      </p>
      {actor !== null &&
      token !== null &&
      current !== undefined &&
      current.lifecycle === "Open" ? (
        <Card title="项目管理">
          <div className={styles.stack}>
            <label className={styles.renameLabel}>
              项目名称
              <input
                value={name}
                disabled={renameLocked}
                placeholder={current.name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <Button
              variant="quiet"
              disabled={name.trim().length === 0 || renameLocked}
              onClick={submitRename}
            >
              重命名项目
            </Button>
            <FormFeedback state={rename.state} onRetry={submitRename} />
            <p className={styles.note}>
              归档后不会删除历史，但不再接收新任务或新对话。
            </p>
            {closeConfirming ? (
              <div className={styles.confirmPanel}>
                <strong>确认归档这个项目？</strong>
                <span>
                  归档后仍可查看历史，但所有分工都不能再接收新工作或新对话。
                </span>
                <FormFeedback state={close.state} onRetry={submitClose} />
                <div className={styles.confirmActions}>
                  <Button
                    variant="danger"
                    disabled={closeLocked}
                    onClick={submitClose}
                  >
                    确认归档
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={closeLocked}
                    onClick={() => setCloseConfirming(false)}
                  >
                    取消
                  </Button>
                </div>
              </div>
            ) : (
              <Button variant="danger" onClick={() => setCloseConfirming(true)}>
                归档项目
              </Button>
            )}
          </div>
        </Card>
      ) : null}
    </section>
  );
}

function WorkbenchPreferences() {
  const [layout, setLayout] = useWorkbenchLayoutPreference();
  const setOrder = (order: "tree-first" | "conversation-first"): void => {
    setLayout((previous) => ({ ...previous, order }));
  };
  return (
    <Card title="工作台偏好">
      <div className={styles.preferences}>
        <fieldset className={styles.preferenceGroup}>
          <legend>面板顺序</legend>
          <label>
            <input
              type="radio"
              name="workbench-order"
              value="tree-first"
              checked={layout.order === "tree-first"}
              onChange={() => setOrder("tree-first")}
            />
            分工优先
          </label>
          <label>
            <input
              type="radio"
              name="workbench-order"
              value="conversation-first"
              checked={layout.order === "conversation-first"}
              onChange={() => setOrder("conversation-first")}
            />
            对话优先
          </label>
        </fieldset>
        <label className={styles.rangePreference}>
          工作分工宽度（桌面）
          <input
            type="range"
            min="30"
            max="70"
            step="1"
            value={layout.treeBasis}
            aria-valuetext={`${layout.treeBasis}%`}
            onChange={(event) => {
              const treeBasis = Number(event.target.value);
              setLayout((previous) => ({ ...previous, treeBasis }));
            }}
          />
          <span>{layout.treeBasis}%</span>
        </label>
        <Button
          variant="quiet"
          onClick={() => setLayout(DEFAULT_WORKBENCH_LAYOUT)}
        >
          恢复默认布局
        </Button>
      </div>
    </Card>
  );
}

function SessionSection() {
  const { token, clearSession } = useSession();
  if (token === null) {
    return (
      <Card title="会话">
        <Empty>已断开——请通过登录卡片重新连接</Empty>
      </Card>
    );
  }
  return (
    <Card title="连接">
      <div className={styles.stack}>
        <p className={styles.note}>Arbor 已连接到当前工作环境。</p>
        <p className={styles.note}>刷新页面后可能需要重新连接。</p>
        <Button variant="danger" onClick={clearSession}>
          断开连接
        </Button>
      </div>
    </Card>
  );
}

export function SettingsPage({
  route,
}: {
  readonly route: Extract<Route, { name: "settings" }>;
}) {
  const session = useSession();
  const { actor, token } = session;
  const directory = useQuery({
    queryKey: ["project-directory", "settings"],
    queryFn: () =>
      fetchProjectDirectory({
        token,
        onUnauthenticated: session.reportUnauthenticated,
      }),
    enabled: token !== null,
  });
  const workspaceId =
    directory.data?.ok === true
      ? directory.data.dto.projects.find(
          (project) => project.projectId === route.projectId,
        )?.rootWorkspaceId
      : undefined;
  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>项目配置</p>
          <h1 className={styles.title}>设置</h1>
          <p className={styles.pageIntro}>
            管理项目、权限、工作台偏好与当前会话。
          </p>
        </div>
      </header>
      <div className={styles.settingsGrid}>
        <main className={styles.primaryColumn}>
          <PermissionsSection
            actor={actor}
            projectId={route.projectId}
            workspaceId={workspaceId}
            token={token}
          />
          <ProjectSection
            actor={actor}
            token={token}
            projectId={route.projectId}
          />
          <WorkbenchPreferences />
        </main>
        <aside className={styles.secondaryColumn}>
          <SessionSection />
        </aside>
      </div>
    </div>
  );
}
