import {EventEmitter} from "node:events";

/** Emits events for changes, such as the end of each heartbeat, which the API sends to streams */
export const eventEmitter = new EventEmitter();
