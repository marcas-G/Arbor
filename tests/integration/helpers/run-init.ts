import { Effect, Layer } from "effect";
import type { InitResult } from "../../../src/application/project-bootstrap.js";
import {
  ProjectBootstrap,
  ProjectBootstrapLive,
} from "../../../src/application/project-bootstrap.js";
import { FsNodeLive } from "../../../src/infrastructure/fs-node.js";
import { GitCliLive } from "../../../src/infrastructure/git-cli.js";
import { SqliteNodeLive } from "../../../src/infrastructure/sqlite-node.js";

const Layers = ProjectBootstrapLive.pipe(
  Layer.provideMerge(GitCliLive),
  Layer.provideMerge(FsNodeLive),
  Layer.provideMerge(SqliteNodeLive),
);

export const FakeRun = {
  initProject: (home: string, repo: string): Promise<InitResult> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const bs = yield* ProjectBootstrap;
        return yield* bs.init({ repoPath: repo, home });
      }).pipe(Effect.provide(Layers)),
    ),
};
