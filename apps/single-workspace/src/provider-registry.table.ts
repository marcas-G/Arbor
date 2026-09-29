import type { ProtocolAdapter } from "@arbor/ports";
import { providerFakeAdapter } from "@arbor/provider-fake";
import { providerOpenaiAdapter } from "@arbor/provider-openai";

/**
 * P16 `01` §6 — the static, closed provider registry table.
 *
 * This is a Whitelisted data file (P16 `02` §0 WL): additions are one
 * declaration line per new family. No logic, no discovery (INV-P16-3);
 * Layer construction stays inside the adapter families (INV-P16-2).
 */
export const PROVIDER_REGISTRY_TABLE: ReadonlyArray<ProtocolAdapter> = [
  providerFakeAdapter,
  providerOpenaiAdapter,
];
