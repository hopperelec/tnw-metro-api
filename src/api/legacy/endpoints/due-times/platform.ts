import {getCollatedTrain, getLastHeartbeatTimes, restartHeartbeat} from "../../../../heartbeat";
import {sendWithProps} from "../../../props";
import type {FastifyInstance} from "fastify";
import {getDueTimes} from "../../../../due-times";
import {DUE_TIMES_NOT_AVAILABLE} from "../../../schemas";
import {downgradeDueTime, downgradeHeartbeatTimes} from "../../downgrade";

export default function registerEndpoint(app: FastifyInstance) {
    app.get<{
        Params: {
            platform: string;
        }
        Querystring: {
            props?: string;
        }
    }>('/due-times/platform/:platform', {
        schema: {
            description: 'Gets the next trains due at a platform',
            params: {
                type: 'object',
                properties: {
                    platform: {
                        type: 'string',
                        description: 'Platform code',
                        pattern: '^[A-Z]{3};[1-4]$',
                    }
                }
            },
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
                        lastChecked: {
                            type: 'integer',
                            description: 'Timestamp of the last heartbeat',
                            minimum: 0,
                        },
                        dueTimes: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    trn: { type: 'string' },
                                    time: { $ref: 'due-time' },
                                    status: { $ref: 'collated-train' },
                                }
                            }
                        }
                    }
                },
                404: {
                    type: 'string',
                    const: 'Platform not found'
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
        const platformDueTimes = dueTimes.get(req.params.platform);
        if (!platformDueTimes) {
            res.status(404).send("Platform not found");
            return;
        }
        sendWithProps(res,
            {
                lastChecked: downgradeHeartbeatTimes(getLastHeartbeatTimes()),
                dueTimes: platformDueTimes.map(train => downgradeDueTime(train, getCollatedTrain(train.trn))),
            },
            req.query.props
        );
    });
}
