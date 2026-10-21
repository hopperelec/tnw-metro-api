import { restartHeartbeat } from "./heartbeat";
import {loadHistoryState} from "./history";
import {startApi} from "./api";

console.log("Starting Tyne and Wear Metro API proxy...");

await loadHistoryState();
await restartHeartbeat();
await startApi();
