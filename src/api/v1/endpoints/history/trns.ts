import type { FastifyInstance } from 'fastify';
import {getTrnsWithHistory} from "../../../../history";

export default function registerEndpoint(app: FastifyInstance) {
    app.get('/history/trns', {
        schema: {
            description: "Gets the TRNs of all trains which have any history.",
            response: {
                200: {
                    type: 'array',
                    description: 'TRNs of all trains which have any history, in alphabetical order.',
                    items: { type: 'string', example: '101' }
                }
            }
        }
    }, async () => getTrnsWithHistory());
}
