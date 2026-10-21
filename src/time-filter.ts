import type {HeartbeatWhereInput} from "../generated/prisma/models/Heartbeat";

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

    toHeartbeatFilter(): HeartbeatWhereInput {
        if (!this.from && !this.to) return;
        const filter: HeartbeatWhereInput = {};
        if (this.from) {
            filter.endedAt = { gte: this.from };
        }
        if (this.to) {
            filter.startedAt = { lte: this.to };
        }
        return filter;
    }
}
