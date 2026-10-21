import type {FastifyError, FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import {STREAMS_DOCUMENTATION, SWAGGER_SSE_DISCLAIMER} from "../../sse";
import {
    connectStream,
    createToken,
    deleteToken,
    listSubscriptions,
    subscribe,
    SUBSCRIPTION_TOPICS,
    SubscriptionError,
    type SubscriptionRequest,
    type SubscriptionTopic,
    unsubscribe
} from "../subscriptions";
import {MAX_SUBSCRIPTIONS_PER_TOKEN} from "../limits";
import {TrainDataAPIs} from "../../../types";
import {ApiType} from "../../../../generated/prisma/enums";

/** Sends subscription errors as plain text, like other endpoints' errors. Other errors are left to the default handler. */
function errorHandler(error: FastifyError, _: FastifyRequest, res: FastifyReply) {
    if (!(error instanceof SubscriptionError)) throw error;
    res.status(error.statusCode).send(error.message);
}

const STRING_LIST = { type: 'array', items: { type: 'string' } } as const;

/** The parameters for each topic */
const TOPIC_PARAMETERS: Record<SubscriptionTopic, {
    description: string;
    properties: Record<string, object>;
    required?: string[];
}> = {
    'station-due-times': {
        description: 'The trains due at a station',
        properties: {
            station: { type: 'string', description: 'Station code', example: 'MMT' }
        },
        required: ['station']
    },
    'platform-due-times': {
        description: 'The trains due at a platform',
        properties: {
            platform: { type: 'string', description: 'Platform code', example: 'MTW;3' }
        },
        required: ['platform']
    },
    'trains': {
        description: 'Changes to the status of trains. Each filter matches any of its values, and missing or empty ' +
            'filters match everything.',
        properties: {
            trns: {
                ...STRING_LIST,
                description: 'Only include trains with these train running numbers (TRNs, without the leading "T", e.g., `"101"`).',
                example: ['101']
            },
            apis: {
                type: 'array',
                items: { type: 'string', enum: TrainDataAPIs },
                description: 'Which APIs to include data from. Data from other APIs is omitted, and changes to it are ignored.'
            },
            eventTypes: {
                ...STRING_LIST,
                description: 'Only include trains where the last event is of one of these types.',
                example: ['ARRIVED']
            },
            locations: {
                type: 'array',
                items: { $ref: 'location' },
                description: 'Only include trains where the last event was at one of these locations, in the format ' +
                    '`<station code>_<platform number>` (e.g., `"MTW_4"`), or just a station code for all platforms at a station.'
            },
            destinations: {
                ...STRING_LIST,
                description: 'Only include trains with one of these destinations (e.g., `"South Hylton"`). ' +
                    'For the Times API, this is the first planned destination.',
                example: ['South Hylton']
            },
        }
    },
    'heartbeat-errors': {
        description: 'Errors which occur during heartbeats',
        properties: {
            apis: {
                type: 'array',
                items: { type: 'string', enum: Object.values(ApiType) },
                description: 'Which APIs to receive errors for. If omitted, errors from all APIs are received.'
            }
        }
    },
    'heartbeat-warnings': {
        description: 'Warnings produced during heartbeats',
        properties: {
            apis: {
                type: 'array',
                items: { type: 'string', enum: Object.values(ApiType) },
                description: 'Which APIs to receive warnings for. If omitted, warnings from all APIs are received.'
            }
        }
    },
    'heartbeats': {
        description: 'The end of each heartbeat',
        properties: {}
    },
};

/**
 * A subscription to a topic, as a union of each topic's schema.
 * Unknown properties are allowed by the schema, since Fastify's validator would silently remove them rather than
 *  rejecting them. They are rejected when the subscription is parsed instead.
 */
function subscriptionSchema(isRequest: boolean) {
    return {
        type: 'object',
        discriminator: {propertyName: 'topic'},
        oneOf: SUBSCRIPTION_TOPICS.map(topic => {
            const {description, properties, required = []} = TOPIC_PARAMETERS[topic];
            return {
                type: 'object',
                title: topic,
                description,
                properties: {
                    id: {
                        type: 'string',
                        description: isRequest
                            ? 'Identifies the subscription in messages and for removing/replacing it. Up to 64 letters, ' +
                            'digits, hyphens or underscores. If a subscription with this ID already exists, it is ' +
                            'replaced. If omitted, an ID is generated.'
                            : 'Identifies the subscription in messages and for removing/replacing it.',
                        example: 'monument-board'
                    },
                    topic: {type: 'string', const: topic},
                    ...properties
                },
                required: [...(isRequest ? [] : ['id']), 'topic', ...required]
            };
        })
    };
}

const INVALID_SUBSCRIPTIONS_RESPONSE = {
    type: 'string',
    description: 'Some of the subscriptions are invalid or redundant, or they would exceed the limits'
} as const;

const TOKEN_NOT_FOUND_RESPONSE = {
    type: 'string',
    description: 'Subscription token not found'
} as const;

export default function registerEndpoint(app: FastifyInstance) {
    app.addSchema({
        $id: 'subscription',
        ...subscriptionSchema(false)
    });

    app.addSchema({
        $id: 'subscriptions-body',
        type: 'object',
        properties: {
            subscriptions: {
                type: 'array',
                description: 'The subscriptions to add. ' + STREAMS_DOCUMENTATION,
                minItems: 1,
                maxItems: MAX_SUBSCRIPTIONS_PER_TOKEN,
                items: subscriptionSchema(true),
            }
        },
        required: ['subscriptions']
    });

    app.post<{
        Body: { subscriptions: SubscriptionRequest[] }
    }>('/subscriptions', {
        errorHandler,
        schema: {
            description: 'Leases a token with some subscriptions. ' + STREAMS_DOCUMENTATION,
            body: { $ref: 'subscriptions-body' },
            response: {
                201: {
                    type: 'object',
                    properties: {
                        token: {
                            type: 'string',
                            description: 'The subscription token, which is needed to manage the subscriptions and ' +
                                'receive messages for them. Keep it secret.'
                        },
                        subscriptions: {
                            type: 'array',
                            description: 'All the token\'s subscriptions, after the change.',
                            items: { $ref: 'subscription' }
                        },
                        replaced: {
                            type: 'array',
                            description: 'The IDs of existing subscriptions which were removed, because they are covered by new ones.',
                            items: { type: 'string' }
                        }
                    },
                    required: ['token', 'subscriptions', 'replaced']
                },
                400: INVALID_SUBSCRIPTIONS_RESPONSE,
                429: { type: 'string', description: 'This IP address already has the maximum number of subscription tokens' },
            }
        }
    }, (req, res) => {
        res.status(201).send(createToken(req.ip, req.body.subscriptions));
    });

    app.get<{
        Params: { token: string }
    }>('/subscriptions/:token', {
        errorHandler,
        schema: {
            description: 'Gets information about a token, such as its current `subscriptions`, how many `streams` are ' +
                'connected (0 or 1), and when it `expiresAt` (or `null` while a stream is connected).',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        subscriptions: {
                            type: 'array',
                            description: 'All the token\'s current subscriptions.',
                            items: { $ref: 'subscription' }
                        },
                        streams: { type: 'integer', description: 'The number of streams currently connected for the token.' },
                        expiresAt: {
                            type: 'integer',
                            nullable: true,
                            description: 'When the token will be deleted if it isn\'t used in time, or null if any ' +
                                'streams are currently connected.'
                        }
                    },
                    required: ['subscriptions', 'streams', 'expiresAt']
                },
                404: TOKEN_NOT_FOUND_RESPONSE,
            }
        }
    }, (req, res) => {
        const { subscriptions, streams, expiresAt } = listSubscriptions(req.params.token);
        res.send({ subscriptions, streams, expiresAt: expiresAt?.getTime() ?? null });
    });

    app.post<{
        Params: { token: string },
        Body: { subscriptions: SubscriptionRequest[] }
    }>('/subscriptions/:token', {
        errorHandler,
        schema: {
            description: 'Adds subscriptions to a subscription token. New subscriptions replace any existing ' +
                'subscriptions with the same ID, or which they cover. Either all of the subscriptions are added, or ' +
                'none are if any are invalid, redundant, or would exceed the limits. ' + STREAMS_DOCUMENTATION,
            body: { $ref: 'subscriptions-body' },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        subscriptions: {
                            type: 'array',
                            description: 'All the token\'s subscriptions, after the change.',
                            items: { $ref: 'subscription' }
                        },
                        replaced: {
                            type: 'array',
                            description: 'The IDs of existing subscriptions which were removed, because they are covered by new ones.',
                            items: { type: 'string' }
                        }
                    },
                    required: ['subscriptions', 'replaced']
                },
                400: INVALID_SUBSCRIPTIONS_RESPONSE,
                404: TOKEN_NOT_FOUND_RESPONSE,
            }
        }
    }, (req, res) => {
        res.send(subscribe(req.params.token, req.body.subscriptions));
    });

    app.delete<{
        Params: { token: string, id: string }
    }>('/subscriptions/:token/:id', {
        errorHandler,
        schema: {
            description: 'Removes a single subscription from a subscription token.',
            response: {
                204: { type: 'null' },
                404: { type: 'string', description: 'Subscription token or subscription not found' },
            }
        }
    }, (req, res) => {
        unsubscribe(req.params.token, req.params.id);
        res.status(204).send();
    });

    app.delete<{
        Params: { token: string }
    }>('/subscriptions/:token', {
        errorHandler,
        schema: {
            description: 'Deletes a subscription token, along with its subscriptions. Any connected streams are closed.',
            response: {
                204: { type: 'null' },
                404: TOKEN_NOT_FOUND_RESPONSE,
            }
        }
    }, (req, res) => {
        deleteToken(req.params.token);
        res.status(204).send();
    });

    app.get<{
        Params: { token: string },
        Querystring: { subscriptionIds?: string }
    }>('/subscriptions/:token/stream', {
        errorHandler,
        schema: {
            description: 'Streams messages for a subscription token\'s subscriptions. ' +
                'Each token can only have `MAX_STREAMS_PER_TOKEN` streams connected (see the constants endpoint), so ' +
                'connecting more closes the oldest. ' +
                'If the proxy closes the stream (after sending `stream-closed`), it shouldn\'t be reconnected. ' +
                STREAMS_DOCUMENTATION + ' ' + SWAGGER_SSE_DISCLAIMER,
            querystring: {
                type: 'object',
                properties: {
                    subscriptionIds: {
                        type: 'string',
                        description: 'If present, each message will include the IDs of the subscriptions which it matched'
                    }
                }
            },
            response: {
                200: {
                    type: 'string',
                    description: 'SSE stream',
                },
                404: TOKEN_NOT_FOUND_RESPONSE,
            }
        }
    }, (req, res) => {
        req.raw.on('close', connectStream(req.params.token, res.raw, req.query.subscriptionIds !== undefined));
    });
}
