import {ServerResponse} from "http";

const KEEPALIVE_INTERVAL = 25000; // milliseconds

export const STREAMS_DOCUMENTATION = 'Refer to [the streams documentation](https://github.com/hopperelec/tnw-metro-api/blob/master/stream.md) ' +
    'for details of the events.';

export const SWAGGER_SSE_DISCLAIMER = 'Keep in mind that Swagger (the tool used to generate this documentation) does not ' +
        'support streaming responses, so the response will never load if you use the "Try it out" button. ' +
        'To test this endpoint, you will need to visit the endpoint manually.';

export class SseClient {
    private response: ServerResponse;
    private keepAlive?: NodeJS.Timeout;

    constructor(response: ServerResponse) {
        this.response = response;
        response.setHeader('Content-Type', 'text/event-stream');
        response.setHeader('Cache-Control', 'no-cache');
        response.setHeader('Connection', 'keep-alive');
        response.setHeader('Access-Control-Allow-Origin', '*');
        this.sendKeepAlive();
        this.restartKeepAlive();
    }

    public sendEvent(event: string, data?: any) {
        if (this.response.writableEnded || this.response.destroyed) return;
        clearInterval(this.keepAlive);
        this.restartKeepAlive();
        this.response.write(`event: ${event}\n`);
        if (data) this.response.write(`data: ${JSON.stringify(data)}\n`);
        this.response.write('\n');
    }

    /** Stops sending keepalives, and ends the response if it hasn't already ended */
    public close() {
        clearInterval(this.keepAlive);
        if (!this.response.writableEnded) this.response.end();
    }

    private sendKeepAlive() {
        this.response.write(':keepalive\n\n');
    }

    private restartKeepAlive() {
        this.keepAlive = setInterval(() => {
            this.sendKeepAlive();
        }, KEEPALIVE_INTERVAL);
    }
}
