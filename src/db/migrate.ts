// Applies any migrations which haven't been applied yet.
// Run this instead of `drizzle-kit migrate`, since it also handles databases which were created by Prisma.
// This is temporary for the migration from Prisma to Drizzle; the baseline migration can take over from there.

import {sql} from "drizzle-orm";
import {type MigrationConfig, readMigrationFiles} from "drizzle-orm/migrator";
import {migrate as applyMigrations} from "drizzle-orm/mysql-core";
import {migrate} from "drizzle-orm/mysql2/migrator";
import {db} from ".";

const migrationsFolder = `${import.meta.dir}/../../drizzle`;

/** The Prisma migrations which the baseline Drizzle migration is equivalent to */
const PRISMA_MIGRATIONS = [
    "20251229053137_init",
    "20251231012011_reduce_sizes",
    "20260101122332_started_at_as_heartbeat_pk",
    "20261004000000_history_improvements",
];

async function tableExists(name: string): Promise<boolean> {
    const [rows] = await db.execute(sql`
        SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ${name}
    `) as unknown as [unknown[]];
    return rows.length > 0;
}

/**
 * A database created by Prisma already has the schema created by the baseline migration, so it is only recorded as
 *  having been applied. This is only done if every Prisma migration (and nothing else) has been applied, since the
 *  schema would otherwise be different.
 */
async function baselinePrismaDatabase(): Promise<void> {
    if (!await tableExists("_prisma_migrations") || await tableExists("__drizzle_migrations")) return;

    const [rows] = await db.execute(sql`
        SELECT migration_name AS name, finished_at IS NOT NULL AS finished
        FROM _prisma_migrations
        WHERE rolled_back_at IS NULL
    `) as unknown as [{ name: string; finished: number }[]];
    const unfinished = rows.filter(row => !row.finished).map(row => row.name);
    const applied = new Set(rows.filter(row => row.finished).map(row => row.name));
    const missing = PRISMA_MIGRATIONS.filter(name => !applied.has(name));
    const unknown = [...applied].filter(name => !PRISMA_MIGRATIONS.includes(name));
    if (unfinished.length || missing.length || unknown.length) {
        throw new Error(
            "The database was created by Prisma, but its schema isn't the one the baseline migration creates. " +
            `Unfinished: ${unfinished}. Missing: ${missing}. Unknown: ${unknown}. ` +
            "Apply the missing Prisma migrations (using the last commit which used Prisma), then try again."
        );
    }

    // `init` records a single migration as applied without running it.
    // It isn't typed, since it's meant for `drizzle-kit pull --init`.
    const [baseline] = readMigrationFiles({ migrationsFolder });
    const failResponse = await applyMigrations([baseline], db, { migrationsFolder, init: true } as MigrationConfig);
    if (failResponse) throw new Error(`Failed to record the baseline migration as applied (${failResponse.exitCode})`);
    console.log(`Recorded ${baseline.name} as applied, since the database was created by Prisma`);
}

try {
    await baselinePrismaDatabase();
    await migrate(db, { migrationsFolder });
    console.log("Database is up to date");
} finally {
    await db.$client.end();
}
