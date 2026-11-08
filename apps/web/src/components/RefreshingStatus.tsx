import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
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
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!refreshingCachedData) {
      setShow(false);
      return;
    }
    const timer = setTimeout(() => setShow(true), 250);
    return () => clearTimeout(timer);
  }, [refreshingCachedData]);
  if (!refreshingCachedData || !show) {
    return null;
  }
  return (
    <span className={styles.status} role="status" aria-live="polite">
      正在更新
    </span>
  );
}
