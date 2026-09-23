/**
 * W-07 — Settings 页（frozen §2.10）三块：
 * ① 权限管理：GrantPermissionForm（issuer=actor 只读，冻结组件原样使用）
 *   + RevokePermissionForm——Web v1 无 grants 列表视图，grants 传空数组，
 *   区内展示说明 Empty（待 transport DTO enhancement 后接通），不发明数据；
 * ② 项目：CreateProjectForm（session 未记住当前项目时突出显示）+ 项目
 *   切换说明（URL 是当前项目的权威，切换走 shell 的项目切换器）；
 * ③ 会话：actor/token 状态展示 + 断开（clearSession 回登录态）+ 令牌
 *   仅内存的钉死文案。Grant 回执在表单内呈现，提交成功不跳转。
 */
import type { Route } from "../../api/router.js";
import { CreateProjectForm } from "../../commands/forms/CreateProjectForm.js";
import { GrantPermissionForm } from "../../commands/forms/GrantPermissionForm.js";
import {
  type PermissionGrantOption,
  RevokePermissionForm,
} from "../../commands/forms/RevokePermissionForm.js";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { cx } from "../../components/cx.js";
import { Empty } from "../../components/Empty.js";
import { KeyValue, type KeyValuePair } from "../../components/KeyValue.js";
import { MonoText } from "../../components/MonoText.js";
import { useSession } from "../../session/SessionContext.js";
import styles from "./settings.module.css";

const NO_GRANTS: ReadonlyArray<PermissionGrantOption> = [];

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
          <div className={styles.stack}>
            <Empty>待授权列表视图（transport DTO enhancement 后接通）</Empty>
            <RevokePermissionForm
              actor={actor}
              projectId={projectId}
              grants={NO_GRANTS}
              token={token}
              onSubmitted={() => undefined}
            />
          </div>
        </div>
      )}
    </section>
  );
}

function ProjectSection({
  actor,
  token,
}: {
  readonly actor: string | null;
  readonly token: string | null;
}) {
  const { projectId } = useSession();
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
        项目切换：使用左侧栏的项目切换器；URL 中的 projectId 是当前项目的权威。
      </p>
    </section>
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
      <ProjectSection actor={actor} token={token} />
      <SessionSection />
    </div>
  );
}
