import {getCollatedTrain, getLastHeartbeatTimes, restartHeartbeat} from "../../../../heartbeat";
import {sendWithProps} from "../../../props";
import type {FastifyInstance} from "fastify";
import {getDueTimes, getStationDueTimes, normaliseStationCode} from "../../../../due-times";
import {DUE_TIMES_NOT_AVAILABLE} from "../../../schemas";
import {LOCATION_ABBREVIATIONS} from "../../../../constants";

export default function registerEndpoint(app: FastifyInstance) {
    app.get<{
        Params: {
            station: string;
        }
        Querystring: {
            props?: string;
        }
    }>('/due-times/station/:station', {
        schema: {
            description: 'Gets the next trains due at a station',
            params: {
                type: 'object',
                properties: {
                    station: { $ref: 'station-code-in' },
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
                        lastHeartbeat: { $ref: 'heartbeat' },
                        dueTimes: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    platform: {
                                        type: 'integer',
                                        description: 'Platform number',
                                        minimum: 1,
                                        maximum: 4,
                                    },
                                    trn: { type: 'string' },
                                    time: { $ref: 'due-time' },
                                    status: { $ref: 'collated-train' },
                                },
                                required: ['platform', 'trn', 'time', 'status']
                            }
                        }
                    },
                    required: ['lastHeartbeat', 'dueTimes']
                },
                404: {
                    type: 'string',
                    oneOf: [
                        { const: 'No due times available for this station' },
                        { const: 'Station not found' }
                    ]
                },
                500: {
                    type: 'string',
                    example: DUE_TIMES_NOT_AVAILABLE,
                }
            }
        }
    }, async (req, res) => {
        await restartHeartbeat();

        const stationCode = normaliseStationCode(req.params.station);

        const dueTimes = getDueTimes();
        if (!dueTimes) {
            res.status(500).send(DUE_TIMES_NOT_AVAILABLE);
            return;
        }

        const stationDueTimes = getStationDueTimes(dueTimes, stationCode);
        if (!stationDueTimes) {
            if (stationCode in LOCATION_ABBREVIATIONS) {
                res.status(404).send('No due times available for this station');
            } else {
                res.status(404).send('Station not found');
            }
            return;
        }

        sendWithProps(res,
            {
                lastHeartbeat: getLastHeartbeatTimes(),
                dueTimes: stationDueTimes.map(train => ({
                    ...train,
                    status: getCollatedTrain(train.trn),
                }))
            },
            req.query.props
        );
    });
}
