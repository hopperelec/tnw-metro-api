import type { FastifyInstance } from 'fastify';
import { SseClient, STREAMS_DOCUMENTATION, SWAGGER_SSE_DISCLAIMER } from "../../../../sse";
import {eventEmitter} from "../../../../../events";
import {getDueTimes, type DueTimes, getStationDueTimes, normaliseStationCode} from "../../../../../due-times";
import { extractProps } from "../../../../props";
import {getCollatedTrain, getLastHeartbeatTimes} from "../../../../../heartbeat";
import {downgradeDueTime, downgradeHeartbeatTimes} from "../../../downgrade";

interface Client {
    sse: SseClient;
    station: string;
    props?: string;
}

const clients = new Set<Client>();

function sendDueTimes(client: Client, dueTimes: DueTimes) {
    const stationDueTimes = getStationDueTimes(dueTimes, client.station);
    if (!stationDueTimes) return;
    client.sse.sendEvent('station-due-times', extractProps({
        date: downgradeHeartbeatTimes(getLastHeartbeatTimes()),
        dueTimes: stationDueTimes.map(train => downgradeDueTime(train, getCollatedTrain(train.trn))),
    }, client.props));
}

export default function registerEndpoint(app: FastifyInstance) {
    eventEmitter.on("due-times", (dueTimes: DueTimes) => {
        for (const client of clients) {
            sendDueTimes(client, dueTimes);
        }
    });

    app.get<{
        Params: {
            station: string;
        };
        Querystring: {
            props?: string;
        };
    }>('/due-times/station/:station/stream', {
        schema: {
            description: "Streams real-time due times for a station via Server-Sent Events (SSE). " +
                STREAMS_DOCUMENTATION + " " + SWAGGER_SSE_DISCLAIMER,
            params: {
                type: 'object',
                properties: {
                    // This isn't validated, since it wasn't before versioning was added (due to a typo)
                    station: { type: 'string', description: 'Station code' },
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
                    type: 'string',
                    description: 'SSE stream with "station-due-times" events.',
                    example: ':keepalive\n\nevent: station-due-times\ndata: {"date":1791231124968,"dueTimes":[{"trn":"101","platform":3,"time":{"dueIn":5,...},"status":{...}},...]}\n\n',
                }
            }
        },
    }, (req, res) => {
        const client: Client = {
            sse: new SseClient(res.raw),
            station: normaliseStationCode(req.params.station),
            props: req.query.props
        };
        clients.add(client);

        // Send initial data if available
        const dueTimes = getDueTimes();
        if (dueTimes) {
            sendDueTimes(client, dueTimes);
        }

        req.raw.on('close', () => {
            clients.delete(client);
            client.sse.close();
        });
    })
}
