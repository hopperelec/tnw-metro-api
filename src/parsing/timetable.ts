import {NEW_DAY_HOUR} from "../constants";
import csvParser from "csv-parser";
import {getTimetableRefForDate, readTimetableFile} from "../private";

export type ExpectedTrainState = {
    event: 'ARRIVED' | 'DEPARTED' | 'APPROACHING' | 'TERMINATED';
    location: string;
    inService: boolean;
    destination: string;
}

export type TrainTimetableEntry = {
    type: 1 | 2 | 3 | 4;
    location: string;
    arrivalTime?: number; // in seconds since midnight
    departureTime?: number; // in seconds since midnight
    inService: boolean;
    destination: string;
}

export type TrainTimetable = TrainTimetableEntry[];

interface TimetableMetadata {
    ref: string;
    serviceId: string;
    description: string;
    effectiveFrom: string;
    effectiveTo: string;
    bitmask: BigInt,
}

export interface Timetable extends TimetableMetadata {
    trains: Record<string, TrainTimetable>;
    expiration: NodeJS.Timeout | 'never';
}

const TIMETABLES: Record<string, Timetable> = {
    EMPTY: {
        ref: "EMPTY",
        serviceId: "0",
        description: "No trains running",
        effectiveFrom: "01-Jan-1970",
        effectiveTo: "19-Jan-2038",
        bitmask: BigInt(0),
        trains: {},
        expiration: 'never',
    },
};
export default TIMETABLES;

const CACHE_DURATION_MS = 12 * 60 * 60 * 1000; // 12 hours

const SERVICE_PATTERN_HEADERS = {
    ServiceID: null, // duplicate from Timetable.csv
    TDN: 'tdn',
    Location: 'location',
    Arrival: 'arrivalTime',
    Departure: 'departureTime',
    Type: 'type',
    InService: 'inService',
    NextLocation: null, // easily derived
}

const TIMETABLE_HEADERS = {
    TimetableID: null, // always blank; use name instead
    ServiceID: 'serviceId',
    TimetableDesc: 'description',
    EffectiveFrom: 'effectiveFrom',
    EffectiveTo: 'effectiveTo',
    OPP: null, // always '1' and I don't know what it means
    BitMask: 'bitmask',
    UpdateTime: null, // always blank
}

function createExpirationTimeout(ref: string) {
    return setTimeout(() => {
        // Avoid potential memory leak by forgetting timetables that haven't been used for a while
        delete TIMETABLES[ref];
    }, CACHE_DURATION_MS);
}

function resetExpiration(timetable: Timetable) {
    if (timetable.expiration === 'never') return;
    if (timetable.expiration) {
        clearTimeout(timetable.expiration);
    }
    timetable.expiration = createExpirationTimeout(timetable.ref);
}

export async function getTimetable(ref: string) {
    if (TIMETABLES[ref]) {
        resetExpiration(TIMETABLES[ref]);
        return TIMETABLES[ref];
    }
    return new Promise<Timetable>(async (resolve, reject) => {
        const trains: Record<string, TrainTimetable> = {};
        let metadata: TimetableMetadata;
        await Promise.all([
            // trains (ServicePattern.csv)
            new Promise<void>((resolve, _) => {
                readTimetableFile(ref, "ServicePattern")
                    .pipe(csvParser({
                        mapHeaders: ({header}) => SERVICE_PATTERN_HEADERS[header],
                        mapValues: ({header, value}) => {
                            if (header === 'arrivalTime' || header === 'departureTime') {
                                if (!value) return;
                                const [hours, minutes, seconds] = value.split(':').map(Number);
                                return (hours * 3600 + minutes * 60 + seconds) % 86400;
                            }
                            if (header === 'inService') {
                                if (value.toLowerCase() === 'true') return true;
                                if (value.toLowerCase() === 'false') return false;
                                throw new Error(`Invalid value for InService: ${value}`);
                            }
                            if (header === 'type') return +value;
                            return value;
                        }
                    }))
                    .on('data', (entry) => {
                        if (
                            entry.arrivalTime !== undefined && entry.departureTime !== undefined &&
                            compareTimes(entry.arrivalTime, entry.departureTime) > 0
                        ) {
                            reject(new Error(`Arrival time (${entry.arrivalTime}) is greater than departure time (${entry.departureTime}) for TDN ${entry.tdn} in ${ref}/ServicePattern.csv`));
                        }
                        if (entry.arrivalTime === undefined && entry.departureTime === undefined) {
                            reject(new Error(`Both arrival time and departure time are missing, when at least one must be set, for TDN ${entry.tdn} in ${ref}/ServicePattern.csv`));
                        }
                        const {tdn, ...rest} = entry;
                        if (!trains[tdn]) trains[tdn] = [];
                        trains[tdn].push(rest);
                    })
                    .on('end', () => {
                        for (const trainTimetable of Object.values(trains)) {
                            // Ensure it is in the correct order
                            trainTimetable.sort((a, b) =>
                                compareTimes(a.arrivalTime || a.departureTime, b.departureTime || b.arrivalTime)
                            );
                            // Set destinations
                            let destination: string;
                            for (let i = trainTimetable.length - 1; i >= 0; i--) {
                                const entry = trainTimetable[i];
                                if (
                                    entry.departureTime === undefined ||
                                    // For the GTFS data, the first and last entries sometimes aren't termini
                                    //  so permit the last entry to not be a terminus
                                    i === trainTimetable.length - 1
                                ) {
                                    destination = entry.location;
                                }
                                entry.destination = destination;
                            }
                        }
                        resolve();
                    })
            }),
            // metadata (Timetable.csv)
            new Promise<void>((resolve, reject) => {
                readTimetableFile(ref, "Timetable")
                    .pipe(csvParser({
                        mapHeaders: ({header}) => TIMETABLE_HEADERS[header],
                        mapValues: ({header, value}) => {
                            if (header === 'bitmask') {
                                return BigInt('0b' + value);
                            }
                            return value;
                        }
                    }))
                    .on('data', (row) => {
                        if (metadata) {
                            reject(new Error(`Multiple rows in ${ref}/Timetable.csv`));
                        } else {
                            metadata = row;
                        }
                    })
                    .on('end', () => {
                        if (!metadata) {
                            reject(new Error(`No rows in ${ref}/Timetable.csv`));
                        } else {
                            resolve();
                        }
                    })
            })
        ]).catch(reject);
        TIMETABLES[ref] = {
            ...metadata!,
            expiration: createExpirationTimeout(ref),
            trains
        };
        resolve(TIMETABLES[ref]);
    });
}

export function getCurrentTimetableAndTime() {
    const date = new Date();
    const time = date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
    if (date.getHours() < NEW_DAY_HOUR) {
        date.setDate(date.getDate() - 1);
    }
    return {
        timetableRef: getTimetableRefForDate(date),
        time
    }
}

const NEW_DAY_SECONDS = NEW_DAY_HOUR * 3600;
function normaliseTime(time: number) {
    // JavaScript allows % to return negative values, so we need to coerce it to a positive value
    return ((time - NEW_DAY_SECONDS) % 86400 + 86400) % 86400;
}

export function compareTimes(time1: number, time2: number) {
    return normaliseTime(time1) - normaliseTime(time2);
}

export function getExpectedTrainState(trainTimetable: TrainTimetable, time: number): ExpectedTrainState {
    for (const [index, entry] of trainTimetable.entries()) {
        if (entry.arrivalTime && compareTimes(entry.arrivalTime, time) > 0) {
            // There should always be a previous entry because the first entry should not have an arrival time
            const previousEntry = trainTimetable[index - 1];
            if (compareTimes(entry.arrivalTime, time) > compareTimes(time, previousEntry.departureTime)) {
                return {
                    event: 'DEPARTED',
                    location: previousEntry.location,
                    inService: previousEntry.inService,
                    destination: previousEntry.destination,
                };
            }
            return {
                event: 'APPROACHING',
                location: entry.location,
                inService: previousEntry.inService,
                destination: entry.destination,
            };
        }
        if (entry.departureTime && compareTimes(entry.departureTime, time) > 0) {
            return {
                event: entry.arrivalTime ? 'ARRIVED' : 'TERMINATED',
                location: entry.location,
                inService: entry.inService,
                destination: entry.destination,
            }
        }
    }
    // If we reach here, the train has already departed from the last station
    const lastEntry = trainTimetable[trainTimetable.length - 1];
    return {
        event: lastEntry.departureTime && compareTimes(lastEntry.departureTime, time) <= 0 ? 'DEPARTED' : 'ARRIVED',
        location: lastEntry.location,
        inService: lastEntry.inService,
        destination: lastEntry.destination,
    };
}
