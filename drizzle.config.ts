import {defineConfig} from "drizzle-kit";

// `.env` is loaded by Bun, so drizzle-kit must be run with `bun` (as the scripts in `package.json` do).
// Running it with `bunx --bun` doesn't work, since that makes Bun act like Node, which doesn't load `.env`.
export default defineConfig({
    dialect: "mysql",
    schema: "./src/db/schema.ts",
    out: "./drizzle",
    dbCredentials: {
        url: process.env.DATABASE_URL!,
    },
});
