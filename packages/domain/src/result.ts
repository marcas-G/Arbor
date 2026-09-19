import type { DomainError } from "./errors.js";

export type DomainResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DomainError };

export const ok = <T>(value: T): DomainResult<T> => ({ ok: true, value });

export const err = (error: DomainError): DomainResult<never> => ({
  ok: false,
  error,
});
