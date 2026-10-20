import { FastifyInstance } from 'fastify';
import {getSnapshot, MatchStrategy} from "../../../../history";
import {convertContainers} from "../../../props";
import {parseLocations} from "../../train-filters";
import {ParsedLocation} from "../../../../types";

export default function registerEndpoint(app: FastifyInstance) {
    app.get<{
        Querystring: {
            time: number;
            matchStrategy?: MatchStrategy;
            trn?: string[];
            eventType?: string[];
            location?: string[];
            destination?: string[];
        }
    }>('/history/snapshot', {
        schema: {
            description: "Gets all the data from the heartbeat at a specific time.",
            querystring: {
                type: 'object',
                properties: {
                    time: {
                        type: 'number',
                        description: 'The timestamp to get the snapshot of, in milliseconds since epoch.',
                    },
                    matchStrategy: {
                        type: 'string',
                        description: 'The strategy to use for finding the corresponding heartbeat.',
                        default: 'before',
                        enum: ['before', 'after', 'exact', 'nearest'],
                        oneOf: [
                            {
                                const: 'before',
                                description: 'Get the snapshot from the heartbeat immediately before the specified time.'
                            },
                            {
                                const: 'after',
                                description: 'Get the snapshot from the heartbeat immediately after the specified time.'
                            },
                            {
                                const: 'exact',
                                description: 'Get the snapshot from the heartbeat in progress at the specified time.'
                            },
                            {
                                const: 'nearest',
                                description: 'Get the snapshot from the heartbeat closest to the specified time.'
                            }
                        ]
                    },
                    trn: {
                        type: 'array',
                        description: 'Which TRNs to include in the snapshot. If none are specified, all trains will be included.',
                        items: { type: 'string', example: '101' }
                    },
                    eventType: {
                        type: 'array',
                        description: 'Only include trains with events of the specified types. If none are specified, all event types are included.',
                        items: { type: 'string', example: 'ARRIVED' }
                    },
                    location: {
                        type: 'array',
                        description: 'Only include trains at the specified locations. If none are specified, all locations are included.',
                        items: { $ref: 'location' }
                    },
                    destination: {
                        type: 'array',
                        description: 'Only include trains with the specified destinations. If none are specified, all destinations are included.',
                        items: { type: 'string', example: 'Not In Service' }
                    }
                },
                required: ['time']
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        heartbeat: { $ref: 'heartbeat' },
                        timesApiTrains: {
                            type: 'object',
                            description: 'Map of TRNs to their data from the Times API during the heartbeat.',
                            additionalProperties: { $ref: 'times-api-train-data' }
                        },
                        geoApiTrains: {
                            type: 'object',
                            description: 'Map of TRNs to their data from the Geo API during the heartbeat.',
                            additionalProperties: { $ref: 'geo-api-train-data' }
                        },
                        statusLastChanged: {
                            type: 'object',
                            description: 'Map of TRNs to the heartbeat during which their status last changed, as of ' +
                                'the heartbeat.',
                            additionalProperties: { $ref: 'heartbeat' }
                        },
                        // These don't use the `heartbeat-error` and `heartbeat-warning` schemas, since they don't include
                        //  the heartbeat, which is already given above
                        errors: {
                            type: 'array',
                            description: 'All errors that occurred during the heartbeat.',
                            items: {
                                type: 'object',
                                properties: {
                                    api: { type: 'string', description: 'Identifier of the API that produced the error.' },
                                    message: { type: 'string', description: 'Error message.' }
                                },
                                required: ['api', 'message']
                            }
                        },
                        warnings: {
                            type: 'array',
                            description: 'All warnings generated during the heartbeat.',
                            items: {
                                type: 'object',
                                properties: {
                                    api: { type: 'string', description: 'Identifier of the API that produced the warning(s).' },
                                    data: {
                                        type: 'object',
                                        description: 'The structure of this object depends on the API that produced the warning.',
                                        additionalProperties: true
                                    }
                                },
                                required: ['api', 'data']
                            }
                        }
                    },
                    required: ['heartbeat', 'timesApiTrains', 'geoApiTrains', 'statusLastChanged', 'errors', 'warnings']
                },
                400: {
                    description: 'Malformed query parameters',
                    type: 'string',
                },
                404: {
                    description: 'No heartbeat found matching the specified criteria',
                    type: 'string',
                }
            }
        }
    }, async (req, res) => {
        const {
            time: timeStr,
            matchStrategy,
            trn: trns,
            eventType: eventTypes,
            location: locations,
            destination: destinations,
        } = req.query;

        const time = new Date(timeStr);
        if (isNaN(time.getTime())) {
            res.status(400).send('Invalid time parameter');
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

        const snapshot = await getSnapshot(
            time,
            matchStrategy,
            {
                trns: trns && new Set(trns),
                eventTypes: eventTypes && new Set(eventTypes),
                locations: parsedLocations,
                destinations: destinations && new Set(destinations),
            },
        );
        if (!snapshot) {
            res.status(404).send('No heartbeat found matching the specified criteria');
            return;
        }

        res.send(convertContainers(snapshot));
    });
}
