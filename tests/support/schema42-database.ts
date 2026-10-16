/** Historical schema-42 fixture exports retained for migration qualification. */
export {
  createSchema42PrivateTestDirectory,
  createSchema42TestDatabase,
  createSchema42TestDatabaseFactory,
  type Schema42TestDatabase,
  type Schema42TestDatabaseFactory,
  type Schema42TestDatabaseOptions,
  Schema42TestDatabaseSetupError,
  upgradeSchema42TestDatabase,
  withSchema42TestDatabase,
} from "./schema44-database.js";
