import {
    type AnyMySqlColumn,
    foreignKey,
    index,
    int,
    json,
    mysqlEnum,
    mysqlTable,
    primaryKey,
    smallint,
    text,
    timestamp,
    tinyint,
    uniqueIndex,
    varchar,
} from "drizzle-orm/mysql-core";
import {getColumnTable, getTableName} from "drizzle-orm";
import type {JsonValue} from "../types";

// The database was originally created by Prisma, so constraints and indexes are named using its conventions,
//  and columns are in the order they ended up in after Prisma's migrations.
// Every foreign key has an index named the same as it, which MariaDB creates automatically when no other index starts
//  with its column, but these are declared explicitly since some queries rely on them.

/** A foreign key which cascades both updates and deletes */
function cascadingForeignKey(column: AnyMySqlColumn, foreignColumn: AnyMySqlColumn) {
    return foreignKey({
        name: `${getTableName(getColumnTable(column))}_${column.name}_fkey`,
        columns: [column],
        foreignColumns: [foreignColumn],
    }).onUpdate("cascade").onDelete("cascade");
}

/** The index used by a foreign key on the column */
function foreignKeyIndex(column: AnyMySqlColumn) {
    return index(`${getTableName(getColumnTable(column))}_${column.name}_fkey`).on(column);
}

/** A raw string from an API, used as a lookup value */
function lookupString() {
    return varchar({ length: 191 }).charSet("utf8mb4").collate("utf8mb4_uca1400_nopad_as_cs");
}

/** A timestamp with millisecond precision, stored in UTC (since the session time zone is always UTC) */
function timestamp3() {
    return timestamp({ fsp: 3 });
}

// --- Core Models ---

/** A heartbeat, representing a single cycle of data retrieval. */
export const heartbeat = mysqlTable("Heartbeat", {
    /** The time the heartbeat started. */
    startedAt: timestamp3().primaryKey(),
    /** The time the heartbeat ended, or null if it is still ongoing or was interrupted. */
    endedAt: timestamp3(),
});

/** The type of event associated with a train status update. */
export const trainEventType = mysqlTable("TrainEventType", {
    id: tinyint({ unsigned: true }).autoincrement().primaryKey(),
    /** Human-readable name of the event type. */
    name: lookupString().notNull(),
}, table => [
    uniqueIndex("TrainEventType_name_key").on(table.name),
]);

/** A train as identified by its TRN. */
export const train = mysqlTable("Train", {
    id: smallint({ unsigned: true }).autoincrement().primaryKey(),
    /** Train Running Number. Should always be a 3-digit number, but stored as a string in case of malformed data. */
    trn: lookupString().notNull(),
}, table => [
    uniqueIndex("Train_trn_key").on(table.trn),
]);

/** A platform at a station. */
export const parsedPlatform = mysqlTable("ParsedPlatform", {
    id: int().autoincrement().primaryKey(),
    /** Human-readable station name. */
    station: lookupString().notNull(),
    /** Platform number */
    platformNumber: tinyint({ unsigned: true }).notNull(),
}, table => [
    uniqueIndex("ParsedPlatform_station_platformNumber_key").on(table.station, table.platformNumber),
]);

/** A platform string as received from an API, before parsing. */
export const unparsedPlatform = mysqlTable("UnparsedPlatform", {
    id: int().autoincrement().primaryKey(),
    /** The raw platform string. Do not expect this to be in any particular format. */
    raw: lookupString().notNull(),
    /** A parsed platform, if parsing was successful. */
    parsedPlatformId: int(),
}, table => [
    uniqueIndex("UnparsedPlatform_raw_key").on(table.raw),
    foreignKeyIndex(table.parsedPlatformId),
    cascadingForeignKey(table.parsedPlatformId, parsedPlatform.id),
]);

/** A destination for a train. Not always a station name (e.g. "Not In Service", "Terminates"). */
export const destination = mysqlTable("Destination", {
    id: int().autoincrement().primaryKey(),
    /** The destination string. */
    name: lookupString().notNull(),
}, table => [
    uniqueIndex("Destination_name_key").on(table.name),
]);

// --- Times API ---

/** De-duplicated data from the Times API for a single train. */
export const timesApiTrainData = mysqlTable("TimesApiTrainData", {
    id: int().autoincrement().primaryKey(),
    /** The train this update is for. */
    trainId: smallint({ unsigned: true }).notNull(),
    /** The type of the last event for this train. */
    lastEventTypeId: tinyint({ unsigned: true }).notNull(),
    /** The time of the last event for this train. */
    lastEventTime: timestamp3().notNull(),
    /** The platform associated with the last event for this train. */
    lastEventLocationId: int().notNull(),
    /** The heartbeat during which this data first appeared. */
    startHeartbeatAt: timestamp3().notNull(),
    /**
     * The heartbeat during which this data was replaced or the train went inactive.
     * This is null if the data is still current.
     */
    endHeartbeatAt: timestamp3(),
    /**
     * The first of `plannedDestinations` (i.e. where the train is currently heading).
     * Duplicated here so that data can be efficiently filtered by it.
     */
    firstPlannedDestinationId: int(),
}, table => [
    uniqueIndex("TimesApiTrainData_trainId_startHeartbeatAt_key").on(table.trainId, table.startHeartbeatAt),
    foreignKeyIndex(table.lastEventLocationId),
    foreignKeyIndex(table.lastEventTypeId),
    foreignKeyIndex(table.startHeartbeatAt),
    foreignKeyIndex(table.endHeartbeatAt),
    foreignKeyIndex(table.firstPlannedDestinationId),
    cascadingForeignKey(table.trainId, train.id),
    cascadingForeignKey(table.startHeartbeatAt, heartbeat.startedAt),
    cascadingForeignKey(table.endHeartbeatAt, heartbeat.startedAt),
    cascadingForeignKey(table.lastEventLocationId, unparsedPlatform.id),
    cascadingForeignKey(table.lastEventTypeId, trainEventType.id),
    cascadingForeignKey(table.firstPlannedDestinationId, destination.id),
]);

/**
 * A planned destination for a train according to the Times API.
 * Note that changes to planned destinations are only reflected when the last event also changes.
 */
export const plannedDestination = mysqlTable("PlannedDestination", {
    /** The Times API status this planned destination belongs to. */
    statusId: int().notNull(),
    /** The destination. */
    destinationId: int().notNull(),
    /** The time from which this destination is planned. */
    fromTime: timestamp3().notNull(),
    /** The platform this destination is planned from. */
    fromPlatformId: int().notNull(),
}, table => [
    primaryKey({ columns: [table.statusId, table.destinationId, table.fromTime] }),
    foreignKeyIndex(table.destinationId),
    foreignKeyIndex(table.fromPlatformId),
    cascadingForeignKey(table.statusId, timesApiTrainData.id),
    cascadingForeignKey(table.destinationId, destination.id),
    cascadingForeignKey(table.fromPlatformId, unparsedPlatform.id),
]);

// --- Geo API ---

/**
 * De-duplicated data from the Geo API for a single train.
 *
 * Note:
 * The Geo API provides a "last seen" string for each train, which is expected to be in the format
 *  `<event type> <station name> platform <platform number> at <time>`.
 * This table intends to store the parsed components of that string where possible.
 * If the string cannot be parsed, the raw string is stored in `rawLastSeen` instead,
 *  and the parsed fields (`lastEventPlatformId`, `lastEventTypeId`, `lastEventTime`) are left null.
 */
export const geoApiTrainData = mysqlTable("GeoApiTrainData", {
    id: int().autoincrement().primaryKey(),
    /** The train this update is for. */
    trainId: smallint({ unsigned: true }).notNull(),
    /** The current destination for this train. */
    destinationId: int().notNull(),
    /**
     * The raw last seen string from the API if it could not be parsed.
     * See note in table documentation.
     */
    rawLastSeen: varchar({ length: 191 }),

    // Extracted fields from the last seen string

    /**
     * The platform this status is associated with.
     * See note in table documentation.
     */
    lastEventPlatformId: int(),
    /**
     * The type of the event.
     * See note in table documentation.
     */
    lastEventTypeId: tinyint({ unsigned: true }),
    /**
     * The time of the event.
     * See note in table documentation.
     */
    lastEventTime: timestamp3(),
    /** The heartbeat during which this data first appeared. */
    startHeartbeatAt: timestamp3().notNull(),
    /**
     * The heartbeat during which this data was replaced or the train went inactive.
     * This is null if the data is still current.
     */
    endHeartbeatAt: timestamp3(),
}, table => [
    uniqueIndex("GeoApiTrainData_trainId_startHeartbeatAt_key").on(table.trainId, table.startHeartbeatAt),
    foreignKeyIndex(table.destinationId),
    foreignKeyIndex(table.lastEventTypeId),
    foreignKeyIndex(table.lastEventPlatformId),
    foreignKeyIndex(table.startHeartbeatAt),
    foreignKeyIndex(table.endHeartbeatAt),
    cascadingForeignKey(table.trainId, train.id),
    cascadingForeignKey(table.startHeartbeatAt, heartbeat.startedAt),
    cascadingForeignKey(table.endHeartbeatAt, heartbeat.startedAt),
    cascadingForeignKey(table.destinationId, destination.id),
    cascadingForeignKey(table.lastEventPlatformId, parsedPlatform.id),
    cascadingForeignKey(table.lastEventTypeId, trainEventType.id),
]);

// --- Diagnostics ---

/** An identifier for an API that generated an error or warning. */
export const ApiType = {
    TIMES: "TIMES",
    GEO: "GEO",
    GATEWAY: "GATEWAY",
} as const;
export type ApiType = typeof ApiType[keyof typeof ApiType];

/** An error that occurred during a heartbeat. */
export const heartbeatError = mysqlTable("HeartbeatError", {
    id: int().autoincrement().primaryKey(),
    /** The API that produced this error. */
    api: mysqlEnum(ApiType).notNull(),
    /** A human-readable error message. */
    message: text().notNull(),
    /** The heartbeat this error was produced during. */
    heartbeatAt: timestamp3().notNull(),
}, table => [
    foreignKeyIndex(table.heartbeatAt),
    cascadingForeignKey(table.heartbeatAt, heartbeat.startedAt),
]);

/** A warning generated during a heartbeat. */
export const heartbeatWarning = mysqlTable("HeartbeatWarning", {
    id: int().autoincrement().primaryKey(),
    /** The API that produced this warning. */
    api: mysqlEnum(ApiType).notNull(),
    /** Additional arbitrary data related to this warning. */
    data: json().$type<JsonValue>().notNull(),
    /** The heartbeat this warning was produced during. */
    heartbeatAt: timestamp3().notNull(),
}, table => [
    foreignKeyIndex(table.heartbeatAt),
    cascadingForeignKey(table.heartbeatAt, heartbeat.startedAt),
]);
