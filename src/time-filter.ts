import {and, gte, lte, type SQL} from "drizzle-orm";
import {heartbeat} from "./db/schema";

export default class TimeFilter {
    from?: Date;
    to?: Date;

    constructor(timeFilter?: string) {
        if (timeFilter === undefined) return;
        if (timeFilter.includes("...")) {
            const [from, to] = timeFilter.split("...");
            if (from === "" && to === "") throw new Error("Invalid time range");
            this.from = this.parseTime(from);
            this.to = this.parseTime(to);
        } else {
            const date = this.parseTime(timeFilter);
            this.from = date;
            this.to = date;
        }
    }

    private parseTime(time: string): Date {
        if (time === '') return;
        const timestamp = +time;
        const date = new Date(isNaN(timestamp) ? time : timestamp);
        if (isNaN(date.getTime())) throw new Error("Invalid timestamp");
        return date;
    }

    toHeartbeatFilter(): SQL | undefined {
        return and(
            this.from ? gte(heartbeat.endedAt, this.from) : undefined,
            this.to ? lte(heartbeat.startedAt, this.to) : undefined
        );
    }
}
