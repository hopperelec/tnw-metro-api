import {addHeartbeatWarning} from "../../history";
import {Platform} from "../../types";
import {fetchGeoApi} from "../../private";

export type TrainStatus = {
    destination: string;
    lastSeen: string | Platform & {
        type: string;
        time: Date;
    }
};

export type GeoApiData = Map<string, TrainStatus>;

const LAST_SEEN_REGEX = new RegExp(/^(?<type>Approaching|Arrived|Ready to start|Departed) (?<station>.*) platform (?<platformNumber>\d+) at (?<hour>\d\d):(?<minute>\d\d)$/);

export async function pollAndParseGeoAPI(heartbeatStartedAt: Date): Promise<GeoApiData> {
    const {statuses: rawStatuses, warnings} = await fetchGeoApi();

    const statuses: GeoApiData = new Map();
    for (const [trn, {destination, lastSeen}] of rawStatuses) {
        statuses.set(trn, {
            lastSeen: parseLastSeen(lastSeen, heartbeatStartedAt),
            destination
        });
    }

    if (warnings.length) {
        console.warn(`${warnings.length} placemarks have warnings:`);
        for (const warning of warnings) {
            console.log(`- ${warning.message}:\n`, warning.data);
        }
        await addHeartbeatWarning(heartbeatStartedAt, "GEO", warnings);
    }

    return statuses;
}

export function parseLastSeen(lastSeen: string, relativeTo: Date): TrainStatus["lastSeen"] {
    const match = lastSeen.match(LAST_SEEN_REGEX);
    if (!match?.groups) return lastSeen;
    const time = new Date(relativeTo);
    time.setHours(+match.groups.hour, +match.groups.minute, 0, 0);
    if (time > relativeTo) {
        time.setDate(time.getDate() - 1);
    }
    return {
        type: match.groups.type.toUpperCase().replaceAll(' ', '_'),
        station: match.groups.station,
        platformNumber: +match.groups.platformNumber,
        time
    };
}
