import type { FastifyInstance } from 'fastify';
import {getActiveTrains, getLastHeartbeatTimes, restartHeartbeat} from "../../../heartbeat";
import {getLastStatusChanges} from "../../../history";
import {sendWithProps} from "../../props";
import {downgradeCollatedTrain, downgradeHeartbeatTimes} from "../downgrade";

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
                        lastChecked: {
                            type: 'integer',
                            description: 'Timestamp of the last heartbeat',
                            minimum: 0,
                        },
                        trains: {
                            oneOf: [
                                {
                                    type: 'object',
                                    description: 'Map of TRNs to their current status',
                                    additionalProperties: {
                                        type: 'object',
                                        description: "A train's current status",
                                        properties: {
                                            status: { $ref: 'collated-train' },
                                            lastChanged: {
                                                type: 'integer',
                                                description: "Timestamp for when this train's status last changed",
                                                minimum: 0,
                                                // This can only be null if the history couldn't be saved
                                                nullable: true,
                                            }
                                        }
                                    }
                                },
                                {
                                    type: 'array',
                                    description: 'Array of TRNs of currently active trains',
                                    items: { type: 'string' }
                                }
                            ],
                        }
                    }
                }
            }
        }
    }, async (req, res) => {
        await restartHeartbeat();
        const activeTrains = getActiveTrains();
        const lastStatusChanges = await getLastStatusChanges(Array.from(activeTrains.keys()));
        sendWithProps(res,
            {
                lastChecked: downgradeHeartbeatTimes(getLastHeartbeatTimes()),
                trains: Object.fromEntries(
                    activeTrains.entries()
                        .map(([trn, status]) => {
                            const statusLastChanged = lastStatusChanges.get(trn);
                            return [
                                trn,
                                {
                                    status: downgradeCollatedTrain(status),
                                    lastChanged: statusLastChanged ? downgradeHeartbeatTimes(statusLastChanged) : null
                                }
                            ];
                        })
                )
            },
            req.query.props
        );
    });
}
