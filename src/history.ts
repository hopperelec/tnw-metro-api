import {ApiType, PrismaClient, Prisma} from "../generated/prisma/client";
import {TimesAPI} from "./parsing/rti";
import {TimesApiTrainDataSelect} from "../generated/prisma/models/TimesApiTrainData";
import {GeoAPI} from "./parsing/rti";
import {GeoApiData} from "./parsing/rti/geo-api";
import {GeoApiTrainDataSelect} from "../generated/prisma/models/GeoApiTrainData";
import {InputJsonValue, JsonValue} from "@prisma/client/runtime/client";
import {HeartbeatError, HeartbeatTimes, HeartbeatWarning} from "./heartbeat";
import TimeFilter from "./time-filter";
import {Platform, TrainDataAPI, TrainFilters} from "./types";
import {HeartbeatSelect} from "../generated/prisma/models/Heartbeat";
import {eventEmitter} from "./events";
import {PrismaMariaDb} from "@prisma/adapter-mariadb";
import {config} from "dotenv";

// Run on every new database connection:
// - The Prisma adapter sends and parses dates as UTC, but `TIMESTAMP`s are converted using the session's time zone,
//    so it must be UTC. Otherwise (e.g. on a server using BST) dates would be shifted, and times during the hour
//    repeated when the clocks go back would collide.
// - Allows the optimiser to satisfy `ORDER BY ... LIMIT` by reading an index in order and stopping early, rather than
//    reading and sorting every matching row, which makes most limited history queries orders of magnitude faster.
//    It is only available from MariaDB 11.4.1, so is in a version-specific comment which older versions ignore.
const SESSION_INIT_SQL = "SET time_zone = '+00:00' /*M!110401 , SESSION optimizer_join_limit_pref_ratio = 100 */";

export function withSessionInit(databaseUrl: string): string {
    // `URLSearchParams` would encode spaces as `+`, which the driver doesn't decode
    return `${databaseUrl}${databaseUrl.includes("?") ? "&" : "?"}initSql=${encodeURIComponent(SESSION_INIT_SQL)}`;
}

config();
export const prisma = new PrismaClient({
    adapter: new PrismaMariaDb(withSessionInit(process.env.DATABASE_URL!))
});

// --- Heartbeat Lifecycle ---

export async function startHeartbeat(startedAt: Date): Promise<void> {
    await prisma.heartbeat.create({
        data: { startedAt },
        // Prisma forces us to select *something* for some reason, but we don't actually need the result
        select: { startedAt: true }
    });
}

export async function endHeartbeat(startedAt: Date, endedAt: Date): Promise<void> {
    await prisma.heartbeat.update({
        where: { startedAt },
        data: { endedAt },
        // Prisma forces us to select *something* for some reason, but we don't actually need the result
        select: { startedAt: true }
    });
}

// --- Lookup tables and current data ---

/** Data which is current for a train */
export interface CurrentData {
    id: number;
    key: string;
}

// Caches of known lookup table entries, and the current data for each TRN, to minimise database queries.
const knownEventTypes = new Map<string, number>();
const knownTrains = new Map<string, number>();
const knownParsedPlatforms = new Map<string, number>(); // `${station}|${platformNumber}` -> ID
const knownUnparsedPlatforms = new Map<string, number>(); // raw -> ID
const knownDestinations = new Map<string, number>();
const currentTimesData = new Map<string, CurrentData>();
const currentGeoData = new Map<string, CurrentData>();

/** Loads the data which is current for each train, by TRN */
export async function loadCurrentData(): Promise<{
    times: Map<string, CurrentData>;
    geo: Map<string, CurrentData>;
}> {
    const [times, geo] = await Promise.all([
        prisma.timesApiTrainData.findMany({
            select: { id: true, train: { select: { trn: true } }, ...selectTimesTrainData },
            where: { endHeartbeatAt: null }
        }),
        prisma.geoApiTrainData.findMany({
            select: { id: true, train: { select: { trn: true } }, ...selectGeoTrainData },
            where: { endHeartbeatAt: null }
        }),
    ]);
    return {
        times: new Map(times.map(row => [row.train.trn, { id: row.id, key: timesDataKey(formatTimesData(row)) }])),
        geo: new Map(geo.map(row => [row.train.trn, { id: row.id, key: geoDataKey(formatGeoData(row)) }])),
    };
}

/** Loads the state needed to add new data, which must be done before the first heartbeat */
export async function loadHistoryState(): Promise<void> {
    const [eventTypes, trains, parsedPlatforms, unparsedPlatforms, destinations, currentData] = await Promise.all([
        prisma.trainEventType.findMany({ select: { id: true, name: true } }),
        prisma.train.findMany({ select: { id: true, trn: true } }),
        prisma.parsedPlatform.findMany({ select: { id: true, station: true, platformNumber: true } }),
        prisma.unparsedPlatform.findMany({ select: { id: true, raw: true } }),
        prisma.destination.findMany({ select: { id: true, name: true } }),
        loadCurrentData(),
    ]);
    knownEventTypes.clear();
    for (const eventType of eventTypes) {
        knownEventTypes.set(eventType.name, eventType.id);
    }
    knownTrains.clear();
    for (const train of trains) {
        knownTrains.set(train.trn, train.id);
    }
    knownParsedPlatforms.clear();
    for (const platform of parsedPlatforms) {
        knownParsedPlatforms.set(`${platform.station}|${platform.platformNumber}`, platform.id);
    }
    knownUnparsedPlatforms.clear();
    for (const platform of unparsedPlatforms) {
        knownUnparsedPlatforms.set(platform.raw, platform.id);
    }
    knownDestinations.clear();
    for (const destination of destinations) {
        knownDestinations.set(destination.name, destination.id);
    }
    currentTimesData.clear();
    for (const [trn, data] of currentData.times) {
        currentTimesData.set(trn, data);
    }
    currentGeoData.clear();
    for (const [trn, data] of currentData.geo) {
        currentGeoData.set(trn, data);
    }
    console.log(
        'Loaded history state: ' +
        `${knownEventTypes.size} event types, ` +
        `${knownTrains.size} trains, ` +
        `${knownParsedPlatforms.size} parsed platforms, ` +
        `${knownUnparsedPlatforms.size} unparsed platforms, ` +
        `${knownDestinations.size} destinations, ` +
        `${currentTimesData.size} trains with current Times API data, ` +
        `${currentGeoData.size} trains with current Geo API data`
    );
}

async function lookupId(known: Map<string, number>, key: string, create: () => Promise<{ id: number }>): Promise<number> {
    let id = known.get(key);
    if (id === undefined) {
        id = (await create()).id;
        known.set(key, id);
    }
    return id;
}

function trainId(trn: string): Promise<number> {
    return lookupId(knownTrains, trn, () =>
        prisma.train.create({ data: { trn }, select: { id: true } })
    );
}

function eventTypeId(name: string): Promise<number> {
    return lookupId(knownEventTypes, name, () =>
        prisma.trainEventType.create({ data: { name }, select: { id: true } })
    );
}

function destinationId(name: string): Promise<number> {
    return lookupId(knownDestinations, name, () =>
        prisma.destination.create({ data: { name }, select: { id: true } })
    );
}

function parsedPlatformId({ station, platformNumber }: Platform): Promise<number> {
    return lookupId(knownParsedPlatforms, `${station}|${platformNumber}`, () =>
        prisma.parsedPlatform.create({ data: { station, platformNumber }, select: { id: true } })
    );
}

function unparsedPlatformId(raw: string, parsed: Platform | undefined): Promise<number> {
    return lookupId(knownUnparsedPlatforms, raw, async () =>
        prisma.unparsedPlatform.create({
            data: { raw, parsedPlatformId: parsed ? await parsedPlatformId(parsed) : null },
            select: { id: true }
        })
    );
}

/// --- Trains ---

async function timesDataRow(trn: string, data: Omit<TimesAPI.ParsedTrain, 'nextPlatforms'>, heartbeatStartedAt: Date): Promise<Prisma.TimesApiTrainDataUncheckedCreateInput> {
    const { location } = data.lastEvent;
    const plannedDestinations: Prisma.PlannedDestinationUncheckedCreateWithoutStatusInput[] = [];
    for (const destination of data.plannedDestinations) {
        plannedDestinations.push({
            destinationId: await destinationId(destination.name),
            fromPlatformId: await unparsedPlatformId(destination.from.platformCode, TimesAPI.parsePlatformCode(destination.from.platformCode)),
            fromTime: destination.from.time,
        });
    }
    return {
        trainId: await trainId(trn),
        startHeartbeatAt: heartbeatStartedAt,
        lastEventLocationId: typeof location === 'string'
            ? await unparsedPlatformId(location, undefined)
            : await unparsedPlatformId(TimesAPI.formatLastEventLocation(location), location),
        lastEventTypeId: await eventTypeId(data.lastEvent.type),
        lastEventTime: data.lastEvent.time,
        firstPlannedDestinationId: plannedDestinations[0]?.destinationId ?? null,
        plannedDestinations: { create: plannedDestinations },
    };
}

async function geoDataRow(trn: string, data: GeoAPI.TrainStatus, heartbeatStartedAt: Date): Promise<Prisma.GeoApiTrainDataUncheckedCreateInput> {
    const { lastSeen } = data;
    const row = {
        trainId: await trainId(trn),
        startHeartbeatAt: heartbeatStartedAt,
        destinationId: await destinationId(data.destination),
    };
    if (typeof lastSeen === 'string') {
        return { ...row, rawLastSeen: lastSeen };
    }
    return {
        ...row,
        lastEventPlatformId: await parsedPlatformId(lastSeen),
        lastEventTypeId: await eventTypeId(lastSeen.type),
        lastEventTime: lastSeen.time,
    };
}

interface Changes<Data> {
    /** TRNs whose current data was replaced or is no longer present */
    ended: string[];
    added: { trn: string; data: Data; key: string }[];
}

/**
 * Compares new data from an API with each train's current data.
 * If there is no new data (e.g. the API failed), all current data has ended.
 */
function findChanges<Data>(
    current: Map<string, CurrentData>,
    newData: Map<string, Data> | undefined,
    getKey: (data: Data) => string
): Changes<Data> {
    const changes: Changes<Data> = { ended: [], added: [] };
    for (const [trn, data] of newData ?? []) {
        const key = getKey(data);
        if (current.get(trn)?.key === key) continue;
        if (current.has(trn)) changes.ended.push(trn);
        changes.added.push({ trn, data, key });
    }
    for (const trn of current.keys()) {
        if (!newData?.has(trn)) changes.ended.push(trn);
    }
    return changes;
}

function applyChanges(current: Map<string, CurrentData>, changes: Changes<unknown>, addedIds: number[]) {
    for (const trn of changes.ended) {
        current.delete(trn);
    }
    changes.added.forEach(({ trn, key }, i) => current.set(trn, { id: addedIds[i], key }));
}

export async function addApiData(
    heartbeatStartedAt: Date,
    timesApiData?: TimesAPI.ParsedTimes,
    geoApiData?: GeoApiData
): Promise<void> {
    const timesChanges = findChanges(currentTimesData, timesApiData?.trains, timesDataKey);
    const geoChanges = findChanges(currentGeoData, geoApiData, geoDataKey);

    const timesRows: Prisma.TimesApiTrainDataUncheckedCreateInput[] = [];
    for (const { trn, data } of timesChanges.added) {
        timesRows.push(await timesDataRow(trn, data, heartbeatStartedAt));
    }
    const geoRows: Prisma.GeoApiTrainDataUncheckedCreateInput[] = [];
    for (const { trn, data } of geoChanges.added) {
        geoRows.push(await geoDataRow(trn, data, heartbeatStartedAt));
    }

    const [timesIds, geoIds] = await prisma.$transaction(async prisma => {
        if (timesChanges.ended.length) {
            await prisma.timesApiTrainData.updateMany({
                where: { id: { in: timesChanges.ended.map(trn => currentTimesData.get(trn)!.id) } },
                data: { endHeartbeatAt: heartbeatStartedAt }
            });
        }
        if (geoChanges.ended.length) {
            await prisma.geoApiTrainData.updateMany({
                where: { id: { in: geoChanges.ended.map(trn => currentGeoData.get(trn)!.id) } },
                data: { endHeartbeatAt: heartbeatStartedAt }
            });
        }
        // Only a few trains' data changes each heartbeat, so each is simply created separately
        const timesIds: number[] = [];
        for (const data of timesRows) {
            timesIds.push((await prisma.timesApiTrainData.create({ data, select: { id: true } })).id);
        }
        const geoIds: number[] = [];
        for (const data of geoRows) {
            geoIds.push((await prisma.geoApiTrainData.create({ data, select: { id: true } })).id);
        }
        return [timesIds, geoIds];
    }, {
        // Usually only a few rows are created, but after an API failure, every train's data is created again
        timeout: 60_000
    });
    applyChanges(currentTimesData, timesChanges, timesIds);
    applyChanges(currentGeoData, geoChanges, geoIds);
}

/** The TRNs of all trains which have any history, which are all trains since they're only added when data is */
export async function getTrnsWithHistory(): Promise<string[]> {
    const trains = await prisma.train.findMany({ select: { trn: true }, orderBy: { trn: 'asc' } });
    return trains.map(train => train.trn);
}

/**
 * The heartbeats during which each train's data last started or ended in any API, by TRN.
 * If `at` is given, this is as of that heartbeat, so later data is ignored.
 */
export async function getLastStatusChanges(trns: string[], at?: Date): Promise<Map<string, HeartbeatTimes>> {
    if (!trns.length) return new Map();
    // A train's data for an API never overlaps, so its latest data (see `getDataIdsDuringHeartbeat`) is the last to have
    //  started or ended. Its end only counts if it had ended by `at`.
    const changedAt = at
        ? Prisma.sql`IF(d.endHeartbeatAt <= ${at}, d.endHeartbeatAt, d.startHeartbeatAt)`
        : Prisma.sql`COALESCE(d.endHeartbeatAt, d.startHeartbeatAt)`;
    const startedBy = at ? Prisma.sql`WHERE startHeartbeatAt <= ${at}` : Prisma.empty;
    const rows = await prisma.$queryRaw<{ trn: string; startedAt: Date; endedAt: Date | null }[]>`
        SELECT t.trn, h.startedAt, h.endedAt
        FROM (
            SELECT trainId, MAX(changedAt) AS changedAt
            FROM (
                SELECT d.trainId, ${changedAt} AS changedAt
                FROM TimesApiTrainData d
                JOIN (
                    SELECT trainId, MAX(startHeartbeatAt) AS startHeartbeatAt FROM TimesApiTrainData ${startedBy}
                    GROUP BY trainId
                ) latest USING (trainId, startHeartbeatAt)
                UNION ALL
                SELECT d.trainId, ${changedAt}
                FROM GeoApiTrainData d
                JOIN (
                    SELECT trainId, MAX(startHeartbeatAt) AS startHeartbeatAt FROM GeoApiTrainData ${startedBy}
                    GROUP BY trainId
                ) latest USING (trainId, startHeartbeatAt)
            ) changes
            GROUP BY trainId
        ) lastChange
        JOIN Train t ON t.id = lastChange.trainId
        JOIN Heartbeat h ON h.startedAt = lastChange.changedAt
        WHERE t.trn IN (${Prisma.join(trns)})
    `;
    return new Map(rows.map(row => [row.trn, { startedAt: row.startedAt, endedAt: row.endedAt }]));
}

// Returns filter function
function truncate(
    limit: number | undefined,
    limitPerTrn: number | undefined,
    entries: Iterable<{ trn: string; start: Date }>,
    order: 'asc' | 'desc'
): {
    filterFn: (time: Date) => boolean;
    truncationTime: Date;
} | null {
    const trnToTimes = new Map<string, Date[]>();
    for (const { trn, start } of entries) {
        if (!trnToTimes.has(trn)) {
            trnToTimes.set(trn, []);
        }
        trnToTimes.get(trn)!.push(start);
    }

    const filterFn = order === 'asc'
        ? (time: Date) => time < truncationTime
        : (time: Date) => time > truncationTime;
    const sortFn = order === 'asc'
        ? (a: Date, b: Date) => a.getTime() - b.getTime()
        : (a: Date, b: Date) => b.getTime() - a.getTime();

    let truncationTime: Date | null = null;
    if (limitPerTrn) {
        // For consistency, it is the *time window* that is truncated, not the results for individual trains.
        // If one train has more entries than the limit, *all* trains are truncated.
        for (const times of trnToTimes.values()) {
            if (times.length > limitPerTrn) {
                times.sort(sortFn);
                const truncTimeForThisTrn = times[limitPerTrn]; // first time beyond limit
                if (!truncationTime || filterFn(truncTimeForThisTrn)) {
                    truncationTime = truncTimeForThisTrn;
                }
            }
        }
    }
    if (limit) {
        let allTimes = Array.from(trnToTimes.values()).flat();
        if (truncationTime) {
            allTimes = allTimes.filter(filterFn);
        }
        allTimes.sort(sortFn);
        if (allTimes.length > limit) {
            truncationTime = allTimes[limit]; // first time beyond limit
        }
    }

    return truncationTime ? { filterFn, truncationTime } : null;
}

type TrainHistoryEntry<Status> = {
    startHeartbeat: HeartbeatTimes;
    endHeartbeat: HeartbeatTimes | null;
    status: Status;
};

export async function getTrainsHistory(
    { trns, apis, eventTypes, locations, destinations }: TrainFilters,
    timeFilter?: TimeFilter,
    limit?: number,
    limitPerTrn?: number,
): Promise<{
    truncatedTo: Date | null,
    trains: Map<string, {
        timesAPI?: TimesTrainHistoryEntry[],
        geoAPI?: GeoTrainHistoryEntry[],
    }>
}> {
    const includeTimes = !apis?.size || apis.has('TIMES');
    const includeGeo = !apis?.size || apis.has('GEO');
    const hasAnyLimit = !!(limitPerTrn || limit);
    const order = timeFilter?.from ? 'asc' : 'desc';

    // --- Fetch potentially matching data rows ---

    const baseSelect = Prisma.sql`
    t.trn AS trn,
    h1.startedAt AS startHeartbeatStartedAt,
    h1.endedAt AS startHeartbeatEndedAt,
    h2.startedAt AS endHeartbeatStartedAt,
    h2.endedAt AS endHeartbeatEndedAt
    `;

    const orderClause = Prisma.sql`ORDER BY data.startHeartbeatAt ${Prisma.raw(order)}`;

    // Note that 1 is added to detect truncation
    const globalLimitClause = limit
        ? Prisma.sql`
        ${orderClause}
        LIMIT ${limit + 1}
        `
        : Prisma.empty;

    // When limiting per train, each train is queried separately (in one statement) so that the
    //  `(trainId, startHeartbeatAt)` index can be used to only read the first rows for each train.
    const perTrainIds = limitPerTrn
        ? (await prisma.train.findMany({
            select: { id: true },
            where: trns?.size ? { trn: { in: Array.from(trns) } } : undefined
        })).map(train => train.id)
        : [];
    // A train's rows beyond the first `limit + 1` would be beyond the first `limit + 1` overall too, so can't be needed
    const perTrainLimit = Math.min(limitPerTrn, limit ?? Infinity);

    function runApiQuery(
        select: Prisma.Sql,
        from: Prisma.Sql,
        whereClauses: Prisma.Sql[]
    ): Promise<any> {
        function buildQuery(extraWhereClauses: Prisma.Sql[], limitClause: Prisma.Sql) {
            const allWhereClauses = [...whereClauses, ...extraWhereClauses];
            const whereClause = allWhereClauses.length ? Prisma.sql`WHERE ${Prisma.join(allWhereClauses, ' AND ')}` : Prisma.empty;
            return Prisma.sql`
            SELECT
                ${select},
                ${baseSelect}
            FROM ${from}
            ${whereClause}
            ${limitClause}
            `;
        }

        if (!limitPerTrn) {
            return prisma.$queryRaw(buildQuery([], globalLimitClause));
        }
        if (!perTrainIds.length) {
            return Promise.resolve([]);
        }
        const perTrainQueries = perTrainIds.map(trainId => Prisma.sql`(${buildQuery(
            [Prisma.sql`data.trainId = ${trainId}`],
            Prisma.sql`${orderClause} LIMIT ${perTrainLimit + 1}`
        )})`);
        return prisma.$queryRaw(Prisma.sql`
            SELECT * FROM (${Prisma.join(perTrainQueries, ' UNION ALL ')}) AS perTrain
            ${limit ? Prisma.sql`ORDER BY startHeartbeatStartedAt ${Prisma.raw(order)} LIMIT ${limit + 1}` : Prisma.empty}
        `);
    }

    const whereClauses: Prisma.Sql[] = [];
    if (trns?.size) {
        whereClauses.push(Prisma.sql`t.trn IN (${Prisma.join(Array.from(trns))})`);
    }
    if (timeFilter?.from) {
        whereClauses.push(Prisma.sql`data.startHeartbeatAt >= ${timeFilter.from}`);
    }
    if (timeFilter?.to) {
        whereClauses.push(Prisma.sql`data.startHeartbeatAt <= ${timeFilter.to}`);
    }
    if (eventTypes?.size) {
        whereClauses.push(Prisma.sql`et.name IN (${Prisma.join(Array.from(eventTypes))})`);
    }
    if (locations?.length) {
        whereClauses.push(Prisma.sql`(${Prisma.join(locations.map(loc => {
            if (loc.platformNumber === undefined) {
                return Prisma.sql`p2.station = ${loc.station}`;
            }
            return Prisma.sql`(p2.station = ${loc.station} AND p2.platformNumber = ${loc.platformNumber})`;
        }), ' OR ')})`);
    }
    const timesWhereClauses = [...whereClauses];
    const geoWhereClauses = [...whereClauses];
    if (destinations?.size) {
        timesWhereClauses.push(Prisma.sql`
        data.firstPlannedDestinationId IN (
            SELECT id FROM Destination WHERE name IN (${Prisma.join(Array.from(destinations))})
        )
        `);
        geoWhereClauses.push(Prisma.sql`d.name IN (${Prisma.join(Array.from(destinations))})`);
    }

    const promises: Promise<any>[] = [];
    if (includeTimes) {
        promises.push(runApiQuery(
            Prisma.sql`
            et.name AS lastEventType,
            p1.raw AS rawLastEventLocation,
            p2.station AS parsedStation,
            p2.platformNumber AS parsedPlatformNumber,
            data.lastEventTime AS lastEventTime,
            (
                SELECT JSON_ARRAYAGG(
                    JSON_OBJECT(
                        'name', d.name,
                        'fromTime', pd.fromTime,
                        'fromPlatform', p3.raw
                    )
                )
                FROM PlannedDestination pd
                JOIN Destination d ON pd.destinationId = d.id
                JOIN UnparsedPlatform p3 ON pd.fromPlatformId = p3.id
                WHERE pd.statusId = data.id
            ) AS plannedDestinations
            `,
            Prisma.sql`
            TimesApiTrainData data
            JOIN Train t ON data.trainId = t.id
            JOIN Heartbeat h1 ON data.startHeartbeatAt = h1.startedAt
            LEFT JOIN Heartbeat h2 ON data.endHeartbeatAt = h2.startedAt
            JOIN TrainEventType et ON data.lastEventTypeId = et.id
            JOIN UnparsedPlatform p1 ON data.lastEventLocationId = p1.id
            LEFT JOIN ParsedPlatform p2 ON p1.parsedPlatformId = p2.id
            `,
            timesWhereClauses,
        ));
    } else {
        promises.push(Promise.resolve());
    }

    if (includeGeo) {
        promises.push(runApiQuery(
            Prisma.sql`
            data.rawLastSeen AS rawLastSeen,
            et.name AS lastEventType,
            p2.station AS parsedStation,
            p2.platformNumber AS parsedPlatformNumber,
            data.lastEventTime AS lastEventTime,
            d.name AS destination
            `,
            Prisma.sql`
            GeoApiTrainData data
            JOIN Train t ON data.trainId = t.id
            JOIN Heartbeat h1 ON data.startHeartbeatAt = h1.startedAt
            LEFT JOIN Heartbeat h2 ON data.endHeartbeatAt = h2.startedAt
            LEFT JOIN TrainEventType et ON data.lastEventTypeId = et.id
            LEFT JOIN ParsedPlatform p2 ON data.lastEventPlatformId = p2.id
            JOIN Destination d ON data.destinationId = d.id
            `,
            geoWhereClauses,
        ));
    }

    let [timesResults, geoResults] = await Promise.all(promises) as [
        {
            trn: string;
            startHeartbeatStartedAt: Date;
            startHeartbeatEndedAt: Date | null;
            endHeartbeatStartedAt: Date | null;
            endHeartbeatEndedAt: Date | null;
            lastEventType: string;
            rawLastEventLocation: string;
            parsedStation: string | null;
            parsedPlatformNumber: number | null;
            lastEventTime: Date;
            plannedDestinations: {
                name: string;
                fromTime: string; // Prisma doesn't know that this is a Date here, so we have to parse it ourselves
                fromPlatform: string;
            }[]
        }[] | void,
        {
            trn: string;
            startHeartbeatStartedAt: Date;
            startHeartbeatEndedAt: Date | null;
            endHeartbeatStartedAt: Date | null;
            endHeartbeatEndedAt: Date | null;
            rawLastSeen: string | null;
            lastEventType: string | null;
            parsedStation: string | null;
            parsedPlatformNumber: number | null;
            lastEventTime: Date | null;
            destination: string;
        }[] | void
    ];

    // --- Truncate results if needed ---

    let truncationTime: Date | null = null;
    if (hasAnyLimit) {
        const truncation = truncate(
            limit,
            limitPerTrn,
            [...(timesResults || []), ...(geoResults || [])]
                .map(row => ({ trn: row.trn, start: row.startHeartbeatStartedAt })),
            order
        );
        if (truncation) {
            truncationTime = truncation.truncationTime;
            if (timesResults) {
                timesResults = timesResults.filter(row => truncation.filterFn(row.startHeartbeatStartedAt));
            }
            if (geoResults) {
                geoResults = geoResults.filter(row => truncation.filterFn(row.startHeartbeatStartedAt));
            }
        }
    }

    // --- Format results ---

    const trains = new Map<string, {
        timesAPI?: TimesTrainHistoryEntry[],
        geoAPI?: GeoTrainHistoryEntry[],
    }>();
    if (timesResults) {
        for (const row of timesResults) {
            if (!trains.has(row.trn)) {
                trains.set(row.trn, {
                    timesAPI: [],
                    geoAPI: includeGeo ? [] : undefined,
                });
            }
            trains.get(row.trn)!.timesAPI!.push({
                startHeartbeat: {
                    startedAt: row.startHeartbeatStartedAt,
                    endedAt: row.startHeartbeatEndedAt
                },
                endHeartbeat: row.endHeartbeatStartedAt ? {
                    startedAt: row.endHeartbeatStartedAt,
                    endedAt: row.endHeartbeatEndedAt
                } : null,
                status: {
                    plannedDestinations: TimesAPI.normalisePlannedDestinations(row.plannedDestinations.map(dest => ({
                        name: dest.name,
                        from: {
                            // Formatted like "2025-04-23 10:45:32.000", in the session's time zone, which is UTC
                            time: new Date(dest.fromTime.replace(' ', 'T') + 'Z'),
                            platformCode: dest.fromPlatform
                        }
                    }))),
                    lastEvent: {
                        location: row.parsedStation !== null ? {
                            station: row.parsedStation,
                            platformNumber: row.parsedPlatformNumber!
                        } : row.rawLastEventLocation,
                        type: row.lastEventType,
                        time: row.lastEventTime
                    }
                }
            });
        }
    }
    if (geoResults) {
        for (const row of geoResults) {
            if (!trains.has(row.trn)) {
                trains.set(row.trn, {
                    timesAPI: includeTimes ? [] : undefined,
                    geoAPI: [],
                });
            }
            if (!trains.get(row.trn)!.geoAPI) {
                trains.get(row.trn)!.geoAPI = [];
            }
            trains.get(row.trn)!.geoAPI!.push({
                startHeartbeat: {
                    startedAt: row.startHeartbeatStartedAt,
                    endedAt: row.startHeartbeatEndedAt
                },
                endHeartbeat: row.endHeartbeatStartedAt ? {
                    startedAt: row.endHeartbeatStartedAt,
                    endedAt: row.endHeartbeatEndedAt
                } : null,
                status: {
                    destination: row.destination,
                    lastSeen: row.parsedStation !== null ? {
                        station: row.parsedStation,
                        platformNumber: row.parsedPlatformNumber!,
                        type: row.lastEventType!,
                        time: row.lastEventTime!
                    } : row.rawLastSeen
                }
            });
        }
    }
    return {
        trains,
        truncatedTo: truncationTime
    }
}

/**
 * Finds the time ranges during which trains were active in an API, by merging each train's contiguous data.
 * Ranges are clipped to the data overlapping the time filter.
 *
 * Only the ranges which could be needed after truncation are returned, i.e. the first `limit + 1` ranges in `order`
 *  (and no more than `limitPerTrn + 1` per train), which is much faster than merging all the data.
 * This relies on a train's data for an API never overlapping, so data is contiguous if it starts when the previous
 *  data ended.
 */
async function findAvailabilityRanges(
    table: "TimesApiTrainData" | "GeoApiTrainData",
    trainIds: number[] | null, // null for all trains
    allTrainIds: number[],
    order: 'asc' | 'desc',
    timeFilter: TimeFilter | undefined,
    limit: number | undefined,
    limitPerTrn: number | undefined,
): Promise<{ trainId: number; start: Date; end: Date | null }[]> {
    if (trainIds && !trainIds.length) return [];
    const T = Prisma.raw(table);
    const from = timeFilter?.from;
    const to = timeFilter?.to;
    const trainClause = trainIds ? Prisma.sql`AND d.trainId IN (${Prisma.join(trainIds)})` : Prisma.empty;
    const toClause = to ? Prisma.sql`AND d.startHeartbeatAt <= ${to}` : Prisma.empty;

    // --- Find where ranges start ---

    // Data starts a range if no data for the same train ended when it started.
    // Written as an anti-join rather than `NOT EXISTS`, since MariaDB would otherwise materialise the whole subquery
    //  instead of doing an index lookup per row.
    function rangeStartsQuery(extraClause: Prisma.Sql, limitClause: Prisma.Sql) {
        return Prisma.sql`
            SELECT d.trainId, d.startHeartbeatAt AS start
            FROM ${T} d
            LEFT JOIN ${T} prev ON prev.endHeartbeatAt = d.startHeartbeatAt AND prev.trainId = d.trainId
            WHERE prev.id IS NULL
            ${from ? Prisma.sql`AND d.startHeartbeatAt >= ${from}` : Prisma.empty}
            ${toClause}
            ${extraClause}
            ORDER BY d.startHeartbeatAt ${Prisma.raw(order)}
            ${limitClause}
        `;
    }

    const startQueries: Promise<{ trainId: number; start: Date }[]>[] = [];
    if (limitPerTrn) {
        // Query each train separately (in one statement) so that each only reads the train's first ranges.
        // A train's ranges beyond the first `limit + 1` would be beyond the first `limit + 1` overall too, so can't be
        //  needed.
        const perTrainLimit = Math.min(limitPerTrn, limit ?? Infinity);
        const trainsToQuery = trainIds ?? allTrainIds;
        if (trainsToQuery.length) {
            startQueries.push(prisma.$queryRaw(Prisma.sql`
                ${Prisma.join(trainsToQuery.map(trainId => Prisma.sql`(${rangeStartsQuery(
                    Prisma.sql`AND d.trainId = ${trainId}`,
                    Prisma.sql`LIMIT ${perTrainLimit + 1}`
                )})`), ' UNION ALL ')}
            `));
        }
    } else {
        // Note that 1 is added to detect truncation
        startQueries.push(prisma.$queryRaw(rangeStartsQuery(
            trainClause,
            limit ? Prisma.sql`LIMIT ${limit + 1}` : Prisma.empty
        )));
    }
    if (from) {
        // Ranges already in progress at `from` are clipped to start with the data which was current at `from`, which is
        //  each train's latest data which started before `from` (see `getDataIdsDuringHeartbeat`)
        startQueries.push(prisma.$queryRaw(Prisma.sql`
            SELECT d.trainId, d.startHeartbeatAt AS start
            FROM ${T} d
            JOIN (
                SELECT trainId, MAX(startHeartbeatAt) AS startHeartbeatAt
                FROM ${T} d
                WHERE d.startHeartbeatAt < ${from} ${trainClause}
                GROUP BY trainId
            ) latest USING (trainId, startHeartbeatAt)
            WHERE (d.endHeartbeatAt IS NULL OR d.endHeartbeatAt >= ${from}) ${toClause}
        `));
    }
    let starts = (await Promise.all(startQueries)).flat();
    if (!starts.length) return [];
    if (limit) {
        // Only the first `limit + 1` ranges can be needed after truncation, so there's no need to find where the rest
        //  end (which would otherwise make the query below unboundedly large when limiting per train)
        starts = starts
            .sort(order === 'asc'
                ? (a, b) => a.start.getTime() - b.start.getTime()
                : (a, b) => b.start.getTime() - a.start.getTime())
            .slice(0, limit + 1);
    }

    // --- Find where each range ends ---

    // A range ends with the first data which is still current, isn't continued by other data, or continues past `to`
    const ends = await prisma.$queryRaw<{ idx: bigint; end: Date | null }[]>(Prisma.join(
        starts.map((range, idx) => Prisma.sql`(
            SELECT ${idx} AS idx, d.endHeartbeatAt AS end
            FROM ${T} d
            LEFT JOIN ${T} next ON next.trainId = d.trainId AND next.startHeartbeatAt = d.endHeartbeatAt
            WHERE d.trainId = ${range.trainId}
              AND d.startHeartbeatAt >= ${range.start}
              ${toClause}
              AND (
                d.endHeartbeatAt IS NULL
                ${to ? Prisma.sql`OR d.endHeartbeatAt > ${to}` : Prisma.empty}
                OR next.id IS NULL
              )
            ORDER BY d.startHeartbeatAt ASC
            LIMIT 1
        )`),
        ' UNION ALL '
    ));
    const endByIdx = new Map(ends.map(row => [Number(row.idx), row.end]));

    return starts
        .map((range, idx) => ({ trainId: range.trainId, start: range.start, end: endByIdx.get(idx) ?? null }))
        .sort((a, b) => a.start.getTime() - b.start.getTime());
}

type TrainApiAvailability = { start: Date; end?: Date }[]
type TrainsAvailability = Map<
    string, // TRN
    Map<ApiType, TrainApiAvailability>
>;
export async function getTrainsAvailability(
    trns: Set<string>,
    apis: Set<TrainDataAPI>,
    timeFilter?: TimeFilter,
    limit?: number,
    limitPerTrn?: number
): Promise<{
    truncatedTo: Date | null;
    trains: TrainsAvailability;
}> {
    const includeTimes = !apis.size || apis.has('TIMES');
    const includeGeo = !apis.size || apis.has('GEO');
    const hasAnyLimit = !!(limitPerTrn || limit);
    const order = timeFilter?.from ? 'asc' : 'desc';

    const trainRows = await prisma.train.findMany({
        select: { id: true, trn: true },
        where: trns.size ? { trn: { in: Array.from(trns) } } : undefined,
        orderBy: { id: 'asc' }
    });
    const trainIdToTrn = new Map(trainRows.map(train => [train.id, train.trn]));

    const [timesRanges, geoRanges] = await Promise.all([
        includeTimes
            ? findAvailabilityRanges("TimesApiTrainData", trns.size ? [...trainIdToTrn.keys()] : null, [...trainIdToTrn.keys()], order, timeFilter, limit, limitPerTrn)
            : [],
        includeGeo
            ? findAvailabilityRanges("GeoApiTrainData", trns.size ? [...trainIdToTrn.keys()] : null, [...trainIdToTrn.keys()], order, timeFilter, limit, limitPerTrn)
            : [],
    ]);

    const trains: TrainsAvailability = new Map();
    for (const [ranges, apiName] of [
        [timesRanges, ApiType.TIMES],
        [geoRanges, ApiType.GEO]
    ] as const) {
        for (const range of ranges) {
            const trn = trainIdToTrn.get(range.trainId)!;
            if (!trains.has(trn)) {
                trains.set(trn, new Map());
            }
            const apiMap = trains.get(trn)!;
            if (!apiMap.has(apiName)) {
                apiMap.set(apiName, []);
            }
            apiMap.get(apiName)!.push({ start: range.start, end: range.end ?? undefined });
        }
    }

    let truncationTime: Date | null = null;
    if (hasAnyLimit) {
        const truncation = truncate(
            limit,
            limitPerTrn,
            [...trains].flatMap(([trn, apiMap]) =>
                [...apiMap.values()].flat().map(entry => ({ trn, start: entry.start }))
            ),
            order
        );
        if (truncation) {
            truncationTime = truncation.truncationTime;
            for (const [trn, apiMap] of trains.entries()) {
                for (const [api, availabilities] of apiMap.entries()) {
                    const filtered = availabilities.filter(entry => truncation.filterFn(entry.start));
                    if (filtered.length > 0) {
                        apiMap.set(api, filtered);
                    } else {
                        apiMap.delete(api);
                    }
                }
                if (apiMap.size === 0) {
                    trains.delete(trn);
                }
            }
        }
    }

    return {
        trains,
        truncatedTo: truncationTime
    };
}

// --- Times API ---

const selectTimesTrainData = {
    plannedDestinations: { select: {
        destination: { select: {
            name: true
        } },
        fromTime: true,
        fromPlatform: true
    } },
    lastEventLocation: { select: {
        raw: true,
        parsedPlatform: { select: {
            station: true,
            platformNumber: true
        } }
    } },
    lastEventType: { select: {
        name: true
    } },
    lastEventTime: true,
} as const satisfies TimesApiTrainDataSelect;

type TimesTrainData = Prisma.TimesApiTrainDataGetPayload<{ select: typeof selectTimesTrainData }>;

type TimesTrainHistoryEntry = TrainHistoryEntry<Omit<TimesAPI.ParsedTrain, 'nextPlatforms'>>;

function formatTimesData(data?: TimesTrainData): Omit<TimesAPI.ParsedTrain, 'nextPlatforms'> {
    if (data) return {
        // The database doesn't return planned destinations in any particular order
        plannedDestinations: TimesAPI.normalisePlannedDestinations(data.plannedDestinations.map(dest => ({
            name: dest.destination.name,
            from: {
                time: dest.fromTime,
                platformCode: dest.fromPlatform.raw
            }
        }))),
        lastEvent: {
            location: data.lastEventLocation.parsedPlatform ? {
                station: data.lastEventLocation.parsedPlatform.station,
                platformNumber: data.lastEventLocation.parsedPlatform.platformNumber
            } : data.lastEventLocation.raw,
            type: data.lastEventType.name,
            time: data.lastEventTime
        }
    };
}

/**
 * Identifies the significant Times API data, so that it is only stored again if this changes.
 * The times at which destinations are planned from aren't included, since they are predictions which change constantly,
 *  and neither is the platform which the first destination is planned from.
 */
export function timesDataKey(data: Omit<TimesAPI.ParsedTrain, 'nextPlatforms'>): string {
    const { location, type, time } = data.lastEvent;
    return JSON.stringify([
        typeof location === 'string' ? location : TimesAPI.formatLastEventLocation(location),
        type,
        time.getTime(),
        data.plannedDestinations[0]?.name,
        data.plannedDestinations.slice(1).map(d => [d.name, d.from.platformCode])
    ]);
}

// --- Geo API ---

const selectGeoTrainData = {
    destination: { select: {
        name: true
    } },
    rawLastSeen: true,
    lastEventPlatform: { select: {
        station: true,
        platformNumber: true
    } },
    lastEventType: { select: {
        name: true
    } },
    lastEventTime: true,
} as const satisfies GeoApiTrainDataSelect;

type GeoTrainData = Prisma.GeoApiTrainDataGetPayload<{ select: typeof selectGeoTrainData }>;

type GeoTrainHistoryEntry = TrainHistoryEntry<GeoAPI.TrainStatus>;

function formatGeoData(data?: GeoTrainData): GeoAPI.TrainStatus {
    if (data) return {
        destination: data.destination.name,
        lastSeen: data.lastEventPlatform ? {
            station: data.lastEventPlatform.station,
            platformNumber: data.lastEventPlatform.platformNumber,
            type: data.lastEventType.name,
            time: data.lastEventTime
        } : data.rawLastSeen
    };
}

/** Identifies the Geo API data, so that it is only stored again if this changes */
export function geoDataKey(data: GeoAPI.TrainStatus): string {
    const { lastSeen } = data;
    return JSON.stringify([
        data.destination,
        typeof lastSeen === 'string' ? lastSeen : [lastSeen.type, lastSeen.station, lastSeen.platformNumber, lastSeen.time.getTime()]
    ]);
}

// --- Diagnostics ---

export async function addHeartbeatError(heartbeatStartedAt: Date, api: ApiType, message: string): Promise<void> {
    eventEmitter.emit("heartbeat-error", {
        api,
        message,
        heartbeat: { startedAt: heartbeatStartedAt, endedAt: null }
    } satisfies HeartbeatError);
    await prisma.heartbeatError.create({
        data: {
            heartbeatAt: heartbeatStartedAt,
            api,
            message
        },
        // Prisma forces us to select *something* for some reason, but we don't actually need the result
        select: { heartbeatAt: true }
    }).catch(e => {
        // Failing to save diagnostics shouldn't stop the live data from updating
        console.error("Failed to save heartbeat error:", e);
    });
}

export async function addHeartbeatWarning(heartbeatStartedAt: Date, api: ApiType, data: InputJsonValue): Promise<void> {
    eventEmitter.emit("heartbeat-warning", {
        api,
        // Prisma accepts some values which aren't JSON (e.g., anything with `toJSON`), but they're the same once
        //  they're sent, since stream messages are converted to JSON too
        data: data as JsonValue,
        heartbeat: { startedAt: heartbeatStartedAt, endedAt: null }
    } satisfies HeartbeatWarning);
    await prisma.heartbeatWarning.create({
        data: {
            heartbeatAt: heartbeatStartedAt,
            api,
            data,
        },
        // Prisma forces us to select *something* for some reason, but we don't actually need the result
        select: { heartbeatAt: true }
    }).catch(e => {
        // Failing to save diagnostics shouldn't stop the live data from updating
        console.error("Failed to save heartbeat warning:", e);
    });
}

export async function getHeartbeatErrors(timeFilter?: TimeFilter, apis?: ApiType[]): Promise<HeartbeatError[]> {
    return prisma.heartbeatError.findMany({
        select: {
            api: true,
            message: true,
            heartbeat: {
                select: {
                    startedAt: true,
                    endedAt: true
                }
            }
        },
        where: {
            heartbeat: timeFilter?.toHeartbeatFilter(),
            api: apis && apis.length > 0 ? { in: apis } : undefined,
        },
        orderBy: {
            heartbeat: {
                startedAt: 'desc'
            }
        }
    });
}

export async function getHeartbeatWarnings(timeFilter?: TimeFilter, apis?: ApiType[]): Promise<HeartbeatWarning[]> {
    return prisma.heartbeatWarning.findMany({
        select: {
            api: true,
            data: true,
            heartbeat: {
                select: {
                    startedAt: true,
                    endedAt: true
                }
            }
        },
        where: {
            heartbeat: timeFilter?.toHeartbeatFilter(),
            api: apis && apis.length > 0 ? { in: apis } : undefined,
        },
        orderBy: {
            heartbeat: {
                startedAt: 'desc'
            }
        }
    });
}

// --- Snapshots ---

export type MatchStrategy = 'before' | 'after' | 'exact' | 'nearest';

/**
 * Finds the start time of the heartbeat matching the given time and strategy.
 * Heartbeats never overlap, so the only heartbeat which could be in progress at a given time is the latest one which
 *  started before it.
 */
async function findHeartbeat(time: Date, matchStrategy: MatchStrategy): Promise<Date | null> {
    const select = { startedAt: true, endedAt: true } as const;

    if (matchStrategy === 'nearest') {
        // A heartbeat's time is considered to be its end (or its start if it hasn't ended). Since heartbeats don't
        //  overlap, the nearest is one of the two latest heartbeats which started before `time` or the first after it.
        const [before, after] = await Promise.all([
            prisma.heartbeat.findMany({
                select,
                where: { startedAt: { lte: time } },
                orderBy: { startedAt: 'desc' },
                take: 2
            }),
            prisma.heartbeat.findMany({
                select,
                where: { startedAt: { gt: time } },
                orderBy: { startedAt: 'asc' },
                take: 1
            }),
        ]);
        function distance(heartbeat: HeartbeatTimes) {
            return Math.abs((heartbeat.endedAt ?? heartbeat.startedAt).getTime() - time.getTime());
        }
        const candidates = [...before, ...after].sort((a, b) => distance(a) - distance(b));
        return candidates[0]?.startedAt ?? null;
    }

    const latest = await prisma.heartbeat.findFirst({
        select,
        where: { startedAt: { lte: time } },
        orderBy: { startedAt: 'desc' }
    });

    const latestInProgress = latest?.endedAt && latest.endedAt >= time;
    switch (matchStrategy) {
        case 'before':
            return latest?.startedAt ?? null;
        case 'exact':
            return latestInProgress ? latest.startedAt : null;
        case 'after': {
            if (latestInProgress) return latest.startedAt;
            const next = await prisma.heartbeat.findFirst({
                select,
                where: { startedAt: { gt: time }, endedAt: { not: null } },
                orderBy: { startedAt: 'asc' }
            });
            return next?.startedAt ?? null;
        }
    }
}

/**
 * Finds the IDs of the data which was current during a heartbeat.
 *
 * Checking `startHeartbeatAt <= heartbeat < endHeartbeatAt` directly can't use an index efficiently, so is very slow.
 * Instead, this relies on a train's data for an API never overlapping, so the data current during a heartbeat can only
 *  be the train's latest data which started at or before the heartbeat.
 * The `GROUP BY` allows MariaDB to find that using a single lookup per train in the `(trainId, startHeartbeatAt)` index.
 */
async function getDataIdsDuringHeartbeat(
    table: "TimesApiTrainData" | "GeoApiTrainData",
    heartbeatStartedAt: Date
): Promise<number[]> {
    const rows = await prisma.$queryRaw<{ id: number }[]>`
        SELECT data.id
        FROM ${Prisma.raw(table)} data
        JOIN (
            SELECT trainId, MAX(startHeartbeatAt) AS startHeartbeatAt
            FROM ${Prisma.raw(table)}
            WHERE startHeartbeatAt <= ${heartbeatStartedAt}
            GROUP BY trainId
        ) latest USING (trainId, startHeartbeatAt)
        WHERE data.endHeartbeatAt IS NULL OR data.endHeartbeatAt > ${heartbeatStartedAt}
    `;
    return rows.map(row => row.id);
}

export async function getSnapshot(
    time: Date,
    matchStrategy: MatchStrategy,
    // Snapshots always include every API's data
    { trns, eventTypes, locations, destinations }: Omit<TrainFilters, 'apis'> = {},
): Promise<null | {
    heartbeat: HeartbeatTimes;
    timesApiTrains: Map<string, Omit<TimesAPI.ParsedTrain, 'nextPlatforms'>>;
    geoApiTrains: Map<string, GeoAPI.TrainStatus>;
    statusLastChanged: Map<string, HeartbeatTimes>;
    errors: Omit<HeartbeatError, 'heartbeat'>[];
    warnings: Omit<HeartbeatWarning, 'heartbeat'>[];
}> {
    const trainFilter = trns && trns.size > 0 ? { trn: { in: Array.from(trns) } } : undefined;
    const eventTypeFilter = eventTypes && eventTypes.size > 0 ? { name: { in: Array.from(eventTypes) } } : undefined;
    const locationFilter = locations && locations.length > 0 ? { OR: locations } : undefined;
    const destinationFilter = destinations && destinations.size > 0 ? { name: { in: Array.from(destinations) } } : undefined;

    const heartbeatSelect = {
        startedAt: true,
        endedAt: true,
        errors: { select: {
            api: true,
            message: true
        } },
        warnings: { select: {
            api: true,
            data: true
        } }
    } satisfies HeartbeatSelect;

    const heartbeatStartedAt = await findHeartbeat(time, matchStrategy);
    if (!heartbeatStartedAt) return null;

    const [heartbeat, timesApiIds, geoApiIds] = await Promise.all([
        prisma.heartbeat.findUnique({
            where: { startedAt: heartbeatStartedAt },
            select: heartbeatSelect
        }),
        getDataIdsDuringHeartbeat("TimesApiTrainData", heartbeatStartedAt),
        getDataIdsDuringHeartbeat("GeoApiTrainData", heartbeatStartedAt),
    ]);
    if (!heartbeat) return null;
    const [timesApiData,geoApiData] = await Promise.all([
        prisma.timesApiTrainData.findMany({
            select: {
                train: { select: { trn: true } },
                ...selectTimesTrainData
            },
            where: {
                id: { in: timesApiIds },
                train: trainFilter,
                lastEventType: eventTypeFilter,
                lastEventLocation: {
                    parsedPlatform: locationFilter
                },
                firstPlannedDestination: destinationFilter
            }
        }),
        prisma.geoApiTrainData.findMany({
            select: {
                train: { select: { trn: true } },
                ...selectGeoTrainData
            },
            where: {
                id: { in: geoApiIds },
                train: trainFilter,
                lastEventType: eventTypeFilter,
                lastEventPlatform: locationFilter,
                destination: destinationFilter
            }
        })
    ]);
    const statusLastChanged = await getLastStatusChanges(
        [...new Set([...timesApiData, ...geoApiData].map(data => data.train.trn))],
        heartbeatStartedAt
    );

    return {
        heartbeat: {
            startedAt: heartbeat.startedAt,
            endedAt: heartbeat.endedAt
        },
        timesApiTrains: new Map(timesApiData.map(data => [
            data.train.trn,
            formatTimesData(data)
        ])),
        geoApiTrains: new Map(geoApiData.map(data => [
            data.train.trn,
            formatGeoData(data)
        ])),
        statusLastChanged,
        errors: heartbeat.errors,
        warnings: heartbeat.warnings,
    };
}
