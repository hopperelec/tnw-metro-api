import {FastifyInstance} from "fastify";
import {
    compareTimes,
    getCurrentTimetableAndTime,
    getTimetable,
    TrainTimetableEntry
} from "../../../parsing/timetable";
import {getTimetableRefForDate} from "../../../private";
import {MONUMENT_STATION_CODES} from "../../../constants";

const LOCATION_REGEX = new RegExp(/^(?<station>[A-Z]{3})(_(?<platform>\d+))?$/);
export function parseLocation(location: string) {
    const match = location.match(LOCATION_REGEX);
    if (match?.groups) {
        return {
            station: match.groups.station,
            platform: match.groups.platform ? +match.groups.platform : undefined
        };
    }
}

const IGNORE_PLATFORM_STATIONS = ['APT', 'SHL', 'SJM', 'SSS', 'PJC'];

export function hasLocation(set: Set<string> | undefined, location: string) {
    if (!set) return true;
    const parsedLocation1 = parseLocation(location);
    if (set.has(location)) return true;
    for (const location2 of set) {
        const parsedLocation2 = parseLocation(location2);
        if (!parsedLocation1 || !parsedLocation2) continue;
        if (
            parsedLocation1.platform !== undefined &&
            parsedLocation2.platform !== undefined &&
            parsedLocation1.platform !== parsedLocation2.platform &&
            !IGNORE_PLATFORM_STATIONS.includes(parsedLocation1.station)
        ) continue;
        if (parsedLocation1.station === parsedLocation2.station) return true;
        if (MONUMENT_STATION_CODES.includes(parsedLocation1.station) &&
            MONUMENT_STATION_CODES.includes(parsedLocation2.station)) {
            return true;
        }
    }
    return false;
}

export default function registerEndpoint(app: FastifyInstance) {
    app.addSchema({
        $id: 'time',
        type: 'integer',
        description: 'time in seconds since midnight',
    });
    app.get<{
        Querystring: {
            date?: string;
            time?: string;
            limit?: number;
            trn?: string[];
            type?: (1 | 2 | 3 | 4)[];
            location?: string[];
            destination?: string[];
            inService?: 0 | 1;
            onlyTermini?: string;
        }
    }>('/timetable', {
        schema: {
            description: 'Gets the timetable for a day. ' +
                'This is maintained by the host of this proxy, and is not guaranteed to be up to date.',
            querystring: {
                type: 'object',
                properties: {
                    date: {
                        type: 'string',
                        description: 'Date to get the timetable for, in YYYY-MM-DD format. Defaults to today. ' +
                            'Keep in mind that the timetable will usually cross midnight into the next day.',
                        pattern: '^(?<year>[0-9]{4})-(?<month>0[1-9]|1[0-2])-(?<day>0[1-9]|[12][0-9]|3[01])$',
                    },
                    time: {
                        type: 'string',
                        description: 'Filter by time range. ' +
                            'From and to times are in seconds since midnight, ' +
                            'and must be separated by three dots. ' +
                            'One can be omitted, but not both.',
                        oneOf: [
                            { pattern: '^\\.\\.\\.[0-9]+$' }, // ...to
                            { pattern: '^[0-9]+\\.\\.\\.$' }, // from...
                            { pattern: '^[0-9]+\\.\\.\\.[0-9]+$' } // from...to
                        ]
                    },
                    limit: {
                        type: 'integer',
                        description: 'Limit the number of entries per train. ' +
                            'If `time` only specifies a <to>, the limit will be applied in reverse. ' +
                            'Defaults to all that match the query.',
                        minimum: 0,
                    },
                    trn: {
                        type: 'array',
                        description: 'Which TRNs to get the timetable for. If none are specified, all trains will be included.',
                        items: { type: 'string', example: '101' }
                    },
                    type: {
                        type: 'array',
                        description: 'Entry types to filter the timetable by. If none are specified, all entry types are included.',
                        items: {
                            type: 'integer',
                            enum: [1, 2, 3, 4],
                            oneOf: [
                                { const: 1, description: 'Depot start' },
                                { const: 2, description: 'Passenger stop' },
                                { const: 3, description: 'ECS or skips' },
                                { const: 4, description: 'Depot end' }
                            ]
                        }
                    },
                    location: {
                        type: 'array',
                        description: 'Locations to filter the timetable by. If none are specified, all locations are included.',
                        items: { $ref: 'location' }
                    },
                    destination: {
                        type: 'array',
                        description: 'Destinations to filter the timetable by. If none are specified, all destinations are included.',
                        items: { $ref: 'location' }
                    },
                    inService: {
                        type: 'integer',
                        enum: [0, 1],
                        description: 'Filter by whether the train is in passenger service. ' +
                            'Defaults to including both in-service and not in-service trains.',
                        oneOf: [
                            { const: 1, description: 'Only include in-service entries' },
                            { const: 0, description: 'Only include not in-service entries' }
                        ]
                    },
                    onlyTermini: {
                        type: 'string',
                        description: 'If set, only return termini entries (entries where either `arrivalTime` or `departureTime` is missing).',
                    }
                }
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        ref: {
                            type: 'string',
                            description: 'A unique identifier for the timetable referenced. ' +
                                'Usually, this is the name of the zip file provided by Nexus starting with DEP. ' +
                                'However, where the zip file provided had a generic name, ' +
                                'this may be chosen by the host of this proxy.',
                        },
                        serviceId: {
                            type: 'string',
                            description: 'The service ID for the timetable referenced.',
                        },
                        description: {
                            type: 'string',
                            description: 'Description of the base timetable referenced.'
                        },
                        effectiveFrom: {
                            type: 'string',
                            description: 'The date this timetable claims to be effective from, usually in DD-Mmm-YYYY format. ' +
                                'This is not used to select the timetable since other timetables can take precedence.'
                        },
                        effectiveTo: {
                            type: 'string',
                            description: 'The date this timetable claims to be effective to, usually in DD-Mmm-YYYY format. ' +
                                'This is not used to select the timetable since other timetables can take precedence.'
                        },
                        bitmask: {
                            type: 'string',
                            description: 'A bitmask representing the dates between effectiveFrom and effectiveTo (inclusive) ' +
                                'that this timetable claims to be effective on, provided as a hexadecimal string. ' +
                                'This is not used to select the timetable since other timetables can take precedence.'
                        },
                        trains: {
                            type: 'object',
                            description: 'Map of TRNs to their timetables',
                            additionalProperties: {
                                type: 'array',
                                description: 'List of matching timetable entries for the train, ordered by time.',
                                items: {
                                    type: 'object',
                                    properties: {
                                        type: {
                                            type: 'integer',
                                            description: 'Type of entry.',
                                            oneOf: [
                                                { const: 1, description: 'Depot start' },
                                                { const: 2, description: 'Passenger stop' },
                                                { const: 3, description: 'ECS or skips' },
                                                { const: 4, description: 'Depot end' }
                                            ]
                                        },
                                        location: { $ref: 'location' },
                                        arrivalTime: { $ref: 'time' },
                                        departureTime: { $ref: 'time' },
                                        inService: {
                                            type: 'boolean',
                                            description: 'Whether the train is in passenger service at this entry.'
                                        },
                                        destination: { $ref: 'location' }
                                    },
                                    required: ['type', 'location', 'inService', 'destination'],
                                }
                            }
                        }
                    },
                    required: ['ref', 'serviceId', 'description', 'effectiveFrom', 'effectiveTo', 'bitmask', 'trains']
                },
                400: {
                    type: 'string',
                    description: 'Malformed query parameters'
                },
            }
        }
    }, async (req, res) => {
        const {
            date: dateQuery,
            time: timeQuery,
            limit,
            trn: trns,
            type: types,
            location: locations,
            destination: destinations,
            inService,
            onlyTermini
        } = req.query;

        let date: Date | undefined;
        if (dateQuery) {
            date = new Date(dateQuery);
            if (isNaN(date.getTime())) {
                res.status(400).send("Invalid date");
                return;
            }
        }

        const timeFilter: {
            from?: number;
            to?: number;
        } = {};
        if (timeQuery) {
            const [from, to] = timeQuery.split('...');
            if (from) {
                timeFilter.from = +from;
                if (timeFilter.from > 86400) {
                    res.status(400).send("Time must be less than 86400 seconds (24 hours)");
                    return;
                }
            }
            if (to) {
                timeFilter.to = +to;
                if (timeFilter.to > 86400) {
                    res.status(400).send("Time must be less than 86400 seconds (24 hours)");
                    return;
                }
            }
        }

        if (limit !== undefined && limit < 0) {
            res.status(400).send("Limit must be at least 0");
            return;
        }

        const timetableRef = date ? getTimetableRefForDate(date) : (getCurrentTimetableAndTime()).timetableRef;
        const timetable = await getTimetable(timetableRef);
        const filteredTimetable = new Map<string, TrainTimetableEntry[]>();

        if (limit !== 0) { // If limit is 0, only metadata is sent, so filtering on entries is not needed
            const trnSet = trns ? new Set(trns) : undefined;
            const typeSet = types ? new Set(types) : undefined;
            const locationSet = locations ? new Set(locations) : undefined;
            const destinationSet = destinations ? new Set(destinations) : undefined;

            for (const [trn, entries] of Object.entries(timetable.trains)) {
                if (trns && !trnSet.has(trn)) continue;

                let filteredEntries = entries.filter(entry => !(
                    (types && !typeSet.has(entry.type)) ||
                    !hasLocation(locationSet, entry.location) ||
                    !hasLocation(destinationSet, entry.destination || entry.location) ||
                    (inService !== undefined && entry.inService !== Boolean(inService)) ||
                    (onlyTermini && entry.arrivalTime !== undefined && entry.departureTime !== undefined) ||
                    (timeFilter.from && compareTimes(entry.departureTime || entry.arrivalTime, timeFilter.from) < 0) ||
                    (timeFilter.to && compareTimes(entry.arrivalTime || entry.departureTime, timeFilter.to) > 0)
                ));
                if (filteredEntries.length <= 0) continue;
                if (limit !== undefined) {
                    filteredEntries = timeFilter.to && !timeFilter.from
                        ? filteredEntries.slice(-limit)
                        : filteredEntries.slice(0, limit);
                }
                filteredTimetable.set(trn, filteredEntries);
            }
        }

        res.send({
            ref: timetableRef,
            ...timetable,
            bitmask: timetable.bitmask.toString(16),
            trains: Object.fromEntries(filteredTimetable)
        });
    });
}