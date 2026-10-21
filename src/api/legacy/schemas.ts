import type {FastifyInstance} from "fastify";

/** Registers the shared schemas used by the legacy API's endpoints */
export function registerLegacySchemas(app: FastifyInstance) {
    app.addSchema({
        $id: 'collated-train',
        type: 'object',
        properties: {
            timesAPI: {
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
                                type: 'string',
                                description: 'A human-readable representation of the station and platform where the last event occurred. ' +
                                    'The proxy does not check if this is in the expected format, ' +
                                    'so you should do your own checks if you need to parse this.',
                                example: 'Monument Platform 3'
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
                        description: 'List of planned destinations, in order of when they are expected to become the current destination',
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
                        description: 'List of next platforms, in order of planned arrival',
                        items: {
                            type: 'object',
                            properties: {
                                code: { $ref: 'platform-code-out' },
                                time: { $ref: 'due-time' },
                            }
                        }
                    }
                }
            },
            trainStatusesAPI: {
                type: 'object',
                description: 'Train data from the train statuses API',
                properties: {
                    destination: {
                        type: 'string',
                        description: 'Name of the destination',
                        example: 'Monument'
                    },
                    lastSeen: {
                        type: 'string',
                        description: "Last seen status of the train, in the format used on the Pop app's embedded map. " +
                            'The proxy does not check if this is in the expected format, ' +
                            'so you should do your own checks if you need to parse this.',
                        example: 'Arrived Monument platform 3 at 12:34'
                    }
                }
            },
        }
    });
}
