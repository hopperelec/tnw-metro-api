import {FastifyInstance} from "fastify";

/** Registers the shared schemas used by v1's endpoints */
export function registerV1Schemas(app: FastifyInstance) {
    app.addSchema({
        $id: 'trn',
        type: 'string',
        description: 'A train running number (TRN) without the leading "T" (e.g., `"101"`).'
    });

    app.addSchema({
        $id: 'heartbeat',
        type: 'object',
        nullable: true,
        properties: {
            startedAt: {
                type: 'integer',
                description: 'Timestamp when the heartbeat started',
                minimum: 0,
            },
            endedAt: {
                type: 'integer',
                description: 'Timestamp when the heartbeat ended, or null if it is still ongoing or was interrupted',
                minimum: 0,
                nullable: true,
            }
        },
        required: ['startedAt', 'endedAt']
    });

    app.addSchema({
        $id: 'location',
        type: 'string',
        description: 'A location, usually in the format `<station code>_<platform number>`, ' +
            "where the platform number is optional (e.g., 'MMT' for all platforms at Monument), " +
            "but can also be just a location abbreviations, particularly for NIS locations such as sidings. " +
            'While the proxy does control these codes,' +
            'it is not recommended to assume that they will always be in this format, as they may change in the future.',
        example: 'MTW_3',
    });

    app.addSchema({
        $id: 'times-api-train-data',
        type: 'object',
        description: 'Train data from the Times API',
        properties: {
            lastEvent: {
                type: 'object',
                properties: {
                    type: {
                        type: 'string',
                        description: 'Type of the last event, should be one of: APPROACHING, ARRIVED, READY TO START, DEPARTED',
                        example: 'APPROACHING'
                    },
                    location: {
                        oneOf: [
                            {
                                type: 'object',
                                description: 'Parsed components of the location',
                                properties: {
                                    station: {
                                        type: 'string',
                                        description: 'Name of the station where the last event occurred',
                                        example: 'Monument'
                                    },
                                    platformNumber: {
                                        type: 'integer',
                                        description: 'Platform number where the last event occurred',
                                        minimum: 0,
                                        example: 3
                                    }
                                }
                            },
                            {
                                type: 'string',
                                description: "Raw location string as provided by the upstream API. " +
                                    "This is only used when the location doesn't match the expected format, " +
                                    "so you should not expect this to be in any particular format.",
                                example: "Monument Platform 3"
                            }
                        ]
                    },
                    time: {
                        type: 'integer',
                        description: 'Timestamp of the last event',
                        minimum: 0,
                    }
                }
            },
            plannedDestinations: {
                type: 'array',
                description: 'List of planned destinations for the train, in order of when they are expected to become the current destination',
                items: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: 'Name of the destination',
                            example: 'Monument'
                        },
                        from: {
                            type: 'object',
                            description: 'When and where this is expected to become the current destination',
                            properties: {
                                platformCode: { $ref: 'platform-code-out' },
                                time: {
                                    type: 'integer',
                                    description: 'Timestamp for when this is expected to become the current destination',
                                    minimum: 0,
                                }
                            }
                        }
                    }
                }
            },
            nextPlatforms: {
                type: 'array',
                description: 'List of next platforms for the train, in order of planned arrival',
                items: {
                    type: 'object',
                    properties: {
                        code: { $ref: 'platform-code-out' },
                        time: { $ref: 'due-time' },
                    }
                }
            }
        },
        required: ['lastEvent', 'plannedDestinations']
    });

    app.addSchema({
        $id: 'geo-api-train-data',
        type: 'object',
        description: 'Train data from the Geo API',
        properties: {
            destination: {
                type: 'string',
                description: "Name of the train's current destination",
                example: 'Monument'
            },
            lastSeen: {
                oneOf: [
                    {
                        type: 'object',
                        description: 'Parsed components of the last seen message',
                        properties: {
                            type: {
                                type: 'string',
                                enum: ['APPROACHING', 'ARRIVED', 'READY_TO_START', 'DEPARTED'],
                                description: 'Type of the last seen event'
                            },
                            station: {
                                type: 'string',
                                description: 'Name of the station where the last seen event occurred',
                                example: 'Monument'
                            },
                            platformNumber: {
                                type: 'integer',
                                description: 'Platform number where the last seen event occurred',
                                minimum: 0,
                                example: 3
                            },
                            time: {
                                type: 'integer',
                                description: 'Timestamp when the last seen event occurred',
                                minimum: 0
                            }
                        }
                    },
                    {
                        type: 'string',
                        description: "Raw last seen message as provided by the upstream API. " +
                            "This is only used when the message doesn't match the expected format, " +
                            "so you should not expect this to be in any particular format.",
                        example: "Approaching Monument platform 3 at 14:30"
                    }
                ]
            }
        },
        required: ['destination', 'lastSeen']
    });

    app.addSchema({
        $id: 'collated-train',
        type: 'object',
        properties: {
            timesAPI: { $ref: 'times-api-train-data' },
            geoAPI: { $ref: 'geo-api-train-data' }
        }
    });

    app.addSchema({
        $id: 'heartbeat-error',
        type: 'object',
        description: 'An error that occurred during a heartbeat.',
        properties: {
            api: {
                type: 'string',
                description: 'Identifier of the API that produced the error.',
                example: 'TIMES'
            },
            message: {
                type: 'string',
                description: 'Error message.',
                example: "TypeError: Cannot read property 'length' of undefined"
            },
            heartbeat: { $ref: 'heartbeat' }
        },
        required: ['api', 'message', 'heartbeat']
    });

    app.addSchema({
        $id: 'heartbeat-warning',
        type: 'object',
        description: 'A warning generated during a heartbeat.',
        properties: {
            api: {
                type: 'string',
                description: 'Identifier of the API that produced the warning(s).',
                example: 'TIMES'
            },
            data: {
                type: 'object',
                description: 'The structure of this object depends on the API that produced the warning.',
                additionalProperties: true,
            },
            heartbeat: { $ref: 'heartbeat' }
        },
        required: ['api', 'data', 'heartbeat']
    });

    app.addSchema({
        $id: 'time-filter',
        type: 'string',
        description: 'Filter by time. ' +
            'Can be an exact timestamp (e.g., "1678886400000") of a known heartbeat, ' +
            'or a range using three dots ' +
            '(e.g., "...1678886400000", "1678886400000...", "1678886400000...1678886400001"). ' +
            'Timestamps are in milliseconds since epoch.',
        oneOf: [
            { pattern: '^[0-9]+$' }, // exact
            { pattern: '^\\.\\.\\.[0-9]+$' }, // ...to
            { pattern: '^[0-9]+\\.\\.\\.$' }, // from...
            { pattern: '^[0-9]+\\.\\.\\.[0-9]+$' } // from...to
        ]
    });
}
