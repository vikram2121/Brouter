/**
 * Database migrations — tracked via schema_migrations table.
 * Each migration runs exactly once. Safe to call on every startup.
 *
 * Adding a migration: append to the MIGRATIONS array with a unique id.
 * Never edit or delete existing entries — add new ones instead.
 */
import { DbConnection } from './connection';
export declare function runMigrations(db: DbConnection): Promise<void>;
//# sourceMappingURL=migrations.d.ts.map