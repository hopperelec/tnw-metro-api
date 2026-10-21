import type { FastifyInstance } from 'fastify';
import {DEFAULT_HISTORY_REQUEST_LIMIT, MAX_HISTORY_REQUEST_LIMIT} from "../../limits";
import {type ParsedLocation, type TrainDataAPI, TrainDataAPIs} from "../../../../types";
import TimeFilter from "../../../../time-filter";
import {getTrainsHistory} from "../../../../history";
import {parseLocations} from "../../train-filters";
import {convertContainers} from "../../../props";

export default function registerEndpoint(app: FastifyInstance) {
    app.get<{
        Querystring: {
            trn?: string | string[];
            time?: string;
            limit?: number;
            limitPerTrn?: number;
            api?: TrainDataAPI[];
            eventType?: string[];
            location?: string[];
            destination?: string[];
        }
    }>('/history/trains', {
        schema: {
            description: "Gets the history of statuses for one or more trains.",
            querystring: {
                type: 'object',
                properties: {
                    trn: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Which TRNs to get history for. If none are specified, history for all trains will be returned.'
                    },
                    time: { $ref: 'time-filter' },
                    limit: {
                        type: 'integer',
                        description: 'Limit the total number of status entries returned across all trains. ' +
                            'This is done by truncating the time window until the limit is satisfied.',
                        minimum: 1,
                        maximum: MAX_HISTORY_REQUEST_LIMIT,
                        default: DEFAULT_HISTORY_REQUEST_LIMIT,
                    },
                    limitPerTrn: {
                        type: 'integer',
                        description: 'Limit the number of status entries returned per train. ' +
                            'This is done by truncating the time window until the limit is satisfied.',
                        minimum: 1
                    },
                    api: {
                        type: 'array',
                        description: 'Which APIs to include data from. If none are specified, data from all APIs will be included.',
                        items: {
                            type: 'string',
                            enum: TrainDataAPIs
                        }
                    },
                    eventType: {
                        type: 'array',
                        description: 'Only include entries with events of the specified types. If none are specified, all event types are included.',
                        items: { type: 'string', example: 'ARRIVED' }
                    },
                    location: {
                        type: 'array',
                        description: 'Only include entries at the specified locations. If none are specified, all locations are included.',
                        items: { $ref: 'location' }
                    },
                    destination: {
                        type: 'array',
                        description: 'Only include entries with the specified destinations. If none are specified, all destinations are included.',
                        items: { type: 'string', example: 'Not In Service' }
                    }
                }
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        trains: {
                            type: 'object',
                            description: 'Map of TRNs to their history from each API, in the order requested (see `limit`).',
                            additionalProperties: {
                                type: 'object',
                                properties: {
                                    timesAPI: {
                                        type: 'array',
                                        description: 'History from the Times API, if included.',
                                        items: {
                                            type: 'object',
                                            properties: {
                                                startHeartbeat: { $ref: 'heartbeat' },
                                                endHeartbeat: { $ref: 'heartbeat' },
                                                status: { $ref: 'times-api-train-data' },
                                            },
                                            required: ['startHeartbeat', 'endHeartbeat', 'status']
                                        }
                                    },
                                    geoAPI: {
                                        type: 'array',
                                        description: 'History from the Geo API, if included.',
                                        items: {
                                            type: 'object',
                                            properties: {
                                                startHeartbeat: { $ref: 'heartbeat' },
                                                endHeartbeat: { $ref: 'heartbeat' },
                                                status: { $ref: 'geo-api-train-data' },
                                            },
                                            required: ['startHeartbeat', 'endHeartbeat', 'status']
                                        }
                                    }
                                }
                            }
                        },
                        truncatedTo: {
                            type: 'number',
                            description: 'If the results were truncated due to a limit being reached, the time they were truncated to.',
                            nullable: true,
                            minimum: 0
                        }
                    },
                    required: ['trains', 'truncatedTo']
                },
                400: {
                    description: 'Malformed query parameters',
                    type: 'string',
                }
            }
        }
    }, async (req, res) => {
        const {
            trn: trns,
            time: timeFilterStr,
            limit,
            limitPerTrn,
            api: apis,
            eventType: eventTypes,
            location: locations,
            destination: destinations
        } = req.query;

        let timeFilter: TimeFilter;
        try {
            timeFilter = new TimeFilter(timeFilterStr);
        } catch (e) {
            res.status(400).send(e.message);
            return;
        }

        let parsedLocations: ParsedLocation[] | undefined = undefined;
        if (locations) {
            try {
                parsedLocations = parseLocations(locations);
            } catch (e) {
                res.status(400).send(e.message);
                return;
            }
        }

        return convertContainers(await getTrainsHistory(
            {
                trns: trns && new Set(trns),
                apis: apis && new Set(apis),
                eventTypes: eventTypes && new Set(eventTypes),
                locations: parsedLocations,
                destinations: destinations && new Set(destinations),
            },
            timeFilter,
            limit,
            limitPerTrn,
        ));
    });
}
