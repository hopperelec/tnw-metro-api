import { FastifyInstance } from 'fastify';
import { SseClient, STREAMS_DOCUMENTATION, SWAGGER_SSE_DISCLAIMER } from "../../../../sse";
import {eventEmitter} from "../../../../../events";
import {getDueTimes, DueTimes, PlatformDueTimes} from "../../../../../due-times";
import { extractProps } from "../../../../props";
import {getCollatedTrain, getLastHeartbeatTimes} from "../../../../../heartbeat";
import {downgradeDueTime, downgradeHeartbeatTimes} from "../../../downgrade";

interface Client {
    sse: SseClient;
    platform: string;
    props?: string;
}

const clients = new Set<Client>();

function sendDueTimes(client: Client, platformDueTimes: PlatformDueTimes) {
    client.sse.sendEvent('platform-due-times', extractProps({
            date: downgradeHeartbeatTimes(getLastHeartbeatTimes()),
            dueTimes: platformDueTimes.map(train => downgradeDueTime(train, getCollatedTrain(train.trn)))
        }, client.props
    ));
}

export default function registerEndpoint(app: FastifyInstance) {
    eventEmitter.on("due-times", (dueTimes: DueTimes) => {
        for (const client of clients) {
            const platformDueTimes = dueTimes.get(client.platform);
            if (platformDueTimes) {
                sendDueTimes(client, platformDueTimes);
            }
        }
    });

    app.get<{
        Params: {
            platform: string;
        };
        Querystring: {
            props?: string;
        };
    }>('/due-times/platform/:platform/stream', {
        schema: {
            description: "Streams real-time due times for a platform via Server-Sent Events (SSE). " +
                STREAMS_DOCUMENTATION + " " + SWAGGER_SSE_DISCLAIMER,
            params: {
                type: 'object',
                properties: {
                    platform: { $ref: 'platform-code-in' },
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
                    description: 'SSE stream with "platform-due-times" events.',
                    example: ':keepalive\n\nevent: platform-due-times\ndata: {"date":1791231124968,"dueTimes":[{"trn":"101","time":{"dueIn":5,...},"status":{...}},...]}\n\n',
                }
            }
        },
    }, (req, res) => {
        const client: Client = {
            sse: new SseClient(res.raw),
            platform: req.params.platform,
            props: req.query.props
        };
        clients.add(client);

        // Send initial data if available
        const dueTimes = getDueTimes();
        if (dueTimes) {
            const platformDueTimes = dueTimes.get(client.platform);
            if (platformDueTimes) {
                sendDueTimes(client, platformDueTimes);
            }
        }

        req.raw.on('close', () => {
            clients.delete(client);
            client.sse.close();
        });
    })
}
