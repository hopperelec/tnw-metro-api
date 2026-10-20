// Converts data into the formats used before versioning was added, which the legacy API keeps using

import type {HeartbeatTimes} from "../../heartbeat";
import type * as GeoAPI from "../../parsing/rti/geo-api";
import * as TimesAPI from "../../parsing/rti/times-api";
import type {CollatedTrain} from "../../types";

/** Timestamps of heartbeats, which the legacy API used instead of their start and end times */
export function downgradeHeartbeatTimes(heartbeat: HeartbeatTimes): Date {
    return heartbeat.startedAt;
}

// This is a type rather than an interface, so that it can be used as a `SourceContainer`
export type LegacyCollatedTrain = {
    timesAPI?: Omit<NonNullable<CollatedTrain['timesAPI']>, 'lastEvent'> & {
        lastEvent: Omit<TimesAPI.LastEvent, 'location'> & { location: string }
    };
    /** The Geo API's data, which was called the train statuses API */
    trainStatusesAPI?: { destination: string; lastSeen: string };
};

const LAST_SEEN_TYPES: Record<string, string> = {
    APPROACHING: 'Approaching',
    ARRIVED: 'Arrived',
    READY_TO_START: 'Ready to start',
    DEPARTED: 'Departed',
};

/** Converts the Geo API's last seen status back into the message it was parsed from */
function downgradeLastSeen(lastSeen: GeoAPI.TrainStatus['lastSeen']): string {
    // The inverse of `parseLastSeen`
    return typeof lastSeen === 'string'
        ? lastSeen
        : `${LAST_SEEN_TYPES[lastSeen.type]} ${lastSeen.station} platform ${lastSeen.platformNumber} at ` +
            lastSeen.time.toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
}

/** Converts a train's status into the legacy format, where locations are the strings they were parsed from */
export function downgradeCollatedTrain(train: CollatedTrain): LegacyCollatedTrain {
    const legacyTrain: LegacyCollatedTrain = {};
    if (train.timesAPI) {
        const {location} = train.timesAPI.lastEvent;
        legacyTrain.timesAPI = {
            ...train.timesAPI,
            lastEvent: {
                ...train.timesAPI.lastEvent,
                location: typeof location === 'string' ? location : TimesAPI.formatLastEventLocation(location)
            }
        };
    }
    if (train.geoAPI) {
        legacyTrain.trainStatusesAPI = {
            destination: train.geoAPI.destination,
            lastSeen: downgradeLastSeen(train.geoAPI.lastSeen)
        };
    }
    return legacyTrain;
}

/** A due time with the train's status, which is omitted if the train isn't active */
export function downgradeDueTime<DueTime extends { trn: string }>(dueTime: DueTime, train: CollatedTrain | undefined) {
    return { ...dueTime, ...(train && { status: downgradeCollatedTrain(train) }) };
}
