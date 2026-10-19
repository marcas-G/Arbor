/**
 * P13-004 shared rendering helpers. Views receive ONLY api-contracts DTOs
 * (`03` §1.1); unknown enum labels render verbatim through `statusTone`
 * (unmapped → muted). Optional-absent fields are blank slots, never zeros.
 */

import type { ExecutionSummary, UsageRow } from "@arbor/api-contracts";
import type { ReactNode } from "react";
import { Badge } from "../components/Badge.js";
import { statusTone } from "../tokens.js";

/** Monospace run for IDs / timestamps / event / binding vocabulary. */
export function Mono({ children }: { readonly children: ReactNode }) {
  return <span className="arbor-mono">{children}</span>;
}

/** Enum-ish label badge: text verbatim, tone via the frozen statusTone map. */
export function EnumBadge({ label }: { readonly label: string }) {
  return <Badge tone={statusTone(label)}>{label}</Badge>;
}

/** P12 `04` TR-5: `UsageCost` ADT — `_tag` discriminant; Unknown renders
 * "unknown", never 0. Known renders `amount currency`. */
export function formatCost(cost: UsageRow["cost"]): string {
  return cost._tag === "Known"
    ? `${String(cost.amount)} ${cost.currency}`
    : "unknown";
}

/** ISO timestamp: localized text, raw value always inspectable via title. */
export function TimeText({ at }: { readonly at: string }) {
  const parsed = new Date(at);
  const text = Number.isNaN(parsed.getTime()) ? at : parsed.toLocaleString();
  return (
    <time className="arbor-mono" dateTime={at} title={at}>
      {text}
    </time>
  );
}

export function SandboxPolicySummary({
  policy,
}: {
  readonly policy: NonNullable<ExecutionSummary["sandboxPolicy"]>;
}) {
  return (
    <dl className="arbor-view-stack" aria-label="Sandbox policy">
      <div>
        <dt>Sandbox status</dt>
        <dd>
          <EnumBadge label={policy.status} />
        </dd>
      </div>
      <div>
        <dt>Profile</dt>
        <dd>{policy.profile}</dd>
      </div>
      <div>
        <dt>Provider</dt>
        <dd>{policy.providerId}</dd>
      </div>
      <div>
        <dt>Network mode</dt>
        <dd>{policy.networkMode}</dd>
      </div>
      <div>
        <dt>Policy revision</dt>
        <dd>{policy.policyRevision}</dd>
      </div>
      <div>
        <dt>Expires at</dt>
        <dd>
          <TimeText at={policy.expiresAt} />
        </dd>
      </div>
    </dl>
  );
}
