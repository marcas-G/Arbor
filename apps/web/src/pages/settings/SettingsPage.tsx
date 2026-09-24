/** Frozen Settings capabilities: project/session commands and local layout only. */
import type { Route } from "../../api/router.js";
import { CreateProjectForm } from "../../commands/forms/CreateProjectForm.js";
import { GrantPermissionForm } from "../../commands/forms/GrantPermissionForm.js";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { cx } from "../../components/cx.js";
import { Empty } from "../../components/Empty.js";
import { KeyValue, type KeyValuePair } from "../../components/KeyValue.js";
import { MonoText } from "../../components/MonoText.js";
import { useSession } from "../../session/SessionContext.js";
import {
  DEFAULT_WORKBENCH_LAYOUT,
  useWorkbenchLayoutPreference,
} from "../workbench/layoutPreference.js";
import styles from "./settings.module.css";

function PermissionsSection({
  actor,
  projectId,
  token,
}: {
  readonly actor: string | null;
  readonly projectId: string;
  readonly token: string | null;
}) {
  return (
    <section className={styles.section} aria-label="权限管理">
      <h2 className={styles.sectionTitle}>权限管理</h2>
      {actor === null || token === null ? (
        <Empty>未连接——连接后可管理权限</Empty>
      ) : (
        <div className={styles.stack}>
          <GrantPermissionForm
            actor={actor}
            projectId={projectId}
            token={token}
            onSubmitted={() => undefined}
          />
          <p className={styles.note}>
            当前冻结接口未提供授权清单，无法定位可撤销授权。
          </p>
        </div>
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
  return (
    <section className={styles.section} aria-label="项目">
      <h2 className={styles.sectionTitle}>项目</h2>
      <div
        className={cx([
          styles.projectBox,
          projectId === null ? styles.projectHighlight : null,
        ])}
      >
        {actor === null || token === null ? (
          <Empty>未连接——连接后可创建项目</Empty>
        ) : (
          <CreateProjectForm
            actor={actor}
            token={token}
            onSubmitted={() => undefined}
          />
        )}
      </div>
      <p className={styles.note}>
        当前项目：<MonoText>{projectId}</MonoText>。项目切换使用左侧栏的切换器。
      </p>
    </section>
  );
}

function CapabilityUnavailableSections() {
  const unavailable = [
    ["成员管理", "当前冻结接口未提供成员清单或管理能力。"],
    ["供应商与模型", "当前冻结接口未提供供应商或模型配置能力。"],
    ["运行时、资源与存储", "当前冻结接口未提供运行时、资源或存储配置能力。"],
    ["通知与安全策略", "当前冻结接口未提供通知或安全策略配置能力。"],
  ] as const;
  return (
    <div className={styles.unavailableGrid}>
      {unavailable.map(([label, description]) => (
        <section
          key={label}
          className={styles.unavailableSection}
          aria-label={label}
        >
          <h2 className={styles.sectionTitle}>{label}</h2>
          <p className={styles.note}>{description}</p>
        </section>
      ))}
    </div>
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
            树优先
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
          责任树宽度（桌面）
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
  const { actor, token, clearSession } = useSession();
  if (token === null) {
    return (
      <Card title="会话">
        <Empty>已断开——请通过登录卡片重新连接</Empty>
      </Card>
    );
  }
  const pairs: ReadonlyArray<KeyValuePair> = [
    { label: "执行者（actor）", value: <MonoText>{actor ?? "—"}</MonoText> },
    { label: "令牌（token）", value: "已连接（保存在内存，不展示）" },
  ];
  return (
    <Card title="会话">
      <div className={styles.stack}>
        <KeyValue pairs={pairs} />
        <p className={styles.note}>令牌仅保存在内存，刷新页面即失效</p>
        <Button variant="danger" onClick={clearSession}>
          断开
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
  const { actor, token } = useSession();
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>设置</h1>
      <PermissionsSection
        actor={actor}
        projectId={route.projectId}
        token={token}
      />
      <ProjectSection actor={actor} token={token} projectId={route.projectId} />
      <SessionSection />
      <WorkbenchPreferences />
      <CapabilityUnavailableSections />
    </div>
  );
}
