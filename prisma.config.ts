import { defineConfig } from 'prisma/config'

// Bun loads `.env` itself, but Node (which IDEs' Prisma extensions use to load this) doesn't
if (typeof Bun === 'undefined') {
    try {
        process.loadEnvFile(new URL('.env', import.meta.url));
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
    }
}

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
