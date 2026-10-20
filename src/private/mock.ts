// A tiny, static mock of the private library, so that the API can be run without it.
// Times are relative to when the data is fetched, so that it always looks current.

import {Readable} from "stream";
import type {GeoApiData, TimetableFile} from "./stub";

/** Returns a Date object representing the given number of minutes from now */
function minutesFromNow(minutes: number): Date {
    return new Date(Date.now() + minutes * 60 * 1000);
}

/** Formats a date in the same way as the Times API */
function formatTimesApiTime(date: Date): string {
    return date.toISOString().replace("Z", "0000+00:00");
}

export async function loadGatewayData(): Promise<void> {}

export function invalidateGatewayData(): void {}

export async function fetchTimesApi(): Promise<string> {
    const train = {
        trn: "101",
        lastEvent: "DEPARTED",
        lastEventLocation: "Jesmond Platform 1",
        lastEventTime: formatTimesApiTime(minutesFromNow(-1)),
        destination: "South Shields",
        line: "YELLOW",
        actualScheduledTime: null,
    };
    return JSON.stringify({
        "HAY;1": [{ ...train, dueIn: 1, actualPredictedTime: formatTimesApiTime(minutesFromNow(1)) }],
        "MTS;1": [{ ...train, dueIn: 3, actualPredictedTime: formatTimesApiTime(minutesFromNow(3)) }],
    });
}

export async function fetchGeoApi(): Promise<GeoApiData> {
    const lastSeenTime = minutesFromNow(-1);
    const hours = lastSeenTime.getHours().toString().padStart(2, "0");
    const minutes = lastSeenTime.getMinutes().toString().padStart(2, "0");
    return {
        statuses: new Map([
            ["101", { destination: "South Shields", lastSeen: `Departed Jesmond platform 1 at ${hours}:${minutes}` }],
        ]),
        warnings: []
    };
}

export function getTimetableRefForDate(date: Date): string {
    return "MOCK";
}

const MOCK_TIMETABLE_FILES: Record<TimetableFile, string> = {
    Timetable: `\
TimetableID,ServiceID,TimetableDesc,EffectiveFrom,EffectiveTo,OPP,BitMask,UpdateTime
,0,Mock Timetable,20-Oct-2026,20-Oct-2026,1,1,
`,
    ServicePattern: `\
ServiceID,TDN,Location,Arrival,Departure,Type,InService,NextLocation
0,101,JES_1,,12:00:00,2,TRUE,HAY_1
0,101,HAY_1,12:02:00,12:02:30,2,TRUE,MTS_1
0,101,MTS_1,12:04:00,,2,TRUE,
`,
};

export function readTimetableFile(ref: string, file: TimetableFile): Readable {
    return Readable.from([Buffer.from(MOCK_TIMETABLE_FILES[file])]);
}
