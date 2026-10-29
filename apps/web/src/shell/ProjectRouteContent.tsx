import type { Problem } from "@arbor/api-contracts";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Route } from "../api/router.js";
import { fetchProjectDirectory, fetchView } from "../api/transport.js";
import { Empty } from "../components/Empty.js";
import { ProblemCard } from "../problems/ProblemCard.js";
import { useSession } from "../session/SessionContext.js";

export function ProjectRouteContent({
  route,
  pageFor,
}: {
  readonly route: Route;
  readonly pageFor: (route: Route) => ReactNode;
}) {
  const session = useSession();
  const directory = useQuery({
    queryKey: ["project-directory"],
    queryFn: ({ signal }) =>
      fetchProjectDirectory({
        token: session.token,
        signal,
        onUnauthenticated: session.reportUnauthenticated,
      }),
    enabled: session.token !== null,
    staleTime: 0,
    refetchOnMount: "always",
  });

  const projectExists =
    directory.data?.ok === true &&
    directory.data.dto.projects.some(
      (project) => project.projectId === route.projectId,
    );
  // Work routes are proven by their exact WorkDetail {project, workspace,
  // work} response before WorkPage enables any workspace-scoped follow-up.
  const workspaceId = route.name === "workspace" ? route.workspaceId : null;
  const tree = useQuery({
    queryKey: ["view", "responsibility-tree", { projectId: route.projectId }],
    queryFn: ({ signal }) =>
      fetchView(
        "responsibility-tree",
        { projectId: route.projectId as never },
        {
          token: session.token,
          signal,
          onUnauthenticated: session.reportUnauthenticated,
        },
      ).then((outcome) => {
        if (!outcome.ok) throw outcome.problem;
        return outcome.dto;
      }),
    enabled:
      projectExists &&
      !directory.isPending &&
      !directory.isFetching &&
      workspaceId !== null,
    staleTime: 0,
    refetchOnMount: "always",
  });

  if (directory.isPending || directory.isFetching) {
    return <Empty>正在确认项目</Empty>;
  }
  if (directory.isError) {
    return <ProblemCard problem={directory.error as unknown as Problem} />;
  }
  if (directory.data?.ok === false) {
    return <ProblemCard problem={directory.data.problem} />;
  }
  if (directory.data === undefined) {
    return <Empty>项目目录不可用</Empty>;
  }
  if (!projectExists) {
    return <Empty>对象不存在</Empty>;
  }
  if (workspaceId !== null) {
    if (tree.isPending || tree.isFetching) {
      return <Empty>正在确认工作空间</Empty>;
    }
    if (tree.isError) {
      return <ProblemCard problem={tree.error as unknown as Problem} />;
    }
    if (!tree.data.nodes.some((node) => node.workspaceId === workspaceId)) {
      return <Empty>对象不存在</Empty>;
    }
  }
  return pageFor(route);
}
