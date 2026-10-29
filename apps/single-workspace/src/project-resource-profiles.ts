import { createHash } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type {
  ProjectResourceProfilePortService,
  ProjectResourceProfileSummary,
  TrustedProjectResourceProfile,
} from "@arbor/ports";
import { Effect, Option } from "effect";

export interface HostProjectResourceProfileConfig {
  readonly resourceProfileRef: string;
  readonly version?: string;
  readonly displayName: string;
  readonly directory: string;
}

export interface ProjectResourceProfileFileSystem {
  readonly realpath: (path: string) => string;
  readonly isDirectory: (path: string) => boolean;
  readonly assertReadable: (path: string) => void;
}

const localFileSystem: ProjectResourceProfileFileSystem = {
  realpath: (path) => realpathSync(path),
  isDirectory: (path) => statSync(path).isDirectory(),
  assertReadable: (path) => accessSync(path, constants.R_OK | constants.X_OK),
};

interface LoadedProfile {
  readonly summary: ProjectResourceProfileSummary;
  readonly trusted?: TrustedProjectResourceProfile;
}

const validOpaqueIdentifier = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);

const hasTraversalSegment = (value: string): boolean =>
  value.split(/[\\/]+/u).some((part) => part === "..");

const validateConfiguration = (
  profiles: ReadonlyArray<HostProjectResourceProfileConfig>,
): void => {
  const refs = new Set<string>();
  for (const profile of profiles) {
    if (
      typeof profile.resourceProfileRef !== "string" ||
      !validOpaqueIdentifier(profile.resourceProfileRef) ||
      (profile.version !== undefined &&
        (typeof profile.version !== "string" ||
          !validOpaqueIdentifier(profile.version))) ||
      typeof profile.displayName !== "string" ||
      profile.displayName.trim().length === 0 ||
      profile.displayName.length > 120 ||
      /\p{Cc}/u.test(profile.displayName) ||
      typeof profile.directory !== "string" ||
      profile.directory.length === 0 ||
      profile.directory.includes("\u0000") ||
      !isAbsolute(profile.directory) ||
      hasTraversalSegment(profile.directory) ||
      isAbsolute(profile.displayName) ||
      profile.displayName
        .toLocaleLowerCase()
        .includes(profile.directory.toLocaleLowerCase()) ||
      refs.has(profile.resourceProfileRef)
    ) {
      // Deliberately never include the submitted path, ref, or display name:
      // configuration errors can be copied into daemon logs.
      throw new Error("invalid project resource profile configuration");
    }
    refs.add(profile.resourceProfileRef);
  }
};

const pathBoundVersion = (canonicalPath: string): string =>
  `v-${createHash("sha256").update(canonicalPath, "utf8").digest("hex").slice(0, 24)}`;

const loadProfile = (
  config: HostProjectResourceProfileConfig,
  fileSystem: ProjectResourceProfileFileSystem,
): LoadedProfile => {
  let canonicalPath: string;
  try {
    canonicalPath = fileSystem.realpath(config.directory);
    if (!fileSystem.isDirectory(canonicalPath)) {
      const version =
        config.version ?? pathBoundVersion(resolve(config.directory));
      return {
        summary: Object.freeze({
          resourceProfileRef: config.resourceProfileRef,
          version,
          displayName: config.displayName,
          available: false,
        }),
      };
    }
    fileSystem.assertReadable(canonicalPath);
  } catch {
    // Missing, inaccessible, and invalid-at-runtime paths are safe catalog
    // states, not diagnostic payloads. Never retain the exception/path.
    return {
      summary: Object.freeze({
        resourceProfileRef: config.resourceProfileRef,
        version: config.version ?? pathBoundVersion(resolve(config.directory)),
        displayName: config.displayName,
        available: false,
      }),
    };
  }
  const version = config.version ?? pathBoundVersion(canonicalPath);
  const summary: ProjectResourceProfileSummary = Object.freeze({
    resourceProfileRef: config.resourceProfileRef,
    version,
    displayName: config.displayName,
    available: true,
  });
  return {
    summary,
    trusted: Object.freeze({
      ...summary,
      available: true,
      canonicalAddress: Object.freeze({
        _tag: "FileTree" as const,
        path: canonicalPath,
      }),
    }),
  };
};

/** Builds an immutable host snapshot at process startup. All filesystem
 * inspection is complete before the returned pure in-memory Port is used. */
export const makeProjectResourceProfilePort = (
  profiles: ReadonlyArray<HostProjectResourceProfileConfig>,
  fileSystem: ProjectResourceProfileFileSystem = localFileSystem,
): ProjectResourceProfilePortService => {
  validateConfiguration(profiles);
  const loaded = profiles
    .map((profile) => loadProfile(profile, fileSystem))
    .sort((left, right) =>
      left.summary.resourceProfileRef.localeCompare(
        right.summary.resourceProfileRef,
      ),
    );
  const summaries = Object.freeze(loaded.map((profile) => profile.summary));
  const bySelection = new Map(
    loaded
      .filter(
        (
          profile,
        ): profile is LoadedProfile & {
          trusted: TrustedProjectResourceProfile;
        } => profile.trusted !== undefined,
      )
      .map((profile) => [
        `${profile.summary.resourceProfileRef}\u0000${profile.summary.version}`,
        profile.trusted,
      ]),
  );
  return Object.freeze({
    list: () => Effect.succeed(summaries),
    resolve: (resourceProfileRef: string, version: string) =>
      Effect.sync(() =>
        Option.fromNullishOr(
          bySelection.get(`${resourceProfileRef}\u0000${version}`),
        ),
      ),
  });
};

/** P12 first-release single-root environment adapter. The generic Port
 * accepts multiple host entries, but this environment contract intentionally
 * retains only the governed ARBOR_PROJECT_ROOT input. */
export const projectResourceProfilesFromEnvironment = (
  environment: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<HostProjectResourceProfileConfig> => {
  const legacyRoot = environment.ARBOR_PROJECT_ROOT;
  if (legacyRoot === undefined || legacyRoot.length === 0) return [];
  return [
    {
      resourceProfileRef:
        environment.ARBOR_PROJECT_PROFILE_REF ?? "project-root",
      ...(environment.ARBOR_PROJECT_PROFILE_VERSION !== undefined
        ? { version: environment.ARBOR_PROJECT_PROFILE_VERSION }
        : {}),
      displayName: environment.ARBOR_PROJECT_PROFILE_NAME ?? "Project files",
      directory: legacyRoot,
    },
  ];
};
