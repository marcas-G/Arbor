/**
 * P12 `10` §2/§4 (F9). Search is an **explicit out-of-v1 deferral**, not an
 * implemented surface. The Search view semantics are owned upstream (P10) and
 * remain **unfrozen**; P12 implements no Search surface and invents no
 * query/index semantics. If/when P10 freezes a Search view contract, P12
 * supplies only the transport binding — this module records the disposition.
 */
export const SEARCH_TRANSPORT_BINDING = {
  status: "deferred-out-of-v1",
  owner: "P10",
  viewSemantics: "unfrozen",
  implemented: false,
  note: "P12 supplies only a transport binding if/when P10 freezes a Search view contract; no query/index semantics are invented.",
} as const;

export type SearchTransportBinding = typeof SEARCH_TRANSPORT_BINDING;
