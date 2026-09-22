import type { UsageCost, UsageUnknownReason } from "@arbor/domain";
import { Context, Layer } from "effect";

/**
 * P12 `04` §3 (E-15, DF-08): the operational Usage derivation.
 *
 * Derived operational state — never canonical (CI-3). `derive` is a pure
 * function of its declared `facts` (`R = never`, deterministic): no ambient
 * I/O, no mutation, no authority. Observe-only by default (invariant 45): no
 * auto stop from a user cost budget.
 *
 * Canonical source (exactly one authoritative source per output, §3.1):
 *   token amounts (input/output/cache)  provider_turns.usage_json
 *   turns                               provider_turns rows
 *   attempts / retries                  provider_attempts rows
 *   tool usage / outcome                tool_invocations
 *   compute time                        executions.admitted_at / settled_at deltas
 *   pricing                             versioned price sheet (operational config)
 *
 * Ownership split with the P10 Usage view (§5): P10 owns the UI-facing
 * `UsageReq` view / query (observe-only); P12 owns this derivation /
 * aggregation and the `UsageCost` ADT. Neither redefines the other.
 */

export type { UsageCost, UsageUnknownReason };

export interface UsageFactTurn {
  readonly providerTurnId: string;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
  };
}

export interface UsageFactAttempt {
  readonly providerTurnId: string;
  readonly attemptNo: number;
  readonly outcome: string;
}

export interface UsageFactToolInvocation {
  readonly invocationId: string;
  readonly outcome: string;
}

export interface UsageFactExecution {
  readonly executionId: string;
  readonly admittedAt: string;
  readonly settledAt?: string;
}

export interface UsagePriceSheet {
  readonly version: string;
  readonly currency: string;
  readonly unitPrices: Readonly<Record<string, number>>;
}

export interface UsageFacts {
  readonly turns: ReadonlyArray<UsageFactTurn>;
  readonly attempts: ReadonlyArray<UsageFactAttempt>;
  readonly toolInvocations: ReadonlyArray<UsageFactToolInvocation>;
  readonly executions: ReadonlyArray<UsageFactExecution>;
  readonly priceSheet?: UsagePriceSheet;
}

export interface UsageDerivation {
  readonly cost: UsageCost;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
  readonly turns: number;
  readonly attempts: number;
  readonly computeMs: number;
}

const UNKNOWN_PRICING: UsageCost = {
  _tag: "Unknown",
  reason: "PricingUnavailable",
};
const UNKNOWN_USAGE: UsageCost = {
  _tag: "Unknown",
  reason: "UsageUnavailable",
};
const UNKNOWN_PARTIAL: UsageCost = { _tag: "Unknown", reason: "PartialUsage" };

const deriveCost = (
  priceSheet: UsagePriceSheet | undefined,
  turns: number,
  turnsWithUsage: number,
  tokens: UsageDerivation["tokens"],
): UsageCost => {
  if (turns === 0) {
    return UNKNOWN_USAGE;
  }
  if (turnsWithUsage < turns) {
    return UNKNOWN_PARTIAL;
  }
  if (
    priceSheet === undefined ||
    priceSheet.version.trim() === "" ||
    priceSheet.currency.trim() === ""
  ) {
    return UNKNOWN_PRICING;
  }
  const rates = priceSheet.unitPrices;
  const pricedKeys = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ].filter((key) => rates[key] !== undefined);
  if (pricedKeys.length === 0) {
    // A versioned sheet with no usable rate is not pricing: never Known{0}.
    return UNKNOWN_PRICING;
  }
  const amount =
    tokens.input * (rates.inputTokens ?? 0) +
    tokens.output * (rates.outputTokens ?? 0) +
    tokens.cacheRead * (rates.cacheReadTokens ?? 0) +
    tokens.cacheWrite * (rates.cacheWriteTokens ?? 0);
  return {
    _tag: "Known",
    amount,
    currency: priceSheet.currency,
    priceSheetVersion: priceSheet.version,
  };
};

export const deriveUsage = (facts: UsageFacts): UsageDerivation => {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let turnsWithUsage = 0;
  for (const turn of facts.turns) {
    if (turn.usage === undefined) {
      continue;
    }
    turnsWithUsage += 1;
    input += turn.usage.inputTokens;
    output += turn.usage.outputTokens;
    cacheRead += turn.usage.cacheReadTokens ?? 0;
    cacheWrite += turn.usage.cacheWriteTokens ?? 0;
  }

  let computeMs = 0;
  for (const execution of facts.executions) {
    if (execution.settledAt === undefined) {
      continue;
    }
    const admitted = Date.parse(execution.admittedAt);
    const settled = Date.parse(execution.settledAt);
    if (
      Number.isFinite(admitted) &&
      Number.isFinite(settled) &&
      settled >= admitted
    ) {
      computeMs += settled - admitted;
    }
  }

  const tokens = { input, output, cacheRead, cacheWrite };
  const turns = facts.turns.length;
  return {
    cost: deriveCost(facts.priceSheet, turns, turnsWithUsage, tokens),
    tokens,
    turns,
    attempts: facts.attempts.length,
    computeMs,
  };
};

export interface UsageServiceShape {
  readonly derive: (facts: UsageFacts) => UsageDerivation;
}

export class UsageService extends Context.Service<
  UsageService,
  UsageServiceShape
>()("arbor/observability/UsageService") {}

export const UsageServiceLive: Layer.Layer<UsageService> = Layer.succeed(
  UsageService,
  { derive: deriveUsage },
);
