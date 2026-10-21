import { defineConfig } from 'prisma/config'

// `.env` is loaded by Bun, so the Prisma CLI must be run with `bun` (as the scripts in `package.json` do).
// Running it with `bunx --bun` doesn't work, since that makes Bun act like Node, which doesn't load `.env`.
export default defineConfig({
    schema: 'prisma/schema.prisma',
    migrations: {
        path: 'prisma/migrations',
    },
    datasource: {
        url: process.env.DATABASE_URL,
        shadowDatabaseUrl: process.env.TEST_DATABASE_URL,
    }
});
