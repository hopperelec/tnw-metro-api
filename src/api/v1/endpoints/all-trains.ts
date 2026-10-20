import { FastifyInstance } from 'fastify';
import {getActiveTrains, getLastHeartbeatTimes, restartHeartbeat} from "../../../heartbeat";
import {sendWithProps} from "../../props";
import {getLastStatusChanges} from "../../../history";

export default function registerEndpoint(app: FastifyInstance) {
    app.get<{
        Querystring: {
            props?: string;
        }
    }>('/trains', {
        schema: {
            description: 'Gets the current status of all currently active trains',
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
                        trains: {
                            oneOf: [
                                {
                                    type: 'object',
                                    description: 'Map of TRNs to all active trains',
                                    additionalProperties: {
                                        type: 'object',
                                        description: "A train's current status",
                                        properties: {
                                            status: { $ref: 'collated-train' },
                                            statusLastChanged: { $ref: 'heartbeat' }
                                        },
                                        required: ['status', 'statusLastChanged']
                                    }
                                },
                                {
                                    type: 'array',
                                    description: 'Array of TRNs of currently active trains',
                                    items: { type: 'string' }
                                }
                            ],
                        }
                    },
                    required: ['lastHeartbeat', 'trains']
                }
            }
        }
    }, async (req, res) => {
        await restartHeartbeat();
        const activeTrains = getActiveTrains();
        const lastStatusChanges = await getLastStatusChanges(Array.from(activeTrains.keys()));
        sendWithProps(res,
            {
                lastHeartbeat: getLastHeartbeatTimes(),
                trains: Object.fromEntries(
                    activeTrains.entries()
                        .map(([trn, status]) => [
                            trn,
                            {
                                status: status,
                                statusLastChanged: lastStatusChanges.get(trn)
                            }
                        ])
                )
            },
            req.query.props
        );
    });
}