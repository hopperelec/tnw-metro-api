import * as mock from "./mock";
import type * as Stub from "./stub";

const PRIVATE_LIBRARY = "tnw-metro-api-private";

async function loadPrivateLibrary(): Promise<typeof Stub> {
    let library: typeof Stub;
    try {
        // @ts-ignore: The library may not be installed
        library = await import("tnw-metro-api-private");
    } catch (e) {
        // Only fall back if the library itself is missing, not if something it depends on is
        if (e?.code !== "ERR_MODULE_NOT_FOUND" || !e.message?.includes(`'${PRIVATE_LIBRARY}'`)) throw e;
        if (Bun.env.REQUIRE_PRIVATE_LIBRARY === "true") {
            throw new Error(`${PRIVATE_LIBRARY} is not installed, but REQUIRE_PRIVATE_LIBRARY is true`, { cause: e });
        }
        console.warn(`${PRIVATE_LIBRARY} is not installed, so mock data will be used instead`);
        return mock;
    }

    // The stubs are only checked against the library by `tsc`, so check that the library being used has the same exports
    const expectedExports = Object.keys(mock);
    const actualExports = Object.keys(library);
    const missingExports = expectedExports.filter(name => !actualExports.includes(name));
    const unexpectedExports = actualExports.filter(name => !expectedExports.includes(name));
    if (missingExports.length || unexpectedExports.length) {
        console.warn(
            `${PRIVATE_LIBRARY} does not match its stubs.`,
            "Missing exports:", missingExports,
            "Unexpected exports:", unexpectedExports
        );
    }
    return library;
}

export const {
    loadGatewayData,
    invalidateGatewayData,
    fetchTimesApi,
    fetchGeoApi,
    getTimetableRefForDate,
    readTimetableFile
} = await loadPrivateLibrary();
