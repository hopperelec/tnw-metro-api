import {and, asc, Column, desc, eq, gt, gte, inArray, is, isNull, lt, lte, max, or, type SQL, sql, type SQLWrapper, Subquery} from "drizzle-orm";
import {alias, type MySqlColumn, type MySqlSelect, type SubqueryWithSelection, unionAll} from "drizzle-orm/mysql-core";
import type {SelectResultField} from "drizzle-orm/query-builders/select.types";
import {SelectionProxyHandler} from "drizzle-orm/selection-proxy";
import {db} from "./db";
import {
    ApiType,
    destination,
    geoApiTrainData,
    heartbeat,
    heartbeatError,
    heartbeatWarning,
    parsedPlatform,
    plannedDestination,
    timesApiTrainData,
    train,
    trainEventType,
    unparsedPlatform,
} from "./db/schema";
import {TimesAPI} from "./parsing/rti";
import {GeoAPI} from "./parsing/rti";
import type {GeoApiData} from "./parsing/rti/geo-api";
import type {HeartbeatError, HeartbeatTimes, HeartbeatWarning} from "./heartbeat";
import TimeFilter from "./time-filter";
import type {JsonValue, Platform, TrainDataAPI, TrainFilters} from "./types";
import {eventEmitter} from "./events";

// --- Query helpers ---

type TrainDataTable = typeof timesApiTrainData | typeof geoApiTrainData;

type Order = 'asc' | 'desc';

/** Orders by the column in the given direction */
function ordered(column: Parameters<typeof asc>[0], order: Order): SQL {
    return order === 'asc' ? asc(column) : desc(column);
}

/** Aliases each field as its key, so that the fields can be selected from a subquery (such as a union) */
function aliasFields<T extends Record<string, Column | SQL>>(fields: T) {
    return Object.fromEntries(Object.entries(fields).map(([key, field]) => [
        key,
        (is(field, Column) ? sql`${field}`.mapWith(field) : field).as(key)
    ])) as { [K in keyof T]: SQL.Aliased<SelectResultField<T[K]>> };
}

/** A select query, which can be used as a subquery */
interface AnySelect extends SQLWrapper {
    _: { selectedFields: Record<string, unknown> };
    as(alias: string): unknown
}

/** A select query which returns `TRow`s, and can be ordered and limited */
interface OrderableSelect<TRow> extends AnySelect, PromiseLike<TRow[]> {
    orderBy(...columns: SQL[]): { limit(limit: number): unknown };
}

/**
 * Combines queries using `UNION ALL`, as a subquery.
 * Unlike Drizzle's `unionAll`, this doesn't nest each query in another level of parentheses,
 *  since MariaDB doesn't allow more than 63 levels of nesting, which a query per train would exceed.
 * The queries' fields must be aliased (see `aliasFields`).
 */
function unionAllAs<TQuery extends AnySelect>(queries: TQuery[], alias: string): ReturnType<TQuery["as"]> {
    // Built the same way as Drizzle's subqueries (see `MySqlSelect.as`), but with the union as the SQL.
    // Drizzle already wraps each query in parentheses when it's embedded in SQL.
    return new Proxy(
        new Subquery(sql.join(queries, sql` UNION ALL `), queries[0]._.selectedFields, alias),
        new SelectionProxyHandler({ alias, sqlAliasedBehavior: "alias", sqlBehavior: "error" })
    ) as ReturnType<TQuery["as"]>;
}

/**
 * Each train's latest data which started during the heartbeats matching the condition, as a subquery to join with.
 * The `GROUP BY` allows MariaDB to find this using a single lookup per train in the `(trainId, startHeartbeatAt)` index.
 */
function latestDataPerTrain(data: TrainDataTable, startedDuring: SQL | undefined) {
    return db.select({ trainId: data.trainId, startHeartbeatAt: max(data.startHeartbeatAt).as("startHeartbeatAt") })
        .from(data)
        .where(startedDuring)
        .groupBy(data.trainId)
        .as("latest");
}

function joinLatest(data: TrainDataTable, latest: ReturnType<typeof latestDataPerTrain>) {
    return and(eq(latest.trainId, data.trainId), eq(latest.startHeartbeatAt, data.startHeartbeatAt));
}

// --- Heartbeat Lifecycle ---

export async function startHeartbeat(startedAt: Date): Promise<void> {
    await db.insert(heartbeat).values({ startedAt });
}

export async function endHeartbeat(startedAt: Date, endedAt: Date): Promise<void> {
    const [{ affectedRows }] = await db.update(heartbeat).set({ endedAt }).where(eq(heartbeat.startedAt, startedAt));
    if (!affectedRows) throw new Error(`Heartbeat ${startedAt.toISOString()} doesn't exist`);
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
        selectTimesData({ id: timesApiTrainData.id }).where(isNull(timesApiTrainData.endHeartbeatAt)),
        selectGeoData({ id: geoApiTrainData.id }).where(isNull(geoApiTrainData.endHeartbeatAt)),
    ]);
    return {
        times: new Map(times.map(row => [row.trn, { id: row.id, key: timesDataKey(formatTimesData(row)) }])),
        geo: new Map(geo.map(row => [row.trn, { id: row.id, key: geoDataKey(formatGeoData(row)) }])),
    };
}

/** Loads the state needed to add new data, which must be done before the first heartbeat */
export async function loadHistoryState(): Promise<void> {
    const [eventTypes, trains, parsedPlatforms, unparsedPlatforms, destinations, currentData] = await Promise.all([
        db.select().from(trainEventType),
        db.select().from(train),
        db.select().from(parsedPlatform),
        db.select({ id: unparsedPlatform.id, raw: unparsedPlatform.raw }).from(unparsedPlatform),
        db.select().from(destination),
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

async function lookupId(known: Map<string, number>, key: string, insert: () => Promise<{ id: number }[]>): Promise<number> {
    let id = known.get(key);
    if (id === undefined) {
        [{ id }] = await insert();
        known.set(key, id);
    }
    return id;
}

function trainId(trn: string): Promise<number> {
    return lookupId(knownTrains, trn, () =>
        db.insert(train).values({ trn }).$returningId()
    );
}

function eventTypeId(name: string): Promise<number> {
    return lookupId(knownEventTypes, name, () =>
        db.insert(trainEventType).values({ name }).$returningId()
    );
}

function destinationId(name: string): Promise<number> {
    return lookupId(knownDestinations, name, () =>
        db.insert(destination).values({ name }).$returningId()
    );
}

function parsedPlatformId({ station, platformNumber }: Platform): Promise<number> {
    return lookupId(knownParsedPlatforms, `${station}|${platformNumber}`, () =>
        db.insert(parsedPlatform).values({ station, platformNumber }).$returningId()
    );
}

function unparsedPlatformId(raw: string, parsed: Platform | undefined): Promise<number> {
    return lookupId(knownUnparsedPlatforms, raw, async () =>
        db.insert(unparsedPlatform).values({
            raw,
            parsedPlatformId: parsed ? await parsedPlatformId(parsed) : null
        }).$returningId()
    );
}

/// --- Trains ---

interface NewTimesData {
    data: typeof timesApiTrainData.$inferInsert;
    plannedDestinations: Omit<typeof plannedDestination.$inferInsert, 'statusId'>[];
}

async function timesDataRow(trn: string, data: Omit<TimesAPI.ParsedTrain, 'nextPlatforms'>, heartbeatStartedAt: Date): Promise<NewTimesData> {
    const { location } = data.lastEvent;
    const plannedDestinations: NewTimesData['plannedDestinations'] = [];
    for (const destination of data.plannedDestinations) {
        plannedDestinations.push({
            destinationId: await destinationId(destination.name),
            fromPlatformId: await unparsedPlatformId(destination.from.platformCode, TimesAPI.parsePlatformCode(destination.from.platformCode)),
            fromTime: destination.from.time,
        });
    }
    return {
        data: {
            trainId: await trainId(trn),
            startHeartbeatAt: heartbeatStartedAt,
            lastEventLocationId: typeof location === 'string'
                ? await unparsedPlatformId(location, undefined)
                : await unparsedPlatformId(TimesAPI.formatLastEventLocation(location), location),
            lastEventTypeId: await eventTypeId(data.lastEvent.type),
            lastEventTime: data.lastEvent.time,
            firstPlannedDestinationId: plannedDestinations[0]?.destinationId ?? null,
        },
        plannedDestinations,
    };
}

async function geoDataRow(trn: string, data: GeoAPI.TrainStatus, heartbeatStartedAt: Date): Promise<typeof geoApiTrainData.$inferInsert> {
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

    const timesRows: NewTimesData[] = [];
    for (const { trn, data } of timesChanges.added) {
        timesRows.push(await timesDataRow(trn, data, heartbeatStartedAt));
    }
    const geoRows: typeof geoApiTrainData.$inferInsert[] = [];
    for (const { trn, data } of geoChanges.added) {
        geoRows.push(await geoDataRow(trn, data, heartbeatStartedAt));
    }

    const [timesIds, geoIds] = await db.transaction(async tx => {
        if (timesChanges.ended.length) {
            await tx.update(timesApiTrainData)
                .set({ endHeartbeatAt: heartbeatStartedAt })
                .where(inArray(timesApiTrainData.id, timesChanges.ended.map(trn => currentTimesData.get(trn)!.id)));
        }
        if (geoChanges.ended.length) {
            await tx.update(geoApiTrainData)
                .set({ endHeartbeatAt: heartbeatStartedAt })
                .where(inArray(geoApiTrainData.id, geoChanges.ended.map(trn => currentGeoData.get(trn)!.id)));
        }

        // Only a few trains' data changes each heartbeat, so each is simply inserted separately
        const timesIds: number[] = [];
        const plannedDestinations: typeof plannedDestination.$inferInsert[] = [];
        for (const row of timesRows) {
            const [{ id }] = await tx.insert(timesApiTrainData).values(row.data).$returningId();
            timesIds.push(id);
            plannedDestinations.push(...row.plannedDestinations.map(destination => ({ ...destination, statusId: id })));
        }
        if (plannedDestinations.length) {
            await tx.insert(plannedDestination).values(plannedDestinations);
        }

        const geoIds: number[] = [];
        for (const row of geoRows) {
            const [{ id }] = await tx.insert(geoApiTrainData).values(row).$returningId();
            geoIds.push(id);
        }
        return [timesIds, geoIds];
    });
    applyChanges(currentTimesData, timesChanges, timesIds);
    applyChanges(currentGeoData, geoChanges, geoIds);
}

/** The TRNs of all trains which have any history, which are all trains since they're only added when data is */
export async function getTrnsWithHistory(): Promise<string[]> {
    const trains = await db.select({ trn: train.trn }).from(train).orderBy(asc(train.trn));
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
    function changes(data: TrainDataTable) {
        const latest = latestDataPerTrain(data, at ? lte(data.startHeartbeatAt, at) : undefined);
        const changedAt = at
            ? sql`IF(${lte(data.endHeartbeatAt, at)}, ${data.endHeartbeatAt}, ${data.startHeartbeatAt})`
            : sql`COALESCE(${data.endHeartbeatAt}, ${data.startHeartbeatAt})`;
        return db.select({
            trainId: data.trainId,
            changedAt: changedAt.mapWith(data.startHeartbeatAt).as("changedAt")
        }).from(data)
            .innerJoin(latest, joinLatest(data, latest));
    }

    const allChanges = unionAll(changes(timesApiTrainData), changes(geoApiTrainData)).as("changes");

    const lastChange = db.select({
        trainId: allChanges.trainId,
        changedAt: max(allChanges.changedAt).as("changedAt")
    }).from(allChanges)
        .groupBy(allChanges.trainId)
        .as("lastChange");

    const rows = await db.select({
        trn: train.trn,
        startedAt: heartbeat.startedAt,
        endedAt: heartbeat.endedAt
    }).from(lastChange)
        .innerJoin(train, eq(train.id, lastChange.trainId))
        .innerJoin(heartbeat, eq(heartbeat.startedAt, lastChange.changedAt))
        .where(inArray(train.trn, trns));

    return new Map(rows.map(row => [row.trn, { startedAt: row.startedAt, endedAt: row.endedAt }]));
}

// Returns filter function
function truncate(
    limit: number | undefined,
    limitPerTrn: number | undefined,
    entries: Iterable<{ trn: string; start: Date }>,
    order: Order
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

const dataStartHeartbeat = alias(heartbeat, "startHeartbeat");
const dataEndHeartbeat = alias(heartbeat, "endHeartbeat");

/** The heartbeats during which data started and ended, which must be joined using `joinHeartbeats` */
const heartbeatFields = aliasFields({
    startHeartbeatStartedAt: dataStartHeartbeat.startedAt,
    startHeartbeatEndedAt: dataStartHeartbeat.endedAt,
    endHeartbeatStartedAt: dataEndHeartbeat.startedAt,
    endHeartbeatEndedAt: dataEndHeartbeat.endedAt,
});

function joinHeartbeats<TQuery extends MySqlSelect>(query: TQuery, data: TrainDataTable) {
    return query
        .innerJoin(dataStartHeartbeat, eq(dataStartHeartbeat.startedAt, data.startHeartbeatAt))
        .leftJoin(dataEndHeartbeat, eq(dataEndHeartbeat.startedAt, data.endHeartbeatAt));
}

/** The IDs of the data to select, as selected by a subquery */
type SelectedIds = SubqueryWithSelection<{ id: SQL.Aliased<number> }, "selectedIds">;

/** Restricts the query to the data with the selected IDs, if there are any */
function joinSelectedIds<TQuery extends MySqlSelect>(query: TQuery, data: TrainDataTable, selectedIds?: SelectedIds) {
    // The query's fields are selected explicitly, so joining another table doesn't change its results
    return selectedIds ? query.innerJoin(selectedIds, eq(selectedIds.id, data.id)) as unknown as TQuery : query;
}

function formatHeartbeats(row: SelectResultField<typeof heartbeatFields>): Omit<TrainHistoryEntry<unknown>, 'status'> {
    return {
        startHeartbeat: {
            startedAt: row.startHeartbeatStartedAt,
            endedAt: row.startHeartbeatEndedAt
        },
        endHeartbeat: row.endHeartbeatStartedAt ? {
            startedAt: row.endHeartbeatStartedAt,
            endedAt: row.endHeartbeatEndedAt
        } : null,
    };
}

/** Filters which apply to both APIs' data. These require the tables joined by `selectTimesData`/`selectGeoData`. */
function trainDataFilters(
    data: TrainDataTable,
    { trns, eventTypes, locations }: Omit<TrainFilters, 'apis' | 'destinations'>,
    timeFilter?: TimeFilter
): (SQL | undefined)[] {
    return [
        trns?.size ? inArray(train.trn, Array.from(trns)) : undefined,
        timeFilter?.from ? gte(data.startHeartbeatAt, timeFilter.from) : undefined,
        timeFilter?.to ? lte(data.startHeartbeatAt, timeFilter.to) : undefined,
        eventTypes?.size ? inArray(trainEventType.name, Array.from(eventTypes)) : undefined,
        locations?.length ? or(...locations.map(loc =>
            and(
                eq(parsedPlatform.station, loc.station),
                loc.platformNumber !== undefined ? eq(parsedPlatform.platformNumber, loc.platformNumber) : undefined
            )
        )) : undefined,
    ];
}

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
    const order: Order = timeFilter?.from ? 'asc' : 'desc';

    // --- Fetch potentially matching data rows ---

    // When limiting per train, each train's rows are found separately (in one statement) so that the
    //  `(trainId, startHeartbeatAt)` index can be used to only read the first rows for each train.
    const perTrainIds = limitPerTrn
        ? (await db.select({ id: train.id })
            .from(train)
            .where(trns?.size ? inArray(train.trn, Array.from(trns)) : undefined)
        ).map(train => train.id)
        : [];
    // A train's rows beyond the first `limit + 1` would be beyond the first `limit + 1` overall too, so can't be needed
    const perTrainLimit = Math.min(limitPerTrn, limit ?? Infinity);

    // Note that 1 is added to limits to detect truncation
    async function runApiQuery<TRow>(
        data: TrainDataTable,
        filter: SQL | undefined,
        selectData: (selectedIds?: SelectedIds) => OrderableSelect<TRow> & { where(filter: SQL | undefined): OrderableSelect<TRow> },
        selectIds: () => OrderableSelect<{ id: number }> & { where(filter: SQL | undefined): OrderableSelect<{ id: number }> },
    ): Promise<TRow[]> {
        const limited = <TQuery extends OrderableSelect<unknown>>(query: TQuery, n: number) =>
            query.orderBy(ordered(data.startHeartbeatAt, order)).limit(n) as TQuery;
        if (!limitPerTrn) {
            const query = selectData().where(filter);
            return limit ? limited(query, limit + 1) : query;
        }
        if (!perTrainIds.length) {
            return [];
        }
        // Only each train's first rows' IDs are found separately, and the rest of the data is then selected for just
        //  those rows. Selecting all the data for each train separately would make the statement much larger, which
        //  takes MariaDB much longer to plan.
        const selectedIds = unionAllAs(perTrainIds.map(trainId =>
            limited(selectIds().where(and(filter, eq(data.trainId, trainId))), perTrainLimit + 1)
        ), "selectedIds") as SelectedIds;
        const query = selectData(selectedIds);
        // Without an overall limit, trains are ordered by TRN, as they were when each train's data was selected
        //  separately (in the order the TRN index returned them)
        return limit
            ? limited(query, limit + 1)
            : query.orderBy(asc(train.trn), ordered(data.startHeartbeatAt, order)) as unknown as Promise<TRow[]>;
    }

    const [timesResults, geoResults] = await Promise.all([
        includeTimes
            ? runApiQuery(
                timesApiTrainData,
                and(
                    ...trainDataFilters(timesApiTrainData, { trns, eventTypes, locations }, timeFilter),
                    destinations?.size ? timesDestinationFilter(destinations) : undefined,
                ),
                selectedIds => joinSelectedIds(joinHeartbeats(selectTimesData(heartbeatFields), timesApiTrainData), timesApiTrainData, selectedIds),
                () => joinTimesTables(db.select(aliasFields({ id: timesApiTrainData.id })).from(timesApiTrainData).$dynamic()),
            )
            : undefined,
        includeGeo
            ? runApiQuery(
                geoApiTrainData,
                and(
                    ...trainDataFilters(geoApiTrainData, { trns, eventTypes, locations }, timeFilter),
                    destinations?.size ? inArray(destination.name, Array.from(destinations)) : undefined,
                ),
                selectedIds => joinSelectedIds(joinHeartbeats(selectGeoData(heartbeatFields), geoApiTrainData), geoApiTrainData, selectedIds),
                () => joinGeoTables(db.select(aliasFields({ id: geoApiTrainData.id })).from(geoApiTrainData).$dynamic()),
            )
            : undefined,
    ]);

    // --- Truncate results if needed ---

    let truncation: ReturnType<typeof truncate> = null;
    if (hasAnyLimit) {
        truncation = truncate(
            limit,
            limitPerTrn,
            [...(timesResults ?? []), ...(geoResults ?? [])]
                .map(row => ({ trn: row.trn, start: row.startHeartbeatStartedAt })),
            order
        );
    }
    const isIncluded = (row: { startHeartbeatStartedAt: Date }) => !truncation || truncation.filterFn(row.startHeartbeatStartedAt);

    // --- Format results ---

    const trains = new Map<string, {
        timesAPI?: TimesTrainHistoryEntry[],
        geoAPI?: GeoTrainHistoryEntry[],
    }>();
    for (const row of (timesResults ?? []).filter(isIncluded)) {
        if (!trains.has(row.trn)) {
            trains.set(row.trn, {
                timesAPI: [],
                geoAPI: includeGeo ? [] : undefined,
            });
        }
        trains.get(row.trn)!.timesAPI!.push({ ...formatHeartbeats(row), status: formatTimesData(row) });
    }
    for (const row of (geoResults ?? []).filter(isIncluded)) {
        if (!trains.has(row.trn)) {
            trains.set(row.trn, {
                timesAPI: includeTimes ? [] : undefined,
                geoAPI: [],
            });
        }
        trains.get(row.trn)!.geoAPI ??= [];
        trains.get(row.trn)!.geoAPI!.push({ ...formatHeartbeats(row), status: formatGeoData(row) });
    }
    return {
        trains,
        truncatedTo: truncation?.truncationTime ?? null
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
    table: TrainDataTable,
    trainIds: number[] | null, // null for all trains
    allTrainIds: number[],
    order: Order,
    timeFilter: TimeFilter | undefined,
    limit: number | undefined,
    limitPerTrn: number | undefined,
): Promise<{ trainId: number; start: Date; end: Date | null }[]> {
    if (trainIds && !trainIds.length) return [];
    const from = timeFilter?.from;
    const to = timeFilter?.to;
    const trainFilter = trainIds ? inArray(table.trainId, trainIds) : undefined;
    const startedByTo = to ? lte(table.startHeartbeatAt, to) : undefined;
    const rangeFields = aliasFields({ trainId: table.trainId, start: table.startHeartbeatAt });

    // --- Find where ranges start ---

    // Data starts a range if no data for the same train ended when it started.
    // Written as an anti-join rather than `NOT EXISTS`, since MariaDB would otherwise materialise the whole subquery
    //  instead of doing an index lookup per row.
    const prev = alias(table, "prev");
    function rangeStartsQuery(extraFilter: SQL | undefined, rangeLimit: number | undefined) {
        const query = db.select(rangeFields)
            .from(table)
            .leftJoin(prev, and(eq(prev.endHeartbeatAt, table.startHeartbeatAt), eq(prev.trainId, table.trainId)))
            .where(and(
                isNull(prev.id),
                from ? gte(table.startHeartbeatAt, from) : undefined,
                startedByTo,
                extraFilter
            ))
            .orderBy(ordered(table.startHeartbeatAt, order))
            .$dynamic();
        return rangeLimit ? query.limit(rangeLimit) : query;
    }

    const startQueries: Promise<{ trainId: number; start: Date }[]>[] = [];
    if (limitPerTrn) {
        // Query each train separately (in one statement) so that each only reads the train's first ranges.
        // A train's ranges beyond the first `limit + 1` would be beyond the first `limit + 1` overall too, so can't be
        //  needed.
        const perTrainLimit = Math.min(limitPerTrn, limit ?? Infinity);
        const trainsToQuery = trainIds ?? allTrainIds;
        if (trainsToQuery.length) {
            startQueries.push(db.select().from(unionAllAs(trainsToQuery.map(trainId =>
                rangeStartsQuery(eq(table.trainId, trainId), perTrainLimit + 1)
            ), "starts")));
        }
    } else {
        // Note that 1 is added to detect truncation
        startQueries.push(rangeStartsQuery(trainFilter, limit ? limit + 1 : undefined));
    }
    if (from) {
        // Ranges already in progress at `from` are clipped to start with the data which was current at `from`, which is
        //  each train's latest data which started before `from` (see `getDataIdsDuringHeartbeat`)
        const latest = latestDataPerTrain(table, and(lt(table.startHeartbeatAt, from), trainFilter));
        startQueries.push(db.select(rangeFields)
            .from(table)
            .innerJoin(latest, joinLatest(table, latest))
            .where(and(or(isNull(table.endHeartbeatAt), gte(table.endHeartbeatAt, from)), startedByTo)));
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
    const next = alias(table, "next");
    const ends = await db.select().from(unionAllAs(starts.map((range, idx) => db
        .select(aliasFields({ idx: sql<number>`${idx}`.mapWith(Number), end: table.endHeartbeatAt }))
        .from(table)
        .leftJoin(next, and(eq(next.trainId, table.trainId), eq(next.startHeartbeatAt, table.endHeartbeatAt)))
        .where(and(
            eq(table.trainId, range.trainId),
            gte(table.startHeartbeatAt, range.start),
            startedByTo,
            or(
                isNull(table.endHeartbeatAt),
                to ? gt(table.endHeartbeatAt, to) : undefined,
                isNull(next.id)
            )
        ))
        .orderBy(asc(table.startHeartbeatAt))
        .limit(1)
        .$dynamic()
    ), "ends"));
    const endByIdx = new Map(ends.map(row => [row.idx, row.end]));

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
    const order: Order = timeFilter?.from ? 'asc' : 'desc';

    const trainRows = await db.select({ id: train.id, trn: train.trn })
        .from(train)
        .where(trns.size ? inArray(train.trn, Array.from(trns)) : undefined)
        .orderBy(asc(train.id));
    const trainIdToTrn = new Map(trainRows.map(train => [train.id, train.trn]));

    const [timesRanges, geoRanges] = await Promise.all([
        includeTimes
            ? findAvailabilityRanges(timesApiTrainData, trns.size ? [...trainIdToTrn.keys()] : null, [...trainIdToTrn.keys()], order, timeFilter, limit, limitPerTrn)
            : [],
        includeGeo
            ? findAvailabilityRanges(geoApiTrainData, trns.size ? [...trainIdToTrn.keys()] : null, [...trainIdToTrn.keys()], order, timeFilter, limit, limitPerTrn)
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

const fromPlatform = alias(unparsedPlatform, "fromPlatform");

/**
 * Selects Times API data, along with the given fields. Every field is aliased, so these can be selected from subqueries.
 * The planned destinations are aggregated into JSON, since MariaDB doesn't support the lateral joins which Drizzle would
 *  use to select them as a relation.
 */
function selectTimesData<TFields extends Record<string, MySqlColumn | SQL | SQL.Aliased>>(fields: TFields) {
    const plannedDestinations = db
        .select({
            plannedDestinations: sql`JSON_ARRAYAGG(JSON_OBJECT(
                'name', ${destination.name},
                'fromTime', ${plannedDestination.fromTime},
                'fromPlatform', ${fromPlatform.raw}
            ))`
        })
        .from(plannedDestination)
        .innerJoin(destination, eq(destination.id, plannedDestination.destinationId))
        .innerJoin(fromPlatform, eq(fromPlatform.id, plannedDestination.fromPlatformId))
        .where(eq(plannedDestination.statusId, timesApiTrainData.id));
    return joinTimesTables(db
        .select({
            ...aliasFields({
                trn: train.trn,
                lastEventType: trainEventType.name,
                rawLastEventLocation: unparsedPlatform.raw,
                parsedStation: parsedPlatform.station,
                parsedPlatformNumber: parsedPlatform.platformNumber,
                lastEventTime: timesApiTrainData.lastEventTime,
                plannedDestinations: sql<{
                    name: string;
                    fromTime: string;
                    fromPlatform: string
                }[]>`${plannedDestinations}`.mapWith(
                    plannedDestinations =>
                        plannedDestinations.map(dest => ({
                            name: dest.name,
                            from: {
                                // Formatted like "2025-04-23 10:45:32.000", in the session's time zone, which is UTC
                                time: new Date(dest.fromTime.replace(' ', 'T') + 'Z'),
                                platformCode: dest.fromPlatform
                            }
                        }))
                ),
            }),
            ...fields,
        })
        .from(timesApiTrainData)
        .$dynamic());
}

/** Joins the tables which Times API data's fields and filters (see `trainDataFilters`) use */
function joinTimesTables<TQuery extends MySqlSelect>(query: TQuery) {
    return query
        .innerJoin(train, eq(train.id, timesApiTrainData.trainId))
        .innerJoin(trainEventType, eq(trainEventType.id, timesApiTrainData.lastEventTypeId))
        .innerJoin(unparsedPlatform, eq(unparsedPlatform.id, timesApiTrainData.lastEventLocationId))
        .leftJoin(parsedPlatform, eq(parsedPlatform.id, unparsedPlatform.parsedPlatformId));
}

/** Filters Times API data to the data whose first planned destination is one of the given destinations */
function timesDestinationFilter(destinations: Set<string>): SQL {
    return inArray(
        timesApiTrainData.firstPlannedDestinationId,
        db.select({ id: destination.id }).from(destination).where(inArray(destination.name, Array.from(destinations)))
    );
}

type TimesTrainData = Awaited<ReturnType<typeof selectTimesData<{}>>>[number];

type TimesTrainHistoryEntry = TrainHistoryEntry<Omit<TimesAPI.ParsedTrain, 'nextPlatforms'>>;

function formatTimesData(data: TimesTrainData): Omit<TimesAPI.ParsedTrain, 'nextPlatforms'> {
    return {
        // The database doesn't return planned destinations in any particular order
        plannedDestinations: TimesAPI.normalisePlannedDestinations(data.plannedDestinations),
        lastEvent: {
            location: data.parsedStation !== null ? {
                station: data.parsedStation,
                platformNumber: data.parsedPlatformNumber
            } : data.rawLastEventLocation,
            type: data.lastEventType,
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

/** Selects Geo API data, along with the given fields. Every field is aliased, so these can be selected from subqueries. */
function selectGeoData<TFields extends Record<string, MySqlColumn | SQL | SQL.Aliased>>(fields: TFields) {
    return joinGeoTables(db
        .select({
            ...aliasFields({
                trn: train.trn,
                destination: destination.name,
                rawLastSeen: geoApiTrainData.rawLastSeen,
                lastEventType: trainEventType.name,
                parsedStation: parsedPlatform.station,
                parsedPlatformNumber: parsedPlatform.platformNumber,
                lastEventTime: geoApiTrainData.lastEventTime,
            }),
            ...fields,
        })
        .from(geoApiTrainData)
        .$dynamic());
}

/** Joins the tables which Geo API data's fields and filters (see `trainDataFilters`) use */
function joinGeoTables<TQuery extends MySqlSelect>(query: TQuery) {
    return query
        .innerJoin(train, eq(train.id, geoApiTrainData.trainId))
        .innerJoin(destination, eq(destination.id, geoApiTrainData.destinationId))
        .leftJoin(trainEventType, eq(trainEventType.id, geoApiTrainData.lastEventTypeId))
        .leftJoin(parsedPlatform, eq(parsedPlatform.id, geoApiTrainData.lastEventPlatformId));
}

type GeoTrainData = Awaited<ReturnType<typeof selectGeoData<{}>>>[number];

type GeoTrainHistoryEntry = TrainHistoryEntry<GeoAPI.TrainStatus>;

function formatGeoData(data: GeoTrainData): GeoAPI.TrainStatus {
    return {
        destination: data.destination,
        lastSeen: data.parsedStation !== null ? {
            station: data.parsedStation,
            platformNumber: data.parsedPlatformNumber,
            type: data.lastEventType,
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
    await db.insert(heartbeatError).values({
        heartbeatAt: heartbeatStartedAt,
        api,
        message
    }).catch(e => {
        // Failing to save diagnostics shouldn't stop the live data from updating
        console.error("Failed to save heartbeat error:", e);
    });
}

export async function addHeartbeatWarning(heartbeatStartedAt: Date, api: ApiType, data: JsonValue): Promise<void> {
    eventEmitter.emit("heartbeat-warning", {
        api,
        data,
        heartbeat: { startedAt: heartbeatStartedAt, endedAt: null }
    } satisfies HeartbeatWarning);
    await db.insert(heartbeatWarning).values({
        heartbeatAt: heartbeatStartedAt,
        api,
        data,
    }).catch(e => {
        // Failing to save diagnostics shouldn't stop the live data from updating
        console.error("Failed to save heartbeat warning:", e);
    });
}

const heartbeatTimesFields = { startedAt: heartbeat.startedAt, endedAt: heartbeat.endedAt };

export async function getHeartbeatErrors(timeFilter?: TimeFilter, apis?: ApiType[]): Promise<HeartbeatError[]> {
    return db.select({ api: heartbeatError.api, message: heartbeatError.message, heartbeat: heartbeatTimesFields })
        .from(heartbeatError)
        .innerJoin(heartbeat, eq(heartbeat.startedAt, heartbeatError.heartbeatAt))
        .where(and(
            timeFilter?.toHeartbeatFilter(),
            apis?.length ? inArray(heartbeatError.api, apis) : undefined
        ))
        .orderBy(desc(heartbeat.startedAt));
}

export async function getHeartbeatWarnings(timeFilter?: TimeFilter, apis?: ApiType[]): Promise<HeartbeatWarning[]> {
    return db.select({ api: heartbeatWarning.api, data: heartbeatWarning.data, heartbeat: heartbeatTimesFields })
        .from(heartbeatWarning)
        .innerJoin(heartbeat, eq(heartbeat.startedAt, heartbeatWarning.heartbeatAt))
        .where(and(
            timeFilter?.toHeartbeatFilter(),
            apis?.length ? inArray(heartbeatWarning.api, apis) : undefined
        ))
        .orderBy(desc(heartbeat.startedAt));
}

// --- Snapshots ---

export type MatchStrategy = 'before' | 'after' | 'exact' | 'nearest';

/**
 * Finds the start time of the heartbeat matching the given time and strategy.
 * Heartbeats never overlap, so the only heartbeat which could be in progress at a given time is the latest one which
 *  started before it.
 */
async function findHeartbeat(time: Date, matchStrategy: MatchStrategy): Promise<Date | null> {
    if (matchStrategy === 'nearest') {
        // A heartbeat's time is considered to be its end (or its start if it hasn't ended). Since heartbeats don't
        //  overlap, the nearest is one of the two latest heartbeats which started before `time` or the first after it.
        const [before, after] = await Promise.all([
            db.query.heartbeat.findMany({
                where: { startedAt: { lte: time } },
                orderBy: { startedAt: 'desc' },
                limit: 2
            }),
            db.query.heartbeat.findMany({
                where: { startedAt: { gt: time } },
                orderBy: { startedAt: 'asc' },
                limit: 1
            }),
        ]);
        function distance(heartbeat: HeartbeatTimes) {
            return Math.abs((heartbeat.endedAt ?? heartbeat.startedAt).getTime() - time.getTime());
        }
        const candidates = [...before, ...after].sort((a, b) => distance(a) - distance(b));
        return candidates[0]?.startedAt ?? null;
    }

    const latest = await db.query.heartbeat.findFirst({
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
            const next = await db.query.heartbeat.findFirst({
                where: { startedAt: { gt: time }, endedAt: { isNotNull: true } },
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
 */
async function getDataIdsDuringHeartbeat(data: TrainDataTable, heartbeatStartedAt: Date): Promise<number[]> {
    const latest = latestDataPerTrain(data, lte(data.startHeartbeatAt, heartbeatStartedAt));
    const rows = await db.select({ id: data.id })
        .from(data)
        .innerJoin(latest, joinLatest(data, latest))
        .where(or(isNull(data.endHeartbeatAt), gt(data.endHeartbeatAt, heartbeatStartedAt)));
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
    const heartbeatStartedAt = await findHeartbeat(time, matchStrategy);
    if (!heartbeatStartedAt) return null;

    const [heartbeatTimes, errors, warnings, timesApiIds, geoApiIds] = await Promise.all([
        db.query.heartbeat.findFirst({ where: { startedAt: { eq: heartbeatStartedAt } } }),
        db.select({ api: heartbeatError.api, message: heartbeatError.message })
            .from(heartbeatError)
            .where(eq(heartbeatError.heartbeatAt, heartbeatStartedAt))
            .orderBy(asc(heartbeatError.id)),
        db.select({ api: heartbeatWarning.api, data: heartbeatWarning.data })
            .from(heartbeatWarning)
            .where(eq(heartbeatWarning.heartbeatAt, heartbeatStartedAt))
            .orderBy(asc(heartbeatWarning.id)),
        getDataIdsDuringHeartbeat(timesApiTrainData, heartbeatStartedAt),
        getDataIdsDuringHeartbeat(geoApiTrainData, heartbeatStartedAt),
    ]);
    if (!heartbeatTimes) return null;

    const [timesApiData, geoApiData] = await Promise.all([
        selectTimesData({}).where(and(
            inArray(timesApiTrainData.id, timesApiIds),
            ...trainDataFilters(timesApiTrainData, { trns, eventTypes, locations }),
            destinations?.size ? timesDestinationFilter(destinations) : undefined
        )),
        selectGeoData({}).where(and(
            inArray(geoApiTrainData.id, geoApiIds),
            ...trainDataFilters(geoApiTrainData, { trns, eventTypes, locations }),
            destinations?.size ? inArray(destination.name, Array.from(destinations)) : undefined
        )),
    ]);
    const statusLastChanged = await getLastStatusChanges(
        [...new Set([...timesApiData, ...geoApiData].map(data => data.trn))],
        heartbeatStartedAt
    );

    return {
        heartbeat: heartbeatTimes,
        timesApiTrains: new Map(timesApiData.map(data => [data.trn, formatTimesData(data)])),
        geoApiTrains: new Map(geoApiData.map(data => [data.trn, formatGeoData(data)])),
        statusLastChanged,
        errors,
        warnings,
    };
}
