/**
 * P13-006 useView: composes the render cache (viewStore) + fetchView + the
 * invalidation channel. Frozen discipline: server views are the only
 * projection state; a WS invalidate frame only triggers refetch of the
 * currently subscribed, viewId-matching entry (frames carry no payload — I4,
 * no local replay, no optimistic update); the refetch response REPLACES the
 * cache entry; unmount or request-key/token change aborts the in-flight
 * fetch; reentrancy defers to the latest server response (no local merge).
 * Single hook instance per component — cross-instance entry sharing is a
 * later integration decision.
 */

import type { ViewId, ViewRequestMap } from "@arbor/api-contracts";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { fetchView } from "./client.js";
import type { ViewInvalidationChannel } from "./invalidation.js";
import type { ViewEntry, ViewStore } from "./viewStore.js";
import { createViewStore, entryKeyOf } from "./viewStore.js";

export interface UseViewOptions {
  readonly token?: string | undefined;
  readonly invalidation?: ViewInvalidationChannel | undefined;
}

export interface UseViewResult<V extends ViewId> {
  readonly entry: ViewEntry<V>;
  readonly refetch: () => void;
}

export function useView<V extends ViewId>(
  view: V,
  request: ViewRequestMap[V],
  opts?: UseViewOptions,
): UseViewResult<V> {
  const requestKey = JSON.stringify(request);
  const token = opts?.token;
  const invalidation = opts?.invalidation;
  const entryKey = entryKeyOf(view, requestKey);

  const storeRef = useRef<ViewStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createViewStore();
  }
  const store = storeRef.current;

  // Request identity is irrelevant — only the serialized key drives refetch;
  // the latest request object travels through a ref.
  const requestRef = useRef(request);
  useEffect(() => {
    requestRef.current = request;
  });

  const [refetchTick, setRefetchTick] = useState(0);
  const refetch = useCallback(() => {
    setRefetchTick((tick) => tick + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetchTick is a deliberate re-run trigger (manual refetch + invalidation), not a value read inside the effect
  useEffect(() => {
    const controller = new AbortController();
    store.beginRefetch(entryKey);
    fetchView(view, requestRef.current, {
      token,
      signal: controller.signal,
    }).then((outcome) => {
      if (controller.signal.aborted) {
        return;
      }
      store.resolve(entryKey, outcome);
    });
    return () => {
      controller.abort();
    };
  }, [store, view, entryKey, token, refetchTick]);

  useEffect(() => {
    if (invalidation === undefined) {
      return;
    }
    return invalidation.subscribeView(view, (watermark) => {
      store.invalidate(view, watermark);
      refetch();
    });
  }, [invalidation, store, view, refetch]);

  const initialEntry = useMemo<ViewEntry<V>>(
    () => ({ viewId: view, requestKey, state: "loading" }),
    [view, requestKey],
  );

  const entries = useSyncExternalStore(store.subscribe, store.getEntries);
  const cached = entries.find(
    (entry) => entry.viewId === view && entry.requestKey === requestKey,
  );
  // Sound: entries under (view, requestKey) are only ever written by this
  // hook's fetchView<V> outcomes.
  const entry = cached === undefined ? initialEntry : (cached as ViewEntry<V>);
  return { entry, refetch };
}
