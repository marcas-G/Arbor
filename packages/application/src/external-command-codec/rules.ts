import type { IdTypeName } from "@arbor/domain";

export type Rule =
  | { readonly kind: "string" }
  | { readonly kind: "non-empty-string" }
  | { readonly kind: "trimmed-non-empty-string" }
  | { readonly kind: "iso-timestamp" }
  | {
      readonly kind: "bounded-string";
      readonly minLength: number;
      readonly maxLength: number;
    }
  | { readonly kind: "opaque-identifier" }
  | { readonly kind: "boolean" }
  | { readonly kind: "integer" }
  | { readonly kind: "positive-safe-integer" }
  | { readonly kind: "canonical-identifier" }
  | { readonly kind: "id"; readonly idType: IdTypeName }
  | { readonly kind: "actor" }
  | { readonly kind: "literal"; readonly value: string | number | boolean }
  | { readonly kind: "nullable"; readonly inner: Rule }
  | { readonly kind: "optional"; readonly inner: Rule }
  | {
      readonly kind: "array";
      readonly item: Rule;
      readonly minItems?: number;
      readonly maxItems?: number;
    }
  | { readonly kind: "object"; readonly fields: Readonly<Record<string, Rule>> }
  | { readonly kind: "record" }
  | {
      readonly kind: "union";
      readonly tag: string;
      readonly cases: Readonly<Record<string, Rule>>;
    };

export const string: Rule = { kind: "string" };
export const nonEmptyString: Rule = { kind: "non-empty-string" };
export const trimmedNonEmptyString: Rule = { kind: "trimmed-non-empty-string" };
export const isoTimestamp: Rule = { kind: "iso-timestamp" };
export const boundedString = (minLength: number, maxLength: number): Rule => ({
  kind: "bounded-string",
  minLength,
  maxLength,
});
export const opaqueIdentifier: Rule = { kind: "opaque-identifier" };
export const boolean: Rule = { kind: "boolean" };
export const integer: Rule = { kind: "integer" };
export const positiveSafeInteger: Rule = { kind: "positive-safe-integer" };
export const canonicalIdentifier: Rule = { kind: "canonical-identifier" };
export const record: Rule = { kind: "record" };
export const id = (idType: IdTypeName): Rule => ({ kind: "id", idType });
export const actor: Rule = { kind: "actor" };
export const literal = (value: string | number | boolean): Rule => ({
  kind: "literal",
  value,
});
export const nullable = (inner: Rule): Rule => ({ kind: "nullable", inner });
export const optional = (inner: Rule): Rule => ({ kind: "optional", inner });
export const array = (
  item: Rule,
  bounds?: { readonly minItems?: number; readonly maxItems?: number },
): Rule => ({
  kind: "array",
  item,
  ...(bounds?.minItems === undefined ? {} : { minItems: bounds.minItems }),
  ...(bounds?.maxItems === undefined ? {} : { maxItems: bounds.maxItems }),
});
export const object = (fields: Readonly<Record<string, Rule>>): Rule => ({
  kind: "object",
  fields,
});
export const union = (
  tag: string,
  cases: Readonly<Record<string, Rule>>,
): Rule => ({
  kind: "union",
  tag,
  cases,
});
