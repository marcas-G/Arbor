/**
 * W-07 — Usage 页（frozen §2.9）：groupBy 三态（workspace/subtree/project）
 * 是本地 state，进 query key/body（URL 不携带）；表格复用 views/UsageView
 * 逐行呈现 server rows——不做浏览器端合计（`03` §2 I2），cost Unknown
 * 原样 "unknown"（P12 `04` TR-5）。ceiling 对照条仅当 DTO 提供字段时呈现
 * （当前 UsageRes 只有 rows → 不渲染，不发明）。空态/失败就地处理。
 */
import type { Problem, UsageReq } from "@arbor/api-contracts";
import { useState } from "react";
import type { Route } from "../../api/router.js";
import { useViewQuery } from "../../api/useViewQuery.js";
import { Card } from "../../components/Card.js";
import { Empty } from "../../components/Empty.js";
import { ProblemCard } from "../../problems/ProblemCard.js";
import { UsageView } from "../../views/UsageView.js";
import styles from "./usage.module.css";

export function UsagePage({
  route,
}: {
  readonly route: Extract<Route, { name: "usage" }>;
}) {
  const [groupBy, setGroupBy] = useState<UsageReq["groupBy"]>("workspace");
  const query = useViewQuery("usage", {
    projectId: route.projectId as never,
    groupBy,
  });
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>用量</h1>
      <Card title="用量明细">
        {query.isPending ? (
          <Empty>加载中</Empty>
        ) : query.isError ? (
          <ProblemCard
            problem={query.error as unknown as Problem}
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : (
          <UsageView
            res={query.data}
            groupBy={groupBy}
            onGroupByChange={setGroupBy}
          />
        )}
      </Card>
    </div>
  );
}
