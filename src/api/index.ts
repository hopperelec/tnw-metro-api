import Fastify, {type FastifyInstance} from "fastify";
import fastifyCors from "@fastify/cors";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import {API_VERSIONS, type ApiVersion, getVersion} from "./versions";
import {HOST, PORT, PUBLIC_URL} from "./config";

const TITLE = 'Tyne and Wear Metro API proxy';

const DESCRIPTION = 'A proxy and aggregator for real-time data related to the Tyne and Wear Metro. ' +
    'This proxy is not affiliated, associated, authorised, endorsed by, or in any way ' +
    'officially connected with Tyne and Wear Transport Executive or Tyne and Wear Metro. ' +
    'Data is sourced from the same Nexus-owned APIs which power the official Pop app; ' +
    'as such, this proxy can not be held responsible for the accuracy of the data provided.';

/** The URL of the docs, showing a specific version */
function docsUrl(version: ApiVersion): string {
    return `${PUBLIC_URL}/?urls.primaryName=${encodeURIComponent(version.name)}`;
}

/** Registers each version of the API in its own scope, so that each can have its own shared schemas and docs */
async function registerVersion(app: FastifyInstance, version: ApiVersion) {
    await app.register(async scope => {
        if (version.deprecation) {
            // RFC 9745
            const headers: Record<string, string> = {
                'Deprecation': `@${Math.floor(version.deprecation.since.getTime() / 1000)}`,
                'Link': `<${docsUrl(getVersion(version.deprecation.successor))}>; rel="deprecation"; type="text/html"`,
            };
            // RFC 8594
            if (version.deprecation.sunset) headers['Sunset'] = version.deprecation.sunset.toUTCString();
            // Browsers only let cross-origin requests read headers which are exposed
            headers['Access-Control-Expose-Headers'] = Object.keys(headers).join(', ');

            scope.addHook('onRequest', async (_req, res) => {
                // Set on the raw response, so that they're also included in streams, which write to it directly
                for (const [name, value] of Object.entries(headers)) res.raw.setHeader(name, value);
            });
        }

        await scope.register(fastifySwagger, {
            openapi: {
                info: {
                    title: TITLE,
                    description: version.description ? `${DESCRIPTION}\n\n${version.description}` : DESCRIPTION,
                    version: version.name,
                },
                servers: [{ url: PUBLIC_URL }]
            },
            // Name shared schemas by their `$id` (e.g. `collated-train`) instead of `def-0`, `def-1`, etc.
            refResolver: {
                buildLocalReference: (json, _baseUri, _fragment, i) => (json.$id as string | undefined) ?? `def-${i}`
            }
        });
        // Serve the Swagger spec for each version at `/openapi.json` (relative to the version's prefix)
        scope.get('/openapi.json', { schema: { hide: true } }, () => scope.swagger());

        await version.register(scope);
    }, { prefix: version.prefix });
}

/** Registers the docs, which can switch between each version's spec */
async function registerDocs(app: FastifyInstance) {
    await app.register(async scope => {
        // `@fastify/swagger-ui` always adds `/json` and `/yaml`, but these would be the spec of the empty
        //  `@fastify/swagger` below rather than of any version, so they're made to 404 like any unknown route
        scope.addHook('onRoute', route => {
            if (route.url === '/json' || route.url === '/yaml') {
                route.handler = (_req, res) => res.callNotFound();
            }
        });

        // `@fastify/swagger-ui` needs `@fastify/swagger` in its scope, but the docs show each version's spec instead
        await scope.register(fastifySwagger);
        await scope.register(fastifySwaggerUi, {
            routePrefix: '/',
            theme: { title: TITLE },
            uiConfig: {
                // This adds a dropdown at the top right for choosing the version
                urls: API_VERSIONS.map(version => ({
                    name: version.name,
                    url: `${PUBLIC_URL}${version.prefix}/openapi.json`
                })),
                // The docs show the newest version which isn't deprecated by default.
                // Swagger UI supports this, but it's missing from `@fastify/swagger-ui`'s types.
                ...{ 'urls.primaryName': API_VERSIONS.find(version => !version.deprecation)!.name },
            }
        });
    });
}

/** Creates the server, with every version of the API and the docs, without starting it */
export async function createApi(): Promise<FastifyInstance> {
    const app = Fastify({
        ajv: {
            customOptions: {
                keywords: ['example'],
                verbose: true,
                // Allows `oneOf` unions to be validated against the schema matching a property, e.g. subscriptions' `topic`
                discriminator: true
            },
        },
        https: Bun.env.HTTPS_KEY_PATH && Bun.env.HTTPS_CERT_PATH ? {
            key: await Bun.file(Bun.env.HTTPS_KEY_PATH).text(),
            cert: await Bun.file(Bun.env.HTTPS_CERT_PATH).text(),
        } : undefined,
        // When behind a reverse proxy, this should be set to the proxy's address (e.g. "loopback"), so that client IPs
        //  are taken from the `X-Forwarded-For` entry it adds. Trusting every address would let clients spoof their IP.
        trustProxy: Bun.env.TRUST_PROXY || false
    });

    // By default, browsers would only be allowed GET, HEAD and POST, but subscriptions also use DELETE
    await app.register(fastifyCors, { methods: ['GET', 'HEAD', 'POST', 'DELETE'] });

    for (const version of API_VERSIONS) {
        await registerVersion(app, version);
    }
    await registerDocs(app);

    return app;
}

/** Creates and starts the server */
export async function startApi(): Promise<void> {
    const app = await createApi();
    app.listen({ port: PORT, host: HOST }, (err, address) => {
        if (err) {
            console.error(err);
            process.exit(1);
        }
        console.log(`Server listening at ${address}`);
    });
}
