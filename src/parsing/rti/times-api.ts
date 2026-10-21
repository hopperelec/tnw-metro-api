import {LOCATION_ABBREVIATIONS, PASSENGER_STOPS} from "../../constants";
import type {LocationAbbreviation, Platform} from "../../types";
import type {DueTimes, PlatformDueTimes, TrainTime} from "../../due-times";
import {addHeartbeatWarning} from "../../history";
import {fetchTimesApi} from "../../private";

// Below is the expected API response format for reference
// Times are in the format YYYY-MM-DD'T'HH:MM:SS.0000000+00:00
//
// type RawTimes = Record<`${string};${number}`, {
//     trn: string;
//     lastEvent: Uppercase<ActiveTrainState>
//     lastEventLocation: `${string} Platform ${number}`;
//     lastEventTime: string;
//     destination: string;
//     dueIn: number; // -2 "Delayed", -1 "Arrived", 0 "Due", otherwise minutes
//     line: "UNKNOWN" | "YELLOW" | "GREEN";
//     actualScheduledTime: string | null;
//     actualPredictedTime: string;
// }>

export type PlannedDestination = {
    name: string;
    from: {
        platformCode: string;
        time: Date;
    }
};

export type LastEvent = {
    type: string; // Should be ActiveTrainState
    location: string | Platform;
    time: Date;
};

export type ParsedTrain = {
    lastEvent: LastEvent;
    plannedDestinations: PlannedDestination[];
    nextPlatforms: {
        code: string;
        time: TrainTime;
    }[];
};

export interface ParsedTimes {
    trains: Map<string, ParsedTrain>;
    dueTimes: DueTimes
}

const LAST_EVENT_LOCATION_REGEX = new RegExp(/^(?<station>.+?) Platform (?<platform>[1-4])$/);

/** Parses a last event location, e.g. "Monument Platform 2" */
export function parseLastEventLocation(location: string): Platform | undefined {
    const match = location.match(LAST_EVENT_LOCATION_REGEX);
    if (match?.groups) return {
        station: match.groups.station,
        platformNumber: +match.groups.platform
    };
}

/** The inverse of `parseLastEventLocation` */
export function formatLastEventLocation(platform: Platform): string {
    return `${platform.station} Platform ${platform.platformNumber}`;
}

function compareStrings(a: string, b: string) {
    return a < b ? -1 : a > b ? 1 : 0;
}

export function normalisePlannedDestinations(plannedDestinations: PlannedDestination[]): PlannedDestination[] {
    const sorted = [...plannedDestinations].sort((a, b) =>
        a.from.time.getTime() - b.from.time.getTime() || compareStrings(a.from.platformCode, b.from.platformCode)
    );
    // Only keep changes in planned destinations, and the first of any planned at the same time.
    const normalised: PlannedDestination[] = [];
    const seen = new Set<string>();
    for (const destination of sorted) {
        if (destination.name === normalised.at(-1)?.name) continue;
        const key = `${destination.name}|${destination.from.time.getTime()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        normalised.push(destination);
    }
    return normalised;
}

function isPlatformPossible(station: LocationAbbreviation, platform: number): "no" | "unusual" | "yes" {
    switch (station) {
        case "MMT":
            return [1, 2, 3, 4].includes(platform) ? "unusual" : "no";
        case "MTW":
            return platform === 3 || platform === 4 ? "yes" : "no";
        case "MTE":
            return platform === 3 || platform === 4 ? "unusual" : "no";
        case "MTN":
        case "PJC":
            return platform === 1 || platform === 2 ? "unusual" : "no";
        case "SSS":
        case "SHL":
            if (platform === 2) return "yes";
            if (platform === 1) return "unusual";
            return "no";
        case "SUN":
            if (platform === 1 || platform === 3) return "yes";
            if (platform === 2 || platform === 4) return "unusual";
            return "no";
        default:
            return (platform === 1 || platform === 2) ? "yes" : "no";
    }
}

export async function pollAndParseTimes(heartbeatStartedAt: Date): Promise<ParsedTimes> {
    const responseBody = await fetchTimesApi();
    let rawTimes: any;
    try {
        rawTimes = JSON.parse(responseBody);
    } catch (e) {
        console.log(responseBody);
        throw e;
    }

    if (typeof rawTimes !== "object") throw new Error("Times API response is not an object", rawTimes);

    const parsedTimes: ParsedTimes = {
        trains: new Map(),
        dueTimes: new Map()
    };

    // Map of TRNs to their parsed last event locations
    const parsedLocations = new Map<string, Platform>();

    const warnings = new Map<string, {message: string, object?: any}[]>();
    for (const [platformCode, trains] of Object.entries(rawTimes)) {

        const platformWarnings: {message: string, object?: any}[] = [];

        if (!Array.isArray(trains)) {
            platformWarnings.push({ message: "Value is not an array", object: trains });
            continue;
        }

        // Don't depend on the platform ID being as expected, but do still warn if it isn't
        const platformCodeMatch = platformCode.match(PLATFORM_CODE_REGEX);
        if (platformCodeMatch?.groups) {
            const stationCode = platformCodeMatch.groups.station as LocationAbbreviation;
            if (PASSENGER_STOPS.includes(stationCode)) {
                const platformPossible = isPlatformPossible(stationCode, +platformCodeMatch.groups.platform);
                if (platformPossible === "no") {
                    platformWarnings.push({ message: `Unrecognised platform`, object: trains });
                } else if (platformPossible === "unusual") {
                    platformWarnings.push({ message: `Unusual platform`, object: trains });
                }
            } else if (stationCode in LOCATION_ABBREVIATIONS) {
                platformWarnings.push({ message: `Not a passenger stop`, object: trains });
            } else {
                platformWarnings.push({ message: `Station code not recognised`, object: trains });
            }
        } else {
            platformWarnings.push({ message: "Platform ID is not in the expected format", object: trains });
        }

        const platformDueTimes: PlatformDueTimes = [];
        parsedTimes.dueTimes.set(platformCode, platformDueTimes);

        for (const train of trains) {
            function addTrainWarning(message: string) {
                platformWarnings.push({ message, object: train });
            }

            let {trn, lastEvent: lastEventType, lastEventLocation, lastEventTime, destination, dueIn, line, actualScheduledTime, actualPredictedTime} = train;

            // Check TRN first so that it can be referenced in parsing errors for other fields
            if (typeof trn !== "string") {
                addTrainWarning("TRN is not a string");
                continue;
            }

            lastEventTime = new Date(lastEventTime);
            actualScheduledTime = actualScheduledTime ? new Date(actualScheduledTime) : null;
            actualPredictedTime = new Date(actualPredictedTime);
            if (
                typeof lastEventType !== "string" ||
                typeof lastEventLocation !== "string" ||
                isNaN(lastEventTime.getTime()) ||
                typeof destination !== "string" ||
                typeof dueIn !== "number" ||
                typeof line !== "string" ||
                (actualScheduledTime !== null && isNaN(actualScheduledTime.getTime())) ||
                isNaN(actualPredictedTime.getTime())
            ) {
                addTrainWarning("One or more fields are not of the expected type");
                continue;
            }

            const parsedLocation = parseLastEventLocation(lastEventLocation);
            if (parsedLocation) {
                parsedLocations.set(trn, parsedLocation);
            } else {
                addTrainWarning("Last event location is not in the expected format");
            }
            const lastEvent = {
                type: lastEventType,
                // Store raw string for now, to make inconsistency checks easier
                location: lastEventLocation,
                time: lastEventTime
            };

            const dueTime: TrainTime = { dueIn, actualScheduledTime, actualPredictedTime };
            platformDueTimes.push({ trn, time: dueTime });

            let parsedTrain = parsedTimes.trains.get(trn);
            if (parsedTrain) {
                const firstTime = parsedTrain.lastEvent.time.getTime();
                const thisTime = lastEvent.time.getTime();
                if (firstTime === thisTime) {
                    if (parsedTrain.lastEvent.type !== lastEventType) {
                        addTrainWarning(`Inconsistent last event type for train ${trn} at time ${lastEventTime}. First was ${parsedTrain.lastEvent.type}, latest is ${lastEventType}. Keeping first.`);
                    }
                    if (parsedTrain.lastEvent.location !== lastEventLocation) {
                        addTrainWarning(`Inconsistent last event station for train ${trn} at time ${lastEventTime}. First was ${parsedTrain.lastEvent.location}, latest is ${lastEventLocation}. Keeping first.`);
                    }
                } else {
                    // Sometimes the Times API can respond with a mix of new and outdated last events.
                    // Ideally, we would add these as old history entries, but there isn't a simple way to do that.
                    // Instead, we'll just keep the most up-to-date last event.
                    if (firstTime < thisTime) {
                        parsedTrain.lastEvent = lastEvent;
                    }
                }
            } else {
                parsedTrain = {
                    lastEvent,
                    plannedDestinations: [],
                    nextPlatforms: []
                };
                parsedTimes.trains.set(trn, parsedTrain);
            }

            parsedTrain.plannedDestinations.push({
                name: destination,
                from: {
                    platformCode,
                    time: actualPredictedTime
                }
            });

            parsedTrain.nextPlatforms.push({
                code: platformCode,
                time: dueTime
            });
        }

        platformDueTimes.sort((a, b) => a.time.dueIn - b.time.dueIn);

        if (platformWarnings.length > 0) {
            warnings.set(platformCode, platformWarnings);
        }
    }

    // Replace last event location strings with parsed objects where possible
    for (const [trn, location] of parsedLocations.entries()) {
        parsedTimes.trains.get(trn)!.lastEvent.location = location
    }

    if (warnings.size > 0) {
        await addHeartbeatWarning(heartbeatStartedAt, "TIMES", Object.fromEntries(warnings));
        if (warnings.size === 1) {
            const [platformCode, platformWarnings] = Array.from(warnings)[0];
            console.log(`${platformWarnings.length} warning(s) in Times API response for ${platformCode}:`);
            for (const warning of platformWarnings) {
                console.warn(warning.message);
                if (warning.object) {
                    console.log(JSON.stringify(warning.object));
                }
            }
        } else {
            console.log(`${warnings.size} platforms with warnings in Times API response:`);
            for (const [platformCode, platformWarnings] of warnings.entries()) {
                console.log(`${platformWarnings.length} warning(s) for ${platformCode}:`);
                for (const warning of platformWarnings) {
                    console.warn(`- ${warning.message}`);
                    if (warning.object) {
                        console.log(JSON.stringify(warning.object));
                    }
                }
            }
        }
    }

    for (const train of parsedTimes.trains.values()) {
        train.plannedDestinations = normalisePlannedDestinations(train.plannedDestinations);
        train.nextPlatforms.sort((a, b) => a.time.dueIn - b.time.dueIn);
    }

    return parsedTimes;
}

export const PLATFORM_CODE_REGEX = new RegExp(/^(?<station>[A-Z]{3});(?<platform>[1-4])$/);
export function parsePlatformCode(platformCode: string): Platform | undefined {
    const match = platformCode.match(PLATFORM_CODE_REGEX);
    if (match?.groups) return {
        station: match.groups.station,
        platformNumber: +match.groups.platform
    };
}