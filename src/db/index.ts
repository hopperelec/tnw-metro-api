import {drizzle} from "drizzle-orm/mysql2";
import {createPool} from "mysql2";
import relations from "./relations";

// Run on every new database connection:
// - Drizzle sends and parses dates as UTC, but `TIMESTAMP`s are converted using the session's time zone,
//    so it must be UTC. Otherwise (e.g. on a server using BST) dates would be shifted, and times during the hour
//    repeated when the clocks go back would collide.
// - Allows the optimiser to satisfy `ORDER BY ... LIMIT` by reading an index in order and stopping early, rather than
//    reading and sorting every matching row, which makes most limited history queries orders of magnitude faster.
//    It is only available from MariaDB 11.4.1, so is in a version-specific comment which older versions ignore.
const SESSION_INIT_SQL = "SET time_zone = '+00:00' /*M!110401 , SESSION optimizer_join_limit_pref_ratio = 100 */";

// mysql2 is used instead of Bun's built-in MySQL driver, because Bun's driver doesn't allow
//  modifying each connection when it is created, which is required for running `SESSION_INIT_SQL`.
const pool = createPool({
    uri: Bun.env.DATABASE_URL!,
    // Dates which aren't bound to a column (and so aren't formatted by Drizzle) are formatted by the driver,
    //  so must also be formatted as UTC
    timezone: "Z",
});

// Queries on a connection run in order, so this always runs before anything else does.
// This uses the callback-based pool, since the promise-based one passes the same callback-based connection to this,
//  but has the wrong type for it.
pool.on("connection", connection => {
    connection.query(SESSION_INIT_SQL, error => {
        if (error) console.error("Failed to initialise database session:", error);
    });
});

export const db = drizzle({ client: pool.promise(), relations });
