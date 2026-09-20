export type RepositoryFailure<Tag extends string> =
  | { readonly _tag: `${Tag}RevisionConflict` }
  | { readonly _tag: `${Tag}Failure`; readonly cause: unknown };

export type ProjectRepositoryError = RepositoryFailure<"ProjectRepository">;
export type WorkspaceRepositoryError = RepositoryFailure<"WorkspaceRepository">;
export type WorkRepositoryError = RepositoryFailure<"WorkRepository">;
export type SessionRepositoryError = RepositoryFailure<"SessionRepository">;
export type ResourceOwnershipRepositoryError =
  RepositoryFailure<"ResourceOwnershipRepository">;
export type CommandStoreError = RepositoryFailure<"CommandStore">;
export type DomainEventJournalError = RepositoryFailure<"DomainEventJournal">;
export type ConsumerOffsetStoreError = RepositoryFailure<"ConsumerOffsetStore">;
export type ConsumerDeadLetterStoreError =
  RepositoryFailure<"ConsumerDeadLetterStore">;
export type EnvironmentRevisionStoreError =
  RepositoryFailure<"EnvironmentRevisionStore">;

export interface EnvironmentError {
  readonly _tag: "EnvironmentError";
  readonly cause: unknown;
}

export interface ResourceResolutionStale {
  readonly _tag: "ResourceResolutionStale";
  readonly observed: string;
  readonly current: string;
}
