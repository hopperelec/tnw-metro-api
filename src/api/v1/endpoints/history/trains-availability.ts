import { FastifyInstance } from 'fastify';
import TimeFilter from "../../../../time-filter";
import { convertContainers } from "../../../props";
import {TrainDataAPI, TrainDataAPIs} from "../../../../types";
import {DEFAULT_HISTORY_REQUEST_LIMIT, MAX_HISTORY_REQUEST_LIMIT} from "../../limits";
import {getTrainsAvailability} from "../../../../history";

export default function registerEndpoint(app: FastifyInstance) {
    app.get<{
        Querystring: {
            trn?: string[];
            api?: TrainDataAPI[];
            time?: string;
            limit?: number;
            limitPerTrn?: number;
        }
    }>('/history/trains/availability', {
        schema: {
            description: "Gets the time ranges during which specific trains were continuously active in each API.",
            querystring: {
                type: 'object',
                properties: {
                    trn: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Which TRNs to get availability history for. If none are specified, history for all trains will be returned.'
                    },
                    api: {
                        type: 'array',
                        description: 'Which APIs to include availability for. If none are specified, data from all APIs will be included.',
                        items: {
                            type: 'string',
                            enum: TrainDataAPIs
                        }
                    },
                    time: { $ref: 'time-filter' },
                    limit: {
                        type: 'integer',
                        description: 'Limit the total number of status entries returned across all trains. ' +
                            'This is done by truncating the time window until the limit is satisfied.',
                        minimum: 1,
                        maximum: MAX_HISTORY_REQUEST_LIMIT,
                        default: DEFAULT_HISTORY_REQUEST_LIMIT,
                    },
                    limitPerTrn: {
                        type: 'integer',
                        description: 'Limit the number of status entries returned per train. ' +
                            'This is applied after the global limit and time window are calculated.',
                        minimum: 1
                    },
                }
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        trains: {
                            type: 'object',
                            description: 'Map of TRNs to their availability data.',
                            additionalProperties: {
                                type: 'object',
                                description: 'Map of API names to availability data for the train in that API.',
                                additionalProperties: {
                                    type: 'array',
                                    description: 'An array of time ranges during which the train was active in the API.',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            start: { type: 'integer' },
                                            end: { type: 'integer' },
                                        },
                                        required: ['start']
                                    }
                                }
                            }
                        },
                        truncatedTo: {
                            type: 'number',
                            description: 'If the results were truncated due to a limit being reached, the time they were truncated to.',
                            nullable: true,
                            minimum: 0
                        }
                    }
                },
                400: {
                    description: 'Malformed query parameters',
                    type: 'string',
                }
            }
        }
    }, async (req, res) => {
        const {
            trn: trns,
            api: apis,
            time: timeFilterStr,
            limit,
            limitPerTrn,
        } = req.query;

        let timeFilter: TimeFilter;
        try {
            timeFilter = new TimeFilter(timeFilterStr);
        } catch (e) {
            res.status(400).send(e.message);
            return;
        }

        return convertContainers(await getTrainsAvailability(
            new Set(trns),
            new Set(apis),
            timeFilter,
            limit,
            limitPerTrn
        ));
    });
}
