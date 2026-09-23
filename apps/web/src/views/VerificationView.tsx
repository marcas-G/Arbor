/**
 * verification view: criteriaResults table (required marker + verdict badge),
 * evidenceRefs, acceptance block. Absent verdict/acceptance = blank slot.
 */
import type { VerificationRes } from "@arbor/api-contracts";
import { Badge } from "../components/Badge.js";
import { Empty } from "../components/Empty.js";
import { EnumBadge, Mono, TimeText } from "./shared.js";

export function VerificationView({ view }: { readonly view: VerificationRes }) {
  return (
    <div className="arbor-view-stack">
      <div className="arbor-badge-row">
        {view.verificationId == null ? null : (
          <Mono>{view.verificationId}</Mono>
        )}
        {view.verdict == null ? null : <EnumBadge label={view.verdict} />}
      </div>
      {view.criteriaResults.length === 0 ? (
        <Empty>无判定结果</Empty>
      ) : (
        <table className="arbor-table">
          <thead>
            <tr>
              <th scope="col">criterionId</th>
              <th scope="col">requirement</th>
              <th scope="col">required</th>
              <th scope="col">verdict</th>
            </tr>
          </thead>
          <tbody>
            {view.criteriaResults.map((result) => (
              <tr key={result.criterionId}>
                <td>
                  <Mono>{result.criterionId}</Mono>
                </td>
                <td>{result.requirement}</td>
                <td>
                  <Badge tone={result.required ? "branch" : "muted"}>
                    {result.required ? "required" : "optional"}
                  </Badge>
                </td>
                <td>
                  <EnumBadge label={result.verdict} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="arbor-kv">
        <span className="arbor-kv-label">evidenceRefs</span>
        {view.evidenceRefs.length === 0 ? (
          <Empty>无证据</Empty>
        ) : (
          <ul className="arbor-row-list">
            {view.evidenceRefs.map((evidenceId) => (
              <li key={evidenceId}>
                <Mono>{evidenceId}</Mono>
              </li>
            ))}
          </ul>
        )}
      </div>
      {view.acceptance == null ? null : (
        <div className="arbor-kv">
          <span className="arbor-kv-label">acceptance</span>
          <span>
            <Mono>{view.acceptance.acceptanceId}</Mono> {view.acceptance.actor}{" "}
            <TimeText at={view.acceptance.acceptedAt} />
          </span>
        </div>
      )}
    </div>
  );
}
