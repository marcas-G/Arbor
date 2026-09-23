/**
 * W-06 — Work Detail 页（frozen §2.5）：workId 头部（objective 来自父
 * workspace-detail 的 currentWork/pendingWorks 匹配，匹配不到 = Empty）+
 * 验证与验收区（verification(workId) → VerificationView）+ 治理动作
 * disabled 占位（W-08 接线）。数据组合不发明 work 级新视图；查询失败
 * 就地 ProblemCard；本页 0 个 command 发起。
 */
import type { Problem } from "@arbor/api-contracts";
import type { Route } from "../../api/router.js";
import { navigate } from "../../api/router.js";
import { useViewQuery } from "../../api/useViewQuery.js";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Empty } from "../../components/Empty.js";
import { MonoText } from "../../components/MonoText.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { ProblemCard } from "../../problems/ProblemCard.js";
import { VerificationView } from "../../views/VerificationView.js";
import styles from "./work.module.css";

/** transport 层抛出的就是 frozen Problem（useViewQuery queryFn 约定）。 */
const asProblem = (error: unknown): Problem => error as Problem;

export function WorkPage({
  route,
}: {
  readonly route: Extract<Route, { name: "work" }>;
}) {
  const { projectId, workspaceId, workId } = route;
  const detail = useViewQuery("workspace-detail", {
    workspaceId: workspaceId as never,
  });
  const current = detail.data?.currentWork;
  const pendingMatch = detail.data?.pendingWorks.find(
    (work) => work.workId === workId,
  );
  const isCurrent = current?.workId === workId;
  const objective = isCurrent
    ? current?.objective
    : pendingMatch === undefined
      ? undefined
      : pendingMatch.objective;
  const workFound = objective !== undefined;
  const verification = useViewQuery(
    "verification",
    workFound ? { workId: workId as never } : null,
  );

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerMain}>
          <Button
            variant="quiet"
            onClick={() => {
              navigate({
                name: "workspace",
                projectId,
                workspaceId,
                tab: "overview",
              });
            }}
          >
            返回工作区
          </Button>
          <div className={styles.idLine}>
            <MonoText>{workId}</MonoText>
            {isCurrent && current !== undefined ? (
              <StatusBadge label={current.status} />
            ) : null}
          </div>
          {objective === undefined ? null : (
            <p className={styles.objective}>{objective}</p>
          )}
        </div>
        <div className={styles.governance}>
          <span className={styles.governanceCaption}>治理动作 · W-08 接线</span>
          <div className={styles.governanceActions}>
            <Button variant="primary" disabled>
              验收工作成果
            </Button>
            <Button variant="quiet" disabled>
              纠偏
            </Button>
          </div>
        </div>
      </header>
      {detail.isPending ? (
        <Empty>加载中</Empty>
      ) : detail.isError ? (
        <ProblemCard problem={asProblem(detail.error)} />
      ) : !workFound ? (
        <Empty>未找到该工作</Empty>
      ) : (
        <Card title="验证与验收">
          {verification.isPending ? (
            <Empty>加载中</Empty>
          ) : verification.isError ? (
            <ProblemCard problem={asProblem(verification.error)} />
          ) : (
            <VerificationView view={verification.data} />
          )}
        </Card>
      )}
    </div>
  );
}
