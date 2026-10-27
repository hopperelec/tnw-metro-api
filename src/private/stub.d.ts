// Stubs for the private library, which provides access to upstream APIs and datasets.
// `./check-stub.ts` checks that these match the library, if it is installed.

import type {Readable} from "stream";
import type {JsonValue} from "../types.ts";

// --- Gateway ---

/** Loads any data needed from the gateway, if it isn't already loaded */
export function loadGatewayData(): Promise<void>;

/** Forgets any data loaded from the gateway, so that it is loaded again */
export function invalidateGatewayData(): void;

// --- Times API ---

/**
 * Fetches the raw response body from the Times API.
 * Fetched as text instead of JSON so the body can be logged if it fails to parse.
 */
export function fetchTimesApi(): Promise<string>;

// --- Geo API ---

export type TrainStatus = {
    destination: string;
    /** e.g., "Departed Monument platform 2 at 12:34" */
    lastSeen: string;
};

export type GeoApiWarning = {
    message: string;
    data: JsonValue;
};

export type GeoApiData = {
    /** Map of TRNs to their statuses */
    statuses: Map<string, TrainStatus>;
    warnings: GeoApiWarning[];
};

/** Fetches the status of each train from the Geo API */
export function fetchGeoApi(): Promise<GeoApiData>;

// --- Timetables ---

/** Gets the ref of the timetable which applies to a date ('EMPTY' if no trains are running) */
export function getTimetableRefForDate(date: Date): string;

export type TimetableFile = "ServicePattern" | "Timetable";

/** Opens one of the CSV files for a timetable */
export function readTimetableFile(ref: string, file: TimetableFile): Readable;
