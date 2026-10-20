import {getCollatedTrain, getLastHeartbeatTimes, restartHeartbeat} from "../../../heartbeat";
import {
    getCurrentTimetableAndTime,
    getExpectedTrainState, getTimetable
} from "../../../parsing/timetable";
import {sendWithProps} from "../../props";
import {FastifyInstance} from "fastify";
import {getLastStatusChanges} from "../../../history";

export default function registerEndpoint(app: FastifyInstance) {
    app.get<{
        Params: {
            trn: string;
        }
        Querystring: {
            props?: string;
        }
    }>('/train/:trn', {
        schema: {
            description: 'Gets the current and timetabled status of a train',
            params: {
                type: 'object',
                properties: {
                    trn: { $ref: 'trn' }
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
                        statusLastChangedDuring: { $ref: 'heartbeat' },
                        status: {
                            // This is meant to be nullable, but
                            // I couldn't get Fastify to accept `$ref` inside a `oneOf`,
                            // which is needed to make a `$ref` nullable.
                            // So, for now, the property will just be missing if the train is not active.
                            $ref: 'collated-train'
                        },
                        timetable: {
                            type: 'object',
                            description: 'Timetabled state, or null if the train is not timetabled for today.',
                            nullable: true,
                            properties: {
                                event: {
                                    type: 'string',
                                    enum: ['ARRIVED', 'DEPARTED', 'APPROACHING']
                                },
                                location: { type: 'string'},
                                inService: { type: 'boolean' },
                                destination: { type: 'string' }
                            },
                            required: ['event', 'location', 'inService', 'destination']
                        }
                    },
                    required: ['lastHeartbeat', 'statusLastChangedDuring', 'timetable']
                }
            }
        }
    }, async (req, res) => {
        await restartHeartbeat();
        const {trn} = req.params;
        const collatedTrain = getCollatedTrain(trn);
        const {timetableRef, time} = getCurrentTimetableAndTime();
        const timetable = await getTimetable(timetableRef);
        const trainTimetable = timetable.trains[trn];
        sendWithProps(res,
            {
                lastHeartbeat: getLastHeartbeatTimes(),
                statusLastChangedDuring: (await getLastStatusChanges([trn])).get(trn) ?? null,
                // Omitted if the train isn't active, since the schema can't make it nullable (see above)
                ...(collatedTrain && { status: collatedTrain }),
                timetable: trainTimetable ? getExpectedTrainState(trainTimetable, time) : null,
            },
            req.query.props
        );
    });
}