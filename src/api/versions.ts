import {FastifyInstance} from "fastify";
import registerLegacyApi from "./legacy";
import registerV1Api from "./v1";

export interface ApiVersion {
    /** Identifies the version in its docs, including the docs' version dropdown */
    name: string;
    /** Prepended to the paths of the version's endpoints */
    prefix: string;
    /** Shown at the top of the version's docs, after the general description of the proxy */
    description?: string;
    /** Registers the version's schemas and endpoints */
    register: (app: FastifyInstance) => void | Promise<void>;
    /** Set once the version has been replaced by another */
    deprecation?: {
        /** When the version was (or will be) deprecated */
        since: Date;
        /** When the version will be removed, if that has been decided */
        sunset?: Date;
        /** The name of the version which replaces it */
        successor: string;
    };
}

/** Every version of the API, from newest to oldest */
export const API_VERSIONS: ApiVersion[] = [
    {
        name: 'v1',
        prefix: '/v1',
        register: registerV1Api,
    },
    {
        name: 'Legacy (deprecated)',
        prefix: '',
        description: 'This is an implementation of endpoints that were still in use while v1 was being developed ' +
            'and is only intended for backwards compatibility. This version will be removed in the future, but ' +
            'v1 provides equivalent functionality.',
        register: registerLegacyApi,
        deprecation: {
            since: new Date('2026-10-19T00:00:00Z'),
            successor: 'v1',
        },
    },
];

export function getVersion(name: string): ApiVersion {
    const version = API_VERSIONS.find(version => version.name === name);
    if (!version) throw new Error(`Unknown API version: ${name}`);
    return version;
}
