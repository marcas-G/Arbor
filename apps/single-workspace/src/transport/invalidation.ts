import { VIEW_IDS, type ViewId } from "@arbor/domain";

/**
 * P13 TR-W1 (`05` §3): the server-push invalidation channel. Frames carry a
 * staleness hint only — view id + watermark. NO DTO payload, NO domain event
 * body, NO view semantics (P12 `10` §1 boundary unchanged).
 */

export interface InvalidationFrame {
  readonly kind: "invalidate";
  readonly view: ViewId;
  readonly watermark: number;
}

export type FrameSink = (frame: InvalidationFrame) => void;

export interface InvalidationFanout {
  /** Register a sink; returns its unsubscribe. */
  readonly subscribe: (sink: FrameSink) => () => void;
  /** Broadcast one frame per frozen ViewId at the given watermark. */
  readonly publishWatermark: (watermark: number) => void;
  readonly subscriberCount: () => number;
}

export const makeInvalidationFanout = (
  views: ReadonlyArray<ViewId> = VIEW_IDS,
): InvalidationFanout => {
  const sinks = new Set<FrameSink>();
  return {
    subscribe: (sink) => {
      sinks.add(sink);
      return () => {
        sinks.delete(sink);
      };
    },
    publishWatermark: (watermark) => {
      for (const view of views) {
        const frame: InvalidationFrame = {
          kind: "invalidate",
          view,
          watermark,
        };
        for (const sink of sinks) {
          sink(frame);
        }
      }
    },
    subscriberCount: () => sinks.size,
  };
};

/** The watermark source: the domain-event journal tail. Read-only, derived
 * (health-plane precedent, P12 `04` §4); never an authority input. */
export const JOURNAL_WATERMARK_SQL =
  "SELECT COALESCE(MAX(sequence), 0) AS watermark FROM domain_events" as const;
