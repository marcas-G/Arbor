import type { CommandRejection } from "./rejection.js";

export type CommandResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CommandRejection };

export const commandOk = <T>(value: T): CommandResult<T> => ({
  ok: true,
  value,
});

export const commandErr = (error: CommandRejection): CommandResult<never> => ({
  ok: false,
  error,
});
