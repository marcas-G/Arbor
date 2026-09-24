/**
 * W-06 — Work Detail 页（frozen §2.5）：workId 头部（objective 来自父
 * workspace-detail 的 currentWork/pendingWorks 匹配，匹配不到 = Empty）+
 * 验证与验收区（verification(workId) → VerificationView）+ 治理动作
 * disabled 占位（W-08 接线）。数据组合不发明 work 级新视图；查询失败
 * 就地 ProblemCard；本页 0 个 command 发起。
 */
import type {
  CurrentWorkSummary,
  Problem,
  VerificationRes,
} from "@arbor/api-contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Route } from "../../api/router.js";
import { navigate } from "../../api/router.js";
import { useViewQuery } from "../../api/useViewQuery.js";
import { AcceptWorkOutcomeForm } from "../../commands/forms/AcceptWorkOutcomeForm.js";
import { SteerWorkForm } from "../../commands/forms/SteerWorkForm.js";
import type { CommandReceiptView } from "../../commands/submitCommand.js";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Empty } from "../../components/Empty.js";
import { MonoText } from "../../components/MonoText.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { ProblemCard } from "../../problems/ProblemCard.js";
import { useSession } from "../../session/SessionContext.js";
import { VerificationView } from "../../views/VerificationView.js";
import styles from "./work.module.css";

/** transport 层抛出的就是 frozen Problem（useViewQuery queryFn 约定）。 */
const asProblem = (error: unknown): Problem => error as Problem;

type SteerBinding = {
  readonly workId: string;
  readonly objective: string;
  readonly revision: number;
};

type AcceptanceBinding = SteerBinding & {
  readonly verificationId: string;
  readonly targetWorkRevision: number;
};

/**
 * `verification({workId})` is an exact request-scoped view: the request
 * supplies the selected work leg, while its response supplies the frozen
 * verification identity. No work/revision/verification value is guessed.
 */
const bindWorkGovernance = (
  selectedWorkId: string,
  current: CurrentWorkSummary | undefined,
  verification: VerificationRes | undefined,
): {
  readonly steer: SteerBinding | null;
  readonly accept: AcceptanceBinding | null;
} => {
  if (current?.workId !== selectedWorkId) {
    return { steer: null, accept: null };
  }
  const steer: SteerBinding = {
    workId: current.workId,
    objective: current.objective,
    revision: current.revision,
  };
  if (
    verification?.verificationId === undefined ||
    verification.targetWorkRevision === undefined ||
    verification.targetWorkRevision !== current.revision ||
    verification.verdict !== "Pass" ||
    verification.acceptance !== undefined
  ) {
    return { steer, accept: null };
  }
  return {
    steer,
    accept: {
      ...steer,
      verificationId: verification.verificationId,
      targetWorkRevision: verification.targetWorkRevision,
    },
  };
};

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
  const governance = bindWorkGovernance(workId, current, verification.data);

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
        <WorkGovernance
          projectId={route.projectId}
          workspaceId={route.workspaceId}
          steer={governance.steer}
          accept={governance.accept}
        />
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

/** W-08 — Work-context governance only receives source-bound targets. */
function WorkGovernance({
  projectId,
  workspaceId,
  steer,
  accept,
}: {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly steer: SteerBinding | null;
  readonly accept: AcceptanceBinding | null;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"accept" | "steer" | null>(null);
  const onSubmitted = (_receipt: CommandReceiptView): void => {
    setMode(null);
    void queryClient.invalidateQueries({ queryKey: ["view"] });
  };
  return (
    <div className={styles.governance}>
      <span className={styles.governanceCaption}>治理动作</span>
      <div className={styles.governanceActions}>
        <Button
          variant="primary"
          disabled={accept === null}
          onClick={() => {
            setMode("accept");
          }}
        >
          验收工作成果
        </Button>
        <Button
          variant="quiet"
          disabled={steer === null}
          onClick={() => setMode("steer")}
        >
          纠偏
        </Button>
      </div>
      {mode === "accept" && accept !== null ? (
        <AcceptWorkOutcomeForm
          actor={session.actor ?? ""}
          projectId={projectId}
          workId={accept.workId}
          targetWorkRevision={accept.targetWorkRevision}
          verificationId={accept.verificationId}
          token={session.token ?? undefined}
          onSubmitted={onSubmitted}
        />
      ) : null}
      {mode === "steer" && steer !== null ? (
        <SteerWorkForm
          actor={session.actor ?? ""}
          projectId={projectId}
          workId={steer.workId}
          workspaceId={workspaceId}
          objective={steer.objective}
          expectedWorkRevision={steer.revision}
          token={session.token ?? undefined}
          onSubmitted={onSubmitted}
        />
      ) : null}
    </div>
  );
}
