import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RefreshingStatus } from "../src/components/RefreshingStatus.js";

const key = ["view", "usage", { groupBy: "project" }] as const;

function CachedQuery() {
  useQuery({
    queryKey: key,
    queryFn: () =>
      new Promise<{ readonly rows: ReadonlyArray<string> }>(() => undefined),
    staleTime: Number.POSITIVE_INFINITY,
  });
  return null;
}

describe("global cached-query refresh status", () => {
  it("announces refetching while keeping cached server rows", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(key, { rows: ["server row"] });
    render(
      <QueryClientProvider client={client}>
        <RefreshingStatus />
        <CachedQuery />
      </QueryClientProvider>,
    );

    await act(async () => {
      void client.invalidateQueries({ queryKey: key });
    });
    expect(await screen.findByText("正在刷新服务器数据")).toBeTruthy();
    expect(client.getQueryData(key)).toEqual({ rows: ["server row"] });
    expect(client.getQueryState(key)?.fetchStatus).toBe("fetching");
    client.clear();
  });
});
