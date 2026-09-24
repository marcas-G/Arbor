import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import styles from "./RefreshingStatus.module.css";

/** Announces server refetches while cached data remains available. */
export function RefreshingStatus() {
  const fetching = useIsFetching();
  const queryClient = useQueryClient();
  const refreshingCachedData =
    fetching > 0 &&
    queryClient
      .getQueryCache()
      .getAll()
      .some(
        (query) =>
          query.state.data !== undefined &&
          query.state.fetchStatus === "fetching",
      );
  if (!refreshingCachedData) {
    return null;
  }
  return (
    <span className={styles.status} role="status" aria-live="polite">
      正在刷新服务器数据
    </span>
  );
}
