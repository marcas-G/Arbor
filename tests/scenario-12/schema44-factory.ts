import type { createCurrentSchemaTestDatabaseFactory } from "../support/schema44-database.js";

type Factory = Awaited<
  ReturnType<typeof createCurrentSchemaTestDatabaseFactory>
>;

let factory: Factory | null = null;

/** The gate test file owns the template lifecycle (beforeAll/afterAll); the
 * scenario modules read the same factory through this accessor. */
export const setCurrentSchema44Factory = (next: Factory): void => {
  factory = next;
};

export const currentSchema44Factory = (): Factory => {
  if (factory === null) {
    throw new Error("schema44 template factory not initialized");
  }
  return factory;
};
