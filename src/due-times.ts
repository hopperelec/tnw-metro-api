import {eventEmitter} from "./events";
import {parsePlatformCode} from "./parsing/rti/times-api";

export type TrainTime = {
    dueIn: number; // -2 "Delayed", -1 "Arrived", 0 "Due", otherwise minutes
    actualScheduledTime: Date | null;
    actualPredictedTime: Date;
}

export type PlatformDueTimes = {
    trn: string;
    time: TrainTime;
}[];

export type DueTimes = Map<
    string, // Platform code
    PlatformDueTimes
>;

let dueTimes: DueTimes;

export function getDueTimes() {
    return structuredClone(dueTimes);
}

export function setDueTimes(newDueTimes: DueTimes) {
    dueTimes = newDueTimes;
    if (dueTimes) eventEmitter.emit("due-times", dueTimes);
}

/** Converts aliases for Monument's platforms (MTE and MTN) to the codes used for their platforms (MTW and MTS) */
export function normaliseStationCode(stationCode: string): string {
    if (stationCode === 'MTE') return 'MTW';
    if (stationCode === 'MTN') return 'MTS';
    return stationCode;
}

/** Whether a station includes the platforms of another, since Monument (MMT) includes both MTS and MTW */
export function stationIncludes(stationCode: string, platformStationCode: string): boolean {
    return stationCode === platformStationCode ||
        (stationCode === 'MMT' && (platformStationCode === 'MTS' || platformStationCode === 'MTW'));
}

/** The trains due at a station, in order of when they're due, or undefined if there are no due times for the station */
export function getStationDueTimes(dueTimes: DueTimes, stationCode: string) {
    const stationDueTimes: ({ platform: number } & PlatformDueTimes[number])[] = [];
    let hasPlatforms = false;
    for (const [platformCode, platformDueTimes] of dueTimes) {
        const platform = parsePlatformCode(platformCode);
        if (!platform || !stationIncludes(stationCode, platform.station)) continue;
        hasPlatforms = true;
        for (const train of platformDueTimes) {
            stationDueTimes.push({ platform: platform.platformNumber, ...train });
        }
    }
    if (!hasPlatforms) return;
    return stationDueTimes.sort((a, b) => a.time.dueIn - b.time.dueIn);
}
