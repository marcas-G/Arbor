import type {
  DomainError,
  ResourceAddress,
  ResourceBoundary,
} from "@arbor/domain";

/** P6 `03` §2 (SD §8.2): validate-only capability-ceiling checks on
 * formation. Child capabilities are a narrowing intersection of the
 * parent's; violations yield `AuthorityDenied` and never mutate ownership. */
export interface CapabilityCeilingInput {
  readonly parentBoundary: ResourceBoundary;
  readonly draftBoundary: ResourceBoundary;
  /** P6 carries no PermissionGrant surface (Authority Resolver deferred);
   * any grant payload is structurally forbidden (invariants 13/14). */
  readonly proposedGrants?: ReadonlyArray<unknown>;
  readonly parentPolicyHardDenies?: ReadonlyArray<string>;
  readonly draftPolicyHardDenies?: ReadonlyArray<string>;
}

const addressKey = (address: ResourceAddress): string =>
  JSON.stringify(address);

export const validateCapabilityCeiling = (
  input: CapabilityCeilingInput,
): DomainError | null => {
  // 1. Boundary subset: draft ⊆ parent effective boundary.
  const parentKeys = new Set(input.parentBoundary.addresses.map(addressKey));
  const leaked = input.draftBoundary.addresses.find(
    (address) => !parentKeys.has(addressKey(address)),
  );
  if (leaked !== undefined) {
    return {
      _tag: "AuthorityDenied",
      reason: `resource boundary draft escapes parent boundary: ${addressKey(leaked)}`,
    };
  }

  // 2. Policy tightening: draft hard denies must be a superset of parent's.
  const parentDenies = new Set(input.parentPolicyHardDenies ?? []);
  const draftDenies = new Set(input.draftPolicyHardDenies ?? []);
  for (const deny of parentDenies) {
    if (!draftDenies.has(deny)) {
      return {
        _tag: "AuthorityDenied",
        reason: `workspace policy draft relaxes a parent hard deny: ${deny}`,
      };
    }
  }

  // 3/4. No amplification, no recursive grant delegation (invariants 13/14):
  // the formation surface cannot carry grants at all.
  if ((input.proposedGrants ?? []).length > 0) {
    return {
      _tag: "AuthorityDenied",
      reason:
        "delegation must not amplify governance authority or re-delegate grants",
    };
  }
  return null;
};
