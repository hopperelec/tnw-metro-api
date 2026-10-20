import { FastifyInstance } from 'fastify';
import {registerCommonSchemas} from "../schemas";
import {registerV1Schemas} from "./schemas";
import registerConstantsEndpoints from './endpoints/constants';
import registerTimetableEndpoints from './endpoints/timetable';
import registerTrainEndpoints from './endpoints/train';
import registerTrainsEndpoints from './endpoints/all-trains';
import registerAllDueTimesEndpoints from './endpoints/due-times/all';
import registerStationDueTimesEndpoints from './endpoints/due-times/station';
import registerPlatformDueTimesEndpoints from './endpoints/due-times/platform';
import registerHistorySnapshotEndpoints from './endpoints/history/snapshot';
import registerTrainsHistoryEndpoints from './endpoints/history/trains';
import registerTrainsAvailabilityEndpoints from './endpoints/history/trains-availability';
import registerHeartbeatErrorsEndpoints from './endpoints/history/heartbeat-errors';
import registerTrnsWithHistoryEndpoints from './endpoints/history/trns';
import registerSubscriptionsEndpoints from './endpoints/subscriptions';

export default function registerV1Api(app: FastifyInstance) {
    registerCommonSchemas(app);
    registerV1Schemas(app);

    registerConstantsEndpoints(app);
    registerTimetableEndpoints(app);
    registerTrainEndpoints(app);
    registerTrainsEndpoints(app);
    registerAllDueTimesEndpoints(app);
    registerStationDueTimesEndpoints(app);
    registerPlatformDueTimesEndpoints(app);
    registerHistorySnapshotEndpoints(app);
    registerTrainsHistoryEndpoints(app);
    registerTrainsAvailabilityEndpoints(app);
    registerHeartbeatErrorsEndpoints(app);
    registerTrnsWithHistoryEndpoints(app);
    registerSubscriptionsEndpoints(app);
}
