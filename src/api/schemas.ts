import {FastifyInstance} from "fastify";
import {PLATFORM_CODE_REGEX} from "../parsing/rti/times-api";

/** The error response for due times endpoints when the due times couldn't be fetched */
export const DUE_TIMES_NOT_AVAILABLE = "Due times not available. More information may be available in the heartbeat-errors.";

/** Registers the shared schemas which are the same in every version */
export function registerCommonSchemas(app: FastifyInstance) {
    app.addSchema({
        $id: 'props',
        type: 'string',
        description: 'A comma-separated list of properties to include in the response. ' +
            'Properties are dot-separated lists of keys. ' +
            'To only select keys of a record, use the "keys" property; for example, `?props=trains.keys`. ' +
            'For arrays or records, keys will be filtered on each element instead. ' +
            'If no properties are specified, all properties will be included.'
    });

    app.addSchema({
        $id: 'platform-code-in',
        type: 'string',
        description: 'Platform code',
        pattern: PLATFORM_CODE_REGEX.source,
    });

    app.addSchema({
        $id: 'platform-code-out',
        type: 'string',
        description: 'Platform code, usually in the format `<station code>;<platform number>`. ' +
            'The proxy does not check the validity of the station code or platform number, ' +
            'so you should do your own checks if you need to parse this.',
        example: 'MTW;3',
    });

    app.addSchema({
        $id: 'station-code-in',
        type: 'string',
        description: 'Station code',
        pattern: '^[A-Z]{3}$',
    });

    app.addSchema({
        $id: 'due-time',
        type: 'object',
        properties: {
            dueIn: {
                type: 'integer',
                description: 'In how many minutes the train is due, 0 for "Due", -1 for "Arrived" or -2 for "Delayed"',
                minimum: -2
            },
            actualScheduledTime: {
                type: 'integer',
                description: 'Timestamp for the scheduled time according to Nexus, or null',
                minimum: 0,
                nullable: true
            },
            actualPredictedTime: {
                type: 'integer',
                description: 'Timestamp for the predicted time according to Nexus',
                minimum: 0,
            }
        },
        required: ['dueIn', 'actualScheduledTime', 'actualPredictedTime']
    });
}
