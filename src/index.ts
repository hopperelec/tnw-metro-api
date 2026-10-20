import { config } from 'dotenv';
import { restartHeartbeat } from "./heartbeat";
import {loadHistoryState} from "./history";
import {startApi} from "./api";

console.log("Starting Tyne and Wear Metro API proxy...");

config();

await loadHistoryState();
await restartHeartbeat();
await startApi();
