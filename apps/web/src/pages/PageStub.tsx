import { formatRoute, type Route } from "../api/router.js";
import { useViewQuery } from "../api/useViewQuery.js";
import { Card } from "../components/Card.js";
import { Empty } from "../components/Empty.js";

/** W-02 walkthrough stub — replaced by the owning task (named in title).
 * Fires the project attention query so the shell's data/freshness/gate
 * plumbing is exercisable before the real pages land. */
export function PageStub({
  route,
  label,
}: {
  readonly route: Route;
  readonly label: string;
}) {
  const query = useViewQuery("attention", {
    projectId: route.projectId as never,
  });
  const rows =
    query.data !== undefined
      ? (query.data as { rows: ReadonlyArray<unknown> }).rows.length
      : null;
  return (
    <Card title={label}>
      <Empty>
        {rows === null
          ? formatRoute(route)
          : `${formatRoute(route)} · 关注事项 ${rows} 条`}
      </Empty>
    </Card>
  );
}
