import {getLastHeartbeatTimes, restartHeartbeat} from "../../../../heartbeat";
import {sendWithProps} from "../../../props";
import type {FastifyInstance} from "fastify";
import {getDueTimes} from "../../../../due-times";
import {DUE_TIMES_NOT_AVAILABLE} from "../../../schemas";

export default function registerEndpoint(app: FastifyInstance) {
    app.get<{
        Querystring: {
            props?: string;
        }
    }>('/due-times', {
        schema: {
            description: 'Gets the next trains due at all platforms',
            querystring: {
                type: 'object',
                properties: {
                    props: { $ref: 'props' }
                }
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        lastHeartbeat: { $ref: 'heartbeat' },
                        dueTimes: {
                            type: 'object',
                            description: 'Map of platform codes to due times',
                            additionalProperties: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        trn: { type: 'string' },
                                        time: { $ref: 'due-time' },
                                    },
                                    required: ['trn', 'time']
                                }
                            }
                        }
                    }
                },
                500: {
                    type: 'string',
                    example: DUE_TIMES_NOT_AVAILABLE,
                }
            }
        }
    }, async (req, res) => {
        await restartHeartbeat();
        const dueTimes = getDueTimes();
        if (!dueTimes) {
            res.status(500).send(DUE_TIMES_NOT_AVAILABLE);
            return;
        }
        sendWithProps(res,
            {
                lastHeartbeat: getLastHeartbeatTimes(),
                dueTimes,
            },
            req.query.props
        );
    });
}
