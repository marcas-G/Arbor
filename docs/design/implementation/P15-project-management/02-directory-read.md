# P15 — Local ProjectDirectory Read Contract

ProjectDirectory is a Port, not a ViewId and not a Project journal query. Its SQLite adapter returns every local Project as `{ projectId, name, lifecycle, rootWorkspaceId, revision, updatedAt, resourceSource }`, ordered by updatedAt descending then projectId.

`resourceSource` is the exact Project-owned `ProjectResourceSource` tagged
union:

```ts
type ProjectResourceSource =
  | { readonly _tag: "Profile";
      readonly resourceProfileRef: string;
      readonly version: string }
  | { readonly _tag: "ConversationOnly" }
  | { readonly _tag: "LegacyUnknown" };
```

The `/projects` transport serializes this field without reshaping it. It
contains no ResourceBoundary address or host path. Profile availability is a
separate P12 catalog fact and does not rewrite the historical source. This is
the sole Project-owned audit read surface in this local v1 contract; it does
not add a Project-detail ViewId or route.

The HTTP route authenticates the caller. The local principal may read the directory; any other principal fails closed until a separately designed multi-principal visibility resolver exists.

Local v1 intentionally has no pagination, continuation token, visibility revision, UTS #39 collision map or snapshot semantics. Transport code does not own SQL and the browser does not decide visibility.

