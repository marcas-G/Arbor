import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect, Layer } from "effect";
import { FsError, FsPort } from "../application/ports.js";

const wrap = (op: string) => (err: unknown) => new FsError({ op, message: String(err) });

export const FsNodeLive = Layer.succeed(
  FsPort,
  FsPort.of({
    mkdirp: (path) =>
      Effect.tryPromise({
        try: () => mkdir(path, { recursive: true }),
        catch: wrap("mkdirp"),
      }).pipe(Effect.asVoid),
    writeFile: (path, content) =>
      Effect.tryPromise({
        try: () => writeFile(path, content, "utf8"),
        catch: wrap("writeFile"),
      }).pipe(Effect.asVoid),
    pathJoin: (...parts) => parts.join("/"),
    pathResolve: (path) => resolve(path),
  }),
);
