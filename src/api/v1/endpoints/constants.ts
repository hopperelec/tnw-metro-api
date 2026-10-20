import { FastifyInstance } from 'fastify';
import {
    NEW_DAY_HOUR,
    PASSIVE_REFRESH_INTERVAL,
    ACTIVE_REFRESH_MINIMUM_TIMEOUT,
    LINES,
    PASSENGER_STOPS,
    LOCATION_ABBREVIATIONS,
    DESTINATION_CODES
} from "../../../constants";
import {
    MAX_HISTORY_REQUEST_LIMIT,
    DEFAULT_HISTORY_REQUEST_LIMIT,
    MAX_SUBSCRIPTION_TOKENS_PER_IP,
    MAX_SUBSCRIPTIONS_PER_TOKEN,
    MAX_STREAMS_PER_TOKEN,
    MAX_SUBSCRIPTION_FILTER_VALUES,
} from "../limits";

const CONSTANTS = {
    NEW_DAY_HOUR,
    PASSIVE_REFRESH_INTERVAL,
    ACTIVE_REFRESH_MINIMUM_TIMEOUT,
    MAX_HISTORY_REQUEST_LIMIT,
    DEFAULT_HISTORY_REQUEST_LIMIT,
    MAX_SUBSCRIPTION_TOKENS_PER_IP,
    MAX_SUBSCRIPTIONS_PER_TOKEN,
    MAX_STREAMS_PER_TOKEN,
    MAX_SUBSCRIPTION_FILTER_VALUES,
    LINES,
    PASSENGER_STOPS,
    LOCATION_ABBREVIATIONS,
    ROUTE_CODES: DESTINATION_CODES,
}

export default function registerEndpoint(app: FastifyInstance) {
    app.get('/constants', {
        schema: {
            description: 'Gets various constants used by the proxy (new day hour, refresh intervals, history limits, stations...)',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        NEW_DAY_HOUR: {
                            type: 'integer',
                            description: 'Hour at which the timetable resets to the next day',
                            minimum: 0,
                            maximum: 23,
                        },
                        PASSIVE_REFRESH_INTERVAL: {
                            type: 'integer',
                            description: 'Interval, in milliseconds, at which heartbeats always happen',
                        },
                        ACTIVE_REFRESH_MINIMUM_TIMEOUT: {
                            type: 'integer',
                            description: "Minimum time, in milliseconds, between heartbeats, " +
                                "such as when a request is made for a train's current status"
                        },
                        MAX_HISTORY_REQUEST_LIMIT: {
                            type: 'integer',
                            description: 'Maximum number of history entries (limit) returned by train history endpoints',
                        },
                        DEFAULT_HISTORY_REQUEST_LIMIT: {
                            type: 'integer',
                            description: 'Default number of history entries returned by train history endpoints if no limit is specified'
                        },
                        MAX_SUBSCRIPTION_TOKENS_PER_IP: {
                            type: 'integer',
                            description: 'Maximum number of subscription tokens which can exist at a time for each IP address'
                        },
                        MAX_SUBSCRIPTIONS_PER_TOKEN: {
                            type: 'integer',
                            description: 'Maximum number of subscriptions each subscription token can have'
                        },
                        MAX_STREAMS_PER_TOKEN: {
                            type: 'integer',
                            description: 'Maximum number of streams which can be connected for each subscription token. ' +
                                'Connecting more closes the oldest.'
                        },
                        MAX_SUBSCRIPTION_FILTER_VALUES: {
                            type: 'integer',
                            description: 'Maximum total number of values in the filters of each subscription (e.g., TRNs and destinations)'
                        },
                        LINES: {
                            type: 'object',
                            additionalProperties: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'List of stations on the line, in in-line order'
                            },
                            description: 'Map of lines and the stations on them'
                        },
                        PASSENGER_STOPS: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'List of location abbreviations that refer to valid passenger stops (ie, not depots, sidings, vents, etc.)'
                        },
                        LOCATION_ABBREVIATIONS: {
                            type: 'object',
                            additionalProperties: { type: 'string' },
                            description: 'Map from location abbreviations to human-readable names'
                        },
                        ROUTE_CODES: {
                            type: 'object',
                            additionalProperties: { $ref: 'location' },
                            description: 'Map of destination codes to the location code of the corresponding destination',
                        }
                    },
                    required: Object.keys(CONSTANTS),
                    example: CONSTANTS
                }
            }
        }
    }, (_, res) => {
        res.send(CONSTANTS);
    });
}