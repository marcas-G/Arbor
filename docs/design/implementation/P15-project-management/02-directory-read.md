# P15 — ProjectDirectory Read Contract

ProjectDirectory is a principal-scoped endpoint, not a ViewId and not a project journal query. Each request authenticates its principal. The resolver provides scope and visibility facts.

Continuation token is opaque, non-bearer and bound to principal, scope, visibility revision, sort and filter. Every page atomically verifies token, current visibility revision and each result row authorization. Revoke wins before later pages return a row. Grant/revoke or visible-row create/rename/close expires the snapshot with DirectorySnapshotExpired. Resolver errors fail closed; unauthorized/token failures use a common non-oracle problem shape.

Rows carry opaque navigation projectId, name, lifecycle, rootWorkspaceId, revision, updatedAt; collision rows add displayDiscriminator. Keys/skeletons do not cross the server boundary. Collision grouping is over the complete authorized snapshot, including visual skeleton collisions, not merely a page. Discriminators are random, fixed-width, persistent, scope-local and non-ProjectId-derived.

Shared infrastructure timing is outside the contract; protocol inputs, token/error/response shape, pagination and application-created delay must not depend on invisible-project activity.

