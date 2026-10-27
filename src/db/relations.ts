import {defineRelations} from "drizzle-orm";
import * as schema from "./schema";

// MariaDB does not support the lateral joins which Drizzle uses to load relations (`with`).
//  Related data must be selected using joins instead.
// Relations are still defined here so that they can be used to filter relational queries.
export default defineRelations(schema, r => ({
    heartbeat: {
        /** Times API train data that started during this heartbeat. */
        startedTimesApiTrainData: r.many.timesApiTrainData({ alias: "Started" }),
        /** Times API train data that ended during this heartbeat (i.e., was replaced or the train went inactive). */
        endedTimesApiTrainData: r.many.timesApiTrainData({ alias: "Ended" }),
        /** Geo API train data that started during this heartbeat. */
        startedGeoApiTrainData: r.many.geoApiTrainData({ alias: "Started" }),
        /** Geo API train data that ended during this heartbeat (i.e., was replaced or the train went inactive). */
        endedGeoApiTrainData: r.many.geoApiTrainData({ alias: "Ended" }),
        /** Errors that occurred during this heartbeat. */
        errors: r.many.heartbeatError(),
        /** Warnings generated during this heartbeat. */
        warnings: r.many.heartbeatWarning(),
    },
    trainEventType: {
        /** Times API train data with this event type. */
        timesApiTrainData: r.many.timesApiTrainData(),
        /** Geo API train data with this event type. */
        geoApiTrainData: r.many.geoApiTrainData(),
    },
    train: {
        /** Times API data for this train. */
        timesApiHistory: r.many.timesApiTrainData(),
        /** Geo API statuses for this train. */
        geoApiHistory: r.many.geoApiTrainData(),
    },
    parsedPlatform: {
        /** Geo API updates where this platform was parsed from the last seen event. */
        geoApiUpdates: r.many.geoApiTrainData(),
        /** Unparsed platforms that were successfully parsed to this platform. */
        unparsedEntries: r.many.unparsedPlatform(),
    },
    unparsedPlatform: {
        /** A parsed platform, if parsing was successful. */
        parsedPlatform: r.one.parsedPlatform({
            from: r.unparsedPlatform.parsedPlatformId,
            to: r.parsedPlatform.id,
        }),
        /** Times API train data for which this platform was the last event location. */
        timesApiTrainData: r.many.timesApiTrainData(),
        /** Planned destinations planned from this platform onwards. */
        plannedDestinations: r.many.plannedDestination(),
    },
    destination: {
        /** Planned destinations (from the Times API) associated with this destination. */
        plannedDestinations: r.many.plannedDestination(),
        /** Times API train data whose first planned destination is this destination. */
        timesApiFirstPlannedDestinations: r.many.timesApiTrainData(),
        /** Geo API statuses currently heading to this destination. */
        geoApiStatuses: r.many.geoApiTrainData(),
    },
    timesApiTrainData: {
        /** The train this update is for. */
        train: r.one.train({
            from: r.timesApiTrainData.trainId,
            to: r.train.id,
            optional: false,
        }),
        /** The heartbeat during which this data first appeared. */
        startHeartbeat: r.one.heartbeat({
            from: r.timesApiTrainData.startHeartbeatAt,
            to: r.heartbeat.startedAt,
            optional: false,
            alias: "Started",
        }),
        /**
         * The heartbeat during which this data was replaced or the train went inactive.
         * This is null if the data is still current.
         */
        endHeartbeat: r.one.heartbeat({
            from: r.timesApiTrainData.endHeartbeatAt,
            to: r.heartbeat.startedAt,
            alias: "Ended",
        }),
        /** The platform associated with the last event for this train. */
        lastEventLocation: r.one.unparsedPlatform({
            from: r.timesApiTrainData.lastEventLocationId,
            to: r.unparsedPlatform.id,
            optional: false,
        }),
        /** The type of the last event for this train. */
        lastEventType: r.one.trainEventType({
            from: r.timesApiTrainData.lastEventTypeId,
            to: r.trainEventType.id,
            optional: false,
        }),
        /**
         * The planned destinations for this train.
         * Note that changes to planned destinations are only reflected when the last event also changes.
         */
        plannedDestinations: r.many.plannedDestination(),
        /**
         * The first of `plannedDestinations` (i.e. where the train is currently heading).
         * Duplicated here so that data can be efficiently filtered by it.
         */
        firstPlannedDestination: r.one.destination({
            from: r.timesApiTrainData.firstPlannedDestinationId,
            to: r.destination.id,
        }),
    },
    plannedDestination: {
        /** The Times API status this planned destination belongs to. */
        status: r.one.timesApiTrainData({
            from: r.plannedDestination.statusId,
            to: r.timesApiTrainData.id,
            optional: false,
        }),
        /** The destination. */
        destination: r.one.destination({
            from: r.plannedDestination.destinationId,
            to: r.destination.id,
            optional: false,
        }),
        /** The platform this destination is planned from. */
        fromPlatform: r.one.unparsedPlatform({
            from: r.plannedDestination.fromPlatformId,
            to: r.unparsedPlatform.id,
            optional: false,
        }),
    },
    geoApiTrainData: {
        /** The train this update is for. */
        train: r.one.train({
            from: r.geoApiTrainData.trainId,
            to: r.train.id,
            optional: false,
        }),
        /** The heartbeat during which this data first appeared. */
        startHeartbeat: r.one.heartbeat({
            from: r.geoApiTrainData.startHeartbeatAt,
            to: r.heartbeat.startedAt,
            optional: false,
            alias: "Started",
        }),
        /**
         * The heartbeat during which this data was replaced or the train went inactive.
         * This is null if the data is still current.
         */
        endHeartbeat: r.one.heartbeat({
            from: r.geoApiTrainData.endHeartbeatAt,
            to: r.heartbeat.startedAt,
            alias: "Ended",
        }),
        /** The current destination for this train. */
        destination: r.one.destination({
            from: r.geoApiTrainData.destinationId,
            to: r.destination.id,
            optional: false,
        }),
        /**
         * The platform this status is associated with.
         * See note in table documentation.
         */
        lastEventPlatform: r.one.parsedPlatform({
            from: r.geoApiTrainData.lastEventPlatformId,
            to: r.parsedPlatform.id,
        }),
        /**
         * The type of the event.
         * See note in table documentation.
         */
        lastEventType: r.one.trainEventType({
            from: r.geoApiTrainData.lastEventTypeId,
            to: r.trainEventType.id,
        }),
    },
    heartbeatError: {
        /** The heartbeat this error was produced during. */
        heartbeat: r.one.heartbeat({
            from: r.heartbeatError.heartbeatAt,
            to: r.heartbeat.startedAt,
            optional: false,
        }),
    },
    heartbeatWarning: {
        /** The heartbeat this warning was produced during. */
        heartbeat: r.one.heartbeat({
            from: r.heartbeatWarning.heartbeatAt,
            to: r.heartbeat.startedAt,
            optional: false,
        }),
    },
}));
