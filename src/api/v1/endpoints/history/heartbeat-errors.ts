import type { FastifyInstance } from 'fastify';
import TimeFilter from "../../../../time-filter";
import {convertContainers} from "../../../props";
import {ApiType} from "../../../../../generated/prisma/enums";
import {getHeartbeatErrors, getHeartbeatWarnings} from "../../../../history";

export default function registerEndpoint(app: FastifyInstance) {
    app.get<{
        Querystring: {
            warnings?: string;
            time?: string;
            api?: ApiType[];
        }
    }>('/history/heartbeat-errors', {
        schema: {
            description: "Gets any errors (and optionally warnings) that have occurred during a heartbeat.",
            querystring: {
                type: 'object',
                properties: {
                    warnings: {
                        type: 'string',
                        const: '',
                        description: 'If present, will also include warnings in the stream'
                    },
                    time: { $ref: 'time-filter' },
                    api: {
                        type: 'array',
                        description: 'Which APIs to get errors (and optionally warnings) for. If none are specified, all APIs are included.',
                        items: {
                            type: 'string',
                            enum: Object.values(ApiType),
                        }
                    }
                }
            },
            response: {
                200: {
                    oneOf: [
                        {
                            type: 'array',
                            description: 'A list of heartbeat errors, sorted by date.',
                            items: { $ref: 'heartbeat-error' }
                        },
                        {
                            type: 'object',
                            properties: {
                                errors: {
                                    type: 'array',
                                    description: 'A list of heartbeat errors, sorted by date.',
                                    items: { $ref: 'heartbeat-error' }
                                },
                                warnings: {
                                    type: 'array',
                                    description: 'A list of heartbeat warnings, sorted by date.',
                                    items: { $ref: 'heartbeat-warning' }
                                },
                            },
                            required: ['errors', 'warnings'],
                        }
                    ],
                },
                400: {
                    description: 'Malformed query parameters',
                    type: 'string',
                }
            }
        }
    }, async (req, res) => {
        let timeFilter: TimeFilter;
        try {
            timeFilter = new TimeFilter(req.query.time);
        } catch (e) {
            res.status(400).send(e.message);
            return;
        }
        const apis = req.query.api;

        if (req.query.warnings === undefined) {
            res.send(convertContainers(await getHeartbeatErrors(timeFilter, apis)));
        } else {
            const [errors, warnings] = await Promise.all([
                getHeartbeatErrors(timeFilter, apis).then(convertContainers),
                getHeartbeatWarnings(timeFilter, apis).then(convertContainers)
            ]);
            res.send({errors, warnings});
        }
    });
}
