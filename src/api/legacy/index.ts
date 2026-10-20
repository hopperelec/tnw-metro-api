import { FastifyInstance } from 'fastify';
import {registerCommonSchemas} from "../schemas";
import {registerLegacySchemas} from "./schemas";
import registerTrainsEndpoints from './endpoints/trains';
import registerStationDueTimesEndpoints from './endpoints/due-times/station';
import registerPlatformDueTimesEndpoints from './endpoints/due-times/platform';
import registerStationDueTimesStreamEndpoints from './endpoints/due-times/streams/station';
import registerPlatformDueTimesStreamEndpoints from './endpoints/due-times/streams/platform';

export default function registerLegacyApi(app: FastifyInstance) {
    registerCommonSchemas(app);
    registerLegacySchemas(app);

    registerTrainsEndpoints(app);
    registerStationDueTimesEndpoints(app);
    registerPlatformDueTimesEndpoints(app);
    registerStationDueTimesStreamEndpoints(app);
    registerPlatformDueTimesStreamEndpoints(app);
}
