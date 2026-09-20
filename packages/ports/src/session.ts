import { Context, type Effect } from "effect";

export interface AdapterSession {
  readonly id: string;
}

export class TransactionScope extends Context.Service<
  TransactionScope,
  { readonly session: AdapterSession }
>()("arbor/TransactionScope") {}

export interface TransactionOperationalFailure {
  readonly _tag: "TransactionOperationalFailure";
  readonly cause: unknown;
}

export interface TransactionPortService {
  readonly transact: <A, E, R>(
    body: Effect.Effect<A, E, R | TransactionScope>,
  ) => Effect.Effect<
    A,
    E | TransactionOperationalFailure,
    Exclude<R, TransactionScope>
  >;
}

export class TransactionPort extends Context.Service<
  TransactionPort,
  TransactionPortService
>()("arbor/TransactionPort") {}
