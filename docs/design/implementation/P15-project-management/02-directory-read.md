# P15 — Local ProjectDirectory Read Contract

ProjectDirectory is a Port, not a ViewId and not a Project journal query. Its SQLite adapter returns every local Project as { projectId, name, lifecycle, rootWorkspaceId, revision, updatedAt }, ordered by updatedAt descending then projectId.

The HTTP route authenticates the caller. The local principal may read the directory; any other principal fails closed until a separately designed multi-principal visibility resolver exists.

Local v1 intentionally has no pagination, continuation token, visibility revision, UTS #39 collision map or snapshot semantics. Transport code does not own SQL and the browser does not decide visibility.

