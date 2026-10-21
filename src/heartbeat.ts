import {loadGatewayData, invalidateGatewayData} from "./private";
import {ACTIVE_REFRESH_MINIMUM_TIMEOUT, PASSIVE_REFRESH_INTERVAL} from "./constants";
import {type DueTimes, setDueTimes} from "./due-times";
import {eventEmitter} from "./events";
import {addHeartbeatError, startHeartbeat, endHeartbeat, addApiData} from "./history";
import type {CollatedTrain} from "./types";
import {ApiType} from "../generated/prisma/enums";
import type {JsonValue} from "@prisma/client/runtime/client";
import {pollAndParseTimes} from "./parsing/rti/times-api";
import {pollAndParseGeoAPI} from "./parsing/rti/geo-api";

// --- Last Heartbeat Time ---

export type HeartbeatTimes = {
    startedAt: Date;
    endedAt: Date | null;
}

const lastHeartbeatTimes: HeartbeatTimes = {
    startedAt: new Date(0),
    endedAt: null
};

export function getLastHeartbeatTimes(): HeartbeatTimes {
    return structuredClone(lastHeartbeatTimes);
}

/// --- Collated Trains ---

const collatedTrains = new Map<string, CollatedTrain>();

function addToCollated<Key extends keyof CollatedTrain>(trn: string, key: Key, data: CollatedTrain[Key]) {
    collatedTrains.set(trn, { ...collatedTrains.get(trn), [key]: data });
}

export function getActiveTrains(): Map<string, CollatedTrain> {
    return structuredClone(collatedTrains);
}

export function getCollatedTrain(trn: string): CollatedTrain | undefined {
    return structuredClone(collatedTrains.get(trn));
}

export function isTrainActive(trn: string): boolean {
    return collatedTrains.has(trn);
}

// --- Diagnostics ---

export type HeartbeatError = {
    api: ApiType,
    message: string,
    heartbeat: HeartbeatTimes,
};

export type HeartbeatWarning = {
    api: ApiType,
    data: JsonValue,
    heartbeat: HeartbeatTimes,
};

// --- Heartbeat Functions ---

let exponentialBackoffLevel = 0;
let heartbeatsSinceLastInvalidation = 0;

async function heartbeat(): Promise<void> {
    const startedAt = new Date();

    // Failing to save history shouldn't stop the live data from updating.
    // Any changes which aren't saved are saved by the next heartbeat which is, since the data each heartbeat is compared
    //  with is only updated once its changes have been saved.
    let savingHistory = true;
    try {
        await startHeartbeat(startedAt);
    } catch (e) {
        console.error("Failed to save heartbeat:", e);
        savingHistory = false;
    }

    let success = true;
    await loadGatewayData().catch(
        async e => {
            console.error("Unrecoverable error while loading gateway data:", e);
            success = false;
            await addHeartbeatError(startedAt, "GATEWAY", e.toString());
        }
    );
    const [timesApiData, geoApiData] = await Promise.all([
        pollAndParseTimes(startedAt).catch(
            async e => {
                console.error("Unrecoverable error while polling/parsing Times API:", e);
                success = false;
                await addHeartbeatError(startedAt, "TIMES", e.toString());
                return null;
            }
        ),
        pollAndParseGeoAPI(startedAt).catch(
            async e => {
                console.error("Unrecoverable error while polling/parsing Geo API:", e);
                success = false;
                await addHeartbeatError(startedAt, "GEO", e.toString());
                return null;
            }
        )
    ]);

    if (success) {
        exponentialBackoffLevel = 0;
    } else {
        if (++heartbeatsSinceLastInvalidation >= (2 ** exponentialBackoffLevel)) {
            console.log("Trying new gateway data");
            invalidateGatewayData();
            heartbeatsSinceLastInvalidation = 0;
            exponentialBackoffLevel++;
        }
    }

    const endTime = new Date();
    if (savingHistory) {
        try {
            await addApiData(startedAt, timesApiData, geoApiData);
            await endHeartbeat(startedAt, endTime);
        } catch (e) {
            console.error("Failed to save history:", e);
        }
    }

    lastHeartbeatTimes.startedAt = startedAt;
    lastHeartbeatTimes.endedAt = endTime;
    const previousTrains = new Map(collatedTrains);
    collatedTrains.clear();
    if (timesApiData) {
        for (const [trn, trainData] of timesApiData.trains) {
            addToCollated(trn, "timesAPI", trainData);
        }
    }
    if (geoApiData) {
        for (const [trn, trainData] of geoApiData) {
            addToCollated(trn, "geoAPI", trainData);
        }
    }
    // Due times must be set after the trains are collated, since the legacy due times streams include the trains' statuses
    setDueTimes(timesApiData?.dueTimes);

    eventEmitter.emit("heartbeat-end", {
        heartbeat: getLastHeartbeatTimes(),
        previousTrains,
        currentTrains: new Map(collatedTrains),
        dueTimes: timesApiData?.dueTimes
    } satisfies HeartbeatEnd);
}

/** The results of a heartbeat, including the collated trains before it so that changes can be found */
export interface HeartbeatEnd {
    heartbeat: HeartbeatTimes;
    previousTrains: Map<string, CollatedTrain>;
    currentTrains: Map<string, CollatedTrain>;
    /** Undefined if the due times couldn't be fetched */
    dueTimes?: DueTimes;
}

// Heartbeats must not overlap, since each one's data is compared with the previous one's.
// Failures are logged rather than thrown, since heartbeats are run by an interval.
let heartbeatInProgress: Promise<void> | null = null;
function runHeartbeat(): Promise<void> {
    heartbeatInProgress ??= heartbeat()
        .catch(console.error)
        .finally(() => { heartbeatInProgress = null; });
    return heartbeatInProgress;
}

let heartbeatInterval: Timer;
export async function restartHeartbeat(): Promise<void> {
    if (heartbeatInProgress) return heartbeatInProgress;
    if (Date.now() - lastHeartbeatTimes.startedAt.getTime() < ACTIVE_REFRESH_MINIMUM_TIMEOUT) return;
    clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(runHeartbeat, PASSIVE_REFRESH_INTERVAL);
    await runHeartbeat();
}
