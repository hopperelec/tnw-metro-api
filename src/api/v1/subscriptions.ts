import {randomBytes} from "node:crypto";
import {ServerResponse} from "http";
import {SseClient} from "../sse";
import {eventEmitter} from "../../events";
import {ApiType} from "../../../generated/prisma/enums";
import {CollatedTrain, ParsedLocation, TrainDataAPI, TrainFilters} from "../../types";
import {LOCATION_ABBREVIATIONS} from "../../constants";
import {
    MAX_SUBSCRIPTION_FILTER_VALUES,
    MAX_SUBSCRIPTION_TOKENS,
    MAX_SUBSCRIPTION_TOKENS_PER_IP,
    MAX_STREAMS_PER_TOKEN,
    MAX_SUBSCRIPTIONS_PER_TOKEN,
    SUBSCRIPTION_TOKEN_EXPIRY
} from "./limits";
import {DueTimes, getDueTimes, getStationDueTimes, normaliseStationCode, stationIncludes} from "../../due-times";
import {getActiveTrains, getLastHeartbeatTimes, HeartbeatEnd, HeartbeatError, HeartbeatTimes, HeartbeatWarning} from "../../heartbeat";
import {changedApis, filterApis, matchesStatusFilters, parseLocations, setCovers, trainFiltersCover} from "./train-filters";
import {parsePlatformCode, PLATFORM_CODE_REGEX} from "../../parsing/rti/times-api";
import {convertContainers, SourceContainer} from "../props";

export const SUBSCRIPTION_TOPICS = [
    'station-due-times',
    'platform-due-times',
    'trains',
    'heartbeat-errors',
    'heartbeat-warnings',
    'heartbeats'
] as const;
export type SubscriptionTopic = typeof SUBSCRIPTION_TOPICS[number];

/** The name of the SSE event for each topic's messages */
const TOPIC_EVENTS: Record<SubscriptionTopic, string> = {
    'station-due-times': 'station-due-times',
    'platform-due-times': 'platform-due-times',
    'trains': 'train',
    'heartbeat-errors': 'heartbeat-error',
    'heartbeat-warnings': 'heartbeat-warning',
    'heartbeats': 'heartbeat-end',
};

type Subscription =
    | { topic: 'station-due-times'; station: string }
    | { topic: 'platform-due-times'; platform: string }
    | {
        topic: 'trains';
        trns?: string[];
        apis?: TrainDataAPI[];
        eventTypes?: string[];
        locations?: string[];
        destinations?: string[];
    }
    | { topic: 'heartbeat-errors' | 'heartbeat-warnings'; apis?: ApiType[] }
    | { topic: 'heartbeats' };

type SubscriptionResponse = { id: string } & Subscription;

export type SubscriptionRequest = { id?: string } & Subscription;

/** When thrown from a route handler, Fastify sends it as an error response with the status code */
export class SubscriptionError extends Error {
    constructor(public readonly statusCode: number, message: string) {
        super(message);
    }
}

// --- Parsing subscriptions ---

/** A subscription to one of the topics, along with its filters parsed for matching */
type ParsedSubscription<
    WithId extends boolean = boolean,
    T extends SubscriptionTopic = SubscriptionTopic
> = {
    subscription: (WithId extends true ? SubscriptionResponse : SubscriptionRequest) & { topic: T }
} & (
    T extends 'trains' ? TrainFilters :
    T extends 'heartbeat-errors' | 'heartbeat-warnings' ? { apis?: Set<ApiType> } :
    {}
)

/** Narrows a parsed subscription by its topic, since TypeScript can't narrow it using `subscription.topic` */
function isTopic<WithId extends boolean, T extends SubscriptionTopic>(
    parsed: ParsedSubscription<WithId>, ...topics: T[]
): parsed is ParsedSubscription<WithId, T> {
    return (topics as SubscriptionTopic[]).includes(parsed.subscription.topic);
}

function setSubscriptionId<T extends SubscriptionTopic>(
    parsed: ParsedSubscription<boolean, T>,
    id: string
): asserts parsed is ParsedSubscription<true, T> {
    parsed.subscription.id = id;
}

const SUBSCRIPTION_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

const TOPIC_PROPERTIES: Record<SubscriptionTopic, string[]> = {
    'station-due-times': ['station'],
    'platform-due-times': ['platform'],
    'trains': ['trns', 'apis', 'eventTypes', 'locations', 'destinations'],
    'heartbeat-errors': ['apis'],
    'heartbeat-warnings': ['apis'],
    'heartbeats': [],
};

function normaliseFilter<T extends string>(values?: T[]): T[] | undefined {
    if (values?.length) return [...new Set(values)].sort();
}

function parseStation(value: string, name: string): string {
    const stationCode = normaliseStationCode(value);
    if (!(stationCode in LOCATION_ABBREVIATIONS)) throw new SubscriptionError(400, `${name} is not a recognised station code`);
    return stationCode;
}

/** Parses and normalises a subscription from a request */
function parseSubscription(request: SubscriptionRequest, name: string): ParsedSubscription {
    // The endpoints' schema allows unknown properties, since Fastify's validator would otherwise silently remove them
    for (const property of Object.keys(request)) {
        if (![
            'id',
            'topic',
            ...TOPIC_PROPERTIES[request.topic]
        ].includes(property)) {
            throw new SubscriptionError(400, `${name}.${property} isn't a property of ${request.topic} subscriptions`);
        }
    }

    switch (request.topic) {
        case 'station-due-times':
            return {
                subscription: {
                    ...request,
                    station: parseStation(request.station, `${name}.station`)
                }
            };
        case 'platform-due-times': {
            if (!PLATFORM_CODE_REGEX.test(request.platform)) {
                throw new SubscriptionError(400, `${name}.platform must be a platform code, e.g., "MTW;3"`);
            }
            const [stationCode, platformNumber] = request.platform.split(';');
            const station = parseStation(stationCode, `${name}.platform's station`);
            return {
                subscription: {
                    ...request,
                    platform: `${station};${platformNumber}`
                }
            };
        }
        case 'trains': {
            const subscription: SubscriptionRequest & { topic: 'trains' } = {
                ...request,
                trns: normaliseFilter(request.trns),
                apis: normaliseFilter(request.apis),
                eventTypes: normaliseFilter(request.eventTypes),
                locations: normaliseFilter(request.locations),
                destinations: normaliseFilter(request.destinations),
            };

            const numFilterValues = TOPIC_PROPERTIES.trains.reduce(
                (total, property) => total + (subscription[property]?.length ?? 0),
                0
            );
            if (numFilterValues > MAX_SUBSCRIPTION_FILTER_VALUES) {
                throw new SubscriptionError(400, `${name} has more than ${MAX_SUBSCRIPTION_FILTER_VALUES} filter values`);
            }

            let locations: ParsedLocation[] | undefined;
            try {
                locations = subscription.locations && parseLocations(subscription.locations);
            } catch (e) {
                throw new SubscriptionError(400, `${name}.locations: ${e.message}`);
            }

            return {
                subscription,
                trns: subscription.trns && new Set(subscription.trns),
                apis: subscription.apis && new Set(subscription.apis),
                eventTypes: subscription.eventTypes && new Set(subscription.eventTypes),
                locations,
                destinations: subscription.destinations && new Set(subscription.destinations),
            };
        }
        case 'heartbeat-errors':
        case 'heartbeat-warnings': {
            const apis = normaliseFilter(request.apis);
            return {
                subscription: { ...request, apis },
                apis: apis && new Set(apis)
            };
        }
        case 'heartbeats':
            return { subscription: request };
    }
}

/** Whether every message which subscription `b` would cause would also be caused by subscription `a` */
function covers(a: ParsedSubscription, b: ParsedSubscription): boolean {
    if (isTopic(a, 'station-due-times')) {
        if (isTopic(b, 'station-due-times')) {
            return stationIncludes(a.subscription.station, b.subscription.station);
        }
        if (isTopic(b, 'platform-due-times')) {
            return stationIncludes(a.subscription.station, parsePlatformCode(b.subscription.platform)!.station);
        }
        return false;
    }
    if (isTopic(a, 'platform-due-times')) {
        return isTopic(b, 'platform-due-times') && a.subscription.platform === b.subscription.platform;
    }
    if (isTopic(a, 'trains')) {
        return isTopic(b, 'trains') && trainFiltersCover(a, b);
    }
    if (isTopic(a, 'heartbeat-errors', 'heartbeat-warnings')) {
        return isTopic(b, a.subscription.topic) && setCovers(a.apis, b.apis);
    }
    return isTopic(b, 'heartbeats');
}

// --- Tokens ---

interface Stream {
    sse: SseClient;
    includeSubscriptionIds: boolean;
}

interface BaseSubscriptionToken {
    /** The token itself, to identify it in logs */
    value: string;
    ip: string;
    subscriptions: Map<string, ParsedSubscription<true>>;
    /** Used to generate IDs for subscriptions which weren't given one */
    nextId: number;
}

interface ConnectedSubscriptionToken extends BaseSubscriptionToken {
    /** Connected streams, in the order they connected */
    streams: [Stream, ...Stream[]];
    expiresAt?: never;
}

interface UnconnectedSubscriptionToken extends BaseSubscriptionToken {
    streams: Stream[] & { length: 0 };
    /** When the token will be deleted if no streams are connected first */
    expiresAt: number;
}

type SubscriptionToken = ConnectedSubscriptionToken | UnconnectedSubscriptionToken;

function isConnected(token: SubscriptionToken): token is ConnectedSubscriptionToken {
    return token.streams.length > 0;
}

const tokens = new Map<string, SubscriptionToken>();

/** Logs activity for a token, for debugging */
function log(token: SubscriptionToken, message: string): void {
    console.log(`[SUBSCRIPTIONS] ${token.value} (${token.ip}): ${message}`);
}

/** Returns a human-readable description of the subscriptions, for logging */
function describeSubscriptions(subscriptions: Iterable<ParsedSubscription<true>>): string {
    return [...subscriptions].map(({ subscription: { id, topic, ...parameters } }) =>
        `${id} (${topic} ${JSON.stringify(parameters)})`
    ).join(', ');
}

// Handle expired tokens every minute
setInterval(() => {
    const now = Date.now();
    for (const [token, subscriptionToken] of tokens) {
        if (isConnected(subscriptionToken) || subscriptionToken.expiresAt > now) continue;
        tokens.delete(token);
        log(subscriptionToken, `Expired (${tokens.size} tokens remaining)`);
    }
}, 60 * 1000).unref();

function getToken(token: string): SubscriptionToken {
    const subscriptionToken = tokens.get(token);
    if (!subscriptionToken) {
        throw new SubscriptionError(404, "Subscription token not found. It may have expired, so create a new one.");
    }
    // Using the token resets its expiry
    if (!isConnected(subscriptionToken)) subscriptionToken.expiresAt = Date.now() + SUBSCRIPTION_TOKEN_EXPIRY;
    return subscriptionToken;
}

function getSubscriptions(token: SubscriptionToken): SubscriptionResponse[] {
    return [...token.subscriptions.values()].map(({ subscription }) => subscription);
}

/**
 * Adds subscriptions to a token, replacing those which they cover or which have the same ID.
 * Either all the subscriptions are added, or an error is thrown and none of them are.
 * Returns the subscriptions which were added, and the IDs of those which were replaced because they're covered by new ones.
 */
function addSubscriptions(token: SubscriptionToken, requests: SubscriptionRequest[]): {
    added: ParsedSubscription<true>[],
    replaced: string[]
} {
    const requestedIds = new Set<string>();
    for (const [i, { id }] of requests.entries()) {
        if (id === undefined) continue;
        if (!SUBSCRIPTION_ID_REGEX.test(id)) {
            throw new SubscriptionError(400, `Subscription IDs must be 1-64 letters, digits, hyphens or underscores, but subscriptions[${i}].id is "${id}"`);
        }
        if (requestedIds.has(id)) throw new SubscriptionError(400, `subscriptions[${i}].id "${id}" is used more than once`);
        requestedIds.add(id);
    }

    const oldSubscriptions = token.subscriptions;
    const newSubscriptions = new Map(oldSubscriptions);
    let nextId = token.nextId;
    const replaced = new Set<string>();
    const added: ParsedSubscription<true>[] = [];
    for (const [i, request] of requests.entries()) {
        const parsed = parseSubscription(request, `subscriptions[${i}]`);

        let id = request.id;
        if (id === undefined) {
            // Find an unused ID for the subscription.
            do {
                id = String(nextId++);
            } while (oldSubscriptions.has(id) || requestedIds.has(id));
        } else {
            // A subscription with the same ID is replaced, which isn't reported as it being replaced by being covered
            newSubscriptions.delete(id);
            replaced.delete(id);
        }
        setSubscriptionId(parsed, id);

        for (const [existingId, existing] of newSubscriptions) {
            // Subscriptions from this request are referred to by their index, since their ID may have been generated
            const existingIndex = added.indexOf(existing);
            // Check that the new subscription isn't covered by an existing one
            if (covers(existing, parsed)) {
                throw new SubscriptionError(
                    400,
                    `subscriptions[${i}] is redundant, since it is covered by ` +
                    (existingIndex === -1 ? `subscription "${existingId}"` : `subscriptions[${existingIndex}]`)
                );
            }
            if (covers(parsed, existing)) {
                // A request can't include both a subscription and one which covers it, regardless of their order
                if (existingIndex !== -1) {
                    throw new SubscriptionError(
                        400,
                        `subscriptions[${existingIndex}] is redundant, since it is covered by subscriptions[${i}]`
                    );
                }
                // Remove any existing subscriptions which are covered by the new one
                newSubscriptions.delete(existingId);
                replaced.add(existingId);
            }
        }

        newSubscriptions.set(id, parsed);
        added.push(parsed);
    }
    if (newSubscriptions.size > MAX_SUBSCRIPTIONS_PER_TOKEN) {
        throw new SubscriptionError(400, `These subscriptions would total to ${newSubscriptions.size}, which exceeds the maximum of ${MAX_SUBSCRIPTIONS_PER_TOKEN}`);
    }

    token.subscriptions = newSubscriptions;
    token.nextId = nextId;

    // Send the current due times for new subscriptions, like when connecting
    sendCurrentDueTimes(token, added);

    return { added, replaced: [...replaced] };
}

/** Returns a human-readable description of the subscriptions which were added and replaced, for logging */
function describeChange(added: ParsedSubscription<true>[], replaced: string[]): string {
    return `Subscribed to ${describeSubscriptions(added)}` + (replaced.length ? `, replacing ${replaced.join(', ')}` : '');
}

export function createToken(ip: string, requests: SubscriptionRequest[]): {
    token: string,
    subscriptions: SubscriptionResponse[],
    replaced: string[]
} {
    if (tokens.size >= MAX_SUBSCRIPTION_TOKENS) {
        console.warn(`[SUBSCRIPTIONS] Rejected token for ${ip}, since the maximum number of tokens has been reached`);
        throw new SubscriptionError(503, "The maximum number of subscription tokens has been reached. Try again later.");
    }

    const numTokensForIp = [...tokens.values()].filter(token => token.ip === ip).length;
    if (numTokensForIp >= MAX_SUBSCRIPTION_TOKENS_PER_IP) {
        console.log(`[SUBSCRIPTIONS] Rejected token for ${ip}, since it already has ${numTokensForIp} tokens`);
        throw new SubscriptionError(
            429,
            `You have reached the maximum number of subscription tokens for your IP address (${MAX_SUBSCRIPTION_TOKENS_PER_IP}). ` +
            "Delete unused tokens, or wait for them to expire."
        );
    }

    const token = randomBytes(18).toString('base64url');
    const subscriptionToken: SubscriptionToken = {
        value: token,
        ip,
        subscriptions: new Map(),
        nextId: 1,
        streams: [],
        expiresAt: Date.now() + SUBSCRIPTION_TOKEN_EXPIRY
    };
    const { added, replaced } = addSubscriptions(subscriptionToken, requests);
    tokens.set(token, subscriptionToken);

    log(subscriptionToken, `Created (${tokens.size} tokens). ${describeChange(added, replaced)}`);
    return {
        token,
        subscriptions: getSubscriptions(subscriptionToken),
        replaced
    };
}

export function listSubscriptions(token: string): {
    subscriptions: SubscriptionResponse[],
    streams: number,
    expiresAt: Date | null
} {
    const subscriptionToken = getToken(token);
    return {
        subscriptions: getSubscriptions(subscriptionToken),
        streams: subscriptionToken.streams.length,
        expiresAt: isConnected(subscriptionToken) ? null : new Date(subscriptionToken.expiresAt)
    };
}

export function subscribe(token: string, requests: SubscriptionRequest[]): {
    subscriptions: SubscriptionResponse[],
    replaced: string[]
} {
    const subscriptionToken = getToken(token);
    const { added, replaced } = addSubscriptions(subscriptionToken, requests);
    log(subscriptionToken, describeChange(added, replaced));
    return {
        subscriptions: getSubscriptions(subscriptionToken),
        replaced
    };
}

export function unsubscribe(token: string, id: string): void {
    const subscriptionToken = getToken(token);
    if (!subscriptionToken.subscriptions.delete(id)) throw new SubscriptionError(404, "Subscription not found");
    log(subscriptionToken, `Unsubscribed from ${id}`);
}

export function deleteToken(token: string): void {
    const subscriptionToken = getToken(token);
    for (const stream of subscriptionToken.streams) {
        closeStream(subscriptionToken, stream, 'deleted');
    }
    subscriptionToken.streams = []; // So that the streams' disconnect handlers ignore them
    tokens.delete(token);
    log(subscriptionToken, `Deleted (${tokens.size} tokens remaining)`);
}

// --- Streams ---

function closeStream(token: SubscriptionToken, stream: Stream, reason: 'replaced' | 'deleted'): void {
    stream.sse.sendEvent('stream-closed', { reason });
    stream.sse.close();
    log(token, `Closed stream (${reason})`);
}

/**
 * Connects a stream for a token, closing its oldest streams if it would have more than the maximum.
 * Returns a function to call when the stream disconnects.
 */
export function connectStream(token: string, response: ServerResponse, includeSubscriptionIds: boolean): () => void {
    const subscriptionToken = getToken(token);
    // Close the oldest streams if the token would have more than the maximum
    while (subscriptionToken.streams.length >= MAX_STREAMS_PER_TOKEN) {
        closeStream(subscriptionToken, subscriptionToken.streams.shift()!, 'replaced');
    }

    const stream: Stream = {
        sse: new SseClient(response),
        includeSubscriptionIds
    };
    subscriptionToken.streams.push(stream);
    delete subscriptionToken.expiresAt;
    log(subscriptionToken, `Connected stream (${subscriptionToken.streams.length} connected). ` +
        `Subscribed to ${describeSubscriptions(subscriptionToken.subscriptions.values())}`);

    sendCurrentDueTimes(subscriptionToken, subscriptionToken.subscriptions.values(), [stream]);

    return () => {
        // The stream may have already been removed, if it was replaced or the token was deleted
        const index = subscriptionToken.streams.indexOf(stream);
        if (index === -1) return;

        stream.sse.close();
        subscriptionToken.streams.splice(index, 1);
        if (!subscriptionToken.streams.length) subscriptionToken.expiresAt = Date.now() + SUBSCRIPTION_TOKEN_EXPIRY;
        log(subscriptionToken, `Stream disconnected (${subscriptionToken.streams.length} connected)`);
    };
}

function send(
    token: SubscriptionToken,
    topic: SubscriptionTopic,
    payload: SourceContainer,
    subscriptionIds: string[],
    streams = token.streams
): void {
    const event = TOPIC_EVENTS[topic];
    for (const stream of streams) {
        stream.sse.sendEvent(event, convertContainers(
            stream.includeSubscriptionIds ? { ...payload, subscriptionIds } : payload
        ));
    }
}

function sendDueTimes(
    token: SubscriptionToken,
    subscriptions: Iterable<ParsedSubscription<true>>,
    dueTimes: DueTimes,
    trains: Map<string, CollatedTrain>,
    heartbeat: HeartbeatTimes,
    streams = token.streams
) {
    for (const { subscription } of subscriptions) {
        let payload: SourceContainer;
        if (subscription.topic === 'station-due-times') {
            const stationDueTimes = getStationDueTimes(dueTimes, subscription.station);
            if (!stationDueTimes) continue;
            payload = {
                station: subscription.station,
                heartbeat,
                dueTimes: stationDueTimes.map(train => ({ ...train, status: filterApis(trains.get(train.trn)) ?? null }))
            };
        } else if (subscription.topic === 'platform-due-times') {
            const platformDueTimes = dueTimes.get(subscription.platform);
            if (!platformDueTimes) continue;
            payload = {
                platform: subscription.platform,
                heartbeat,
                dueTimes: platformDueTimes.map(train => ({ ...train, status: filterApis(trains.get(train.trn)) ?? null }))
            };
        } else continue;
        send(token, subscription.topic, payload, [subscription.id], streams);
    }
}

function sendCurrentDueTimes(
    token: SubscriptionToken,
    subscriptions: Iterable<ParsedSubscription<true>>,
    streams = token.streams
) {
    if (!streams.length) return;
    const dueTimes = getDueTimes();
    if (dueTimes) sendDueTimes(token, subscriptions, dueTimes, getActiveTrains(), getLastHeartbeatTimes(), streams);
}

/** The trains whose data changed, along with which APIs' data changed */
function getTrainChanges(
    previousTrains: Map<string, CollatedTrain>,
    currentTrains: Map<string, CollatedTrain>
): Map<string, TrainDataAPI[]> {
    const changes = new Map<string, TrainDataAPI[]>();
    for (const trn of new Set([...previousTrains.keys(), ...currentTrains.keys()])) {
        const apis = changedApis(previousTrains.get(trn), currentTrains.get(trn));
        if (apis.length) changes.set(trn, apis);
    }
    return changes;
}

/** Whether a train's change in status matches a `trains` subscription's filters, using the same rules as the history endpoints' filters */
function trainChangeMatches(
    trn: string,
    apis: TrainDataAPI[],
    filters: TrainFilters,
    previousTrains: Map<string, CollatedTrain>,
    currentTrains: Map<string, CollatedTrain>
): boolean {
    if (filters.trns && !filters.trns.has(trn)) return false;
    if (filters.apis && !apis.some(api => filters.apis!.has(api))) return false;

    const currentTrain = filterApis(currentTrains.get(trn), filters.apis);
    if (currentTrain) return matchesStatusFilters(currentTrain, filters);

    // The train has become inactive (as far as the subscription is concerned)
    const previousTrain = filterApis(previousTrains.get(trn), filters.apis);
    return previousTrain !== undefined && matchesStatusFilters(previousTrain, filters);
}

function sendTrainChanges(
    token: SubscriptionToken,
    trainsSubscriptions: ParsedSubscription<true, 'trains'>[],
    trainChanges: Map<string, TrainDataAPI[]>,
    previousTrains: Map<string, CollatedTrain>,
    currentTrains: Map<string, CollatedTrain>,
    heartbeat: HeartbeatTimes
) {
    for (const [trn, changedApis] of trainChanges) {
        const subscriptionIds: string[] = [];
        // The status includes the data from every API included by any of the matching subscriptions
        let apis: Set<TrainDataAPI> | undefined = new Set();
        for (const parsed of trainsSubscriptions) {
            if (trainChangeMatches(trn, changedApis, parsed, previousTrains, currentTrains)) {
                subscriptionIds.push(parsed.subscription.id);
                if (apis) {
                    if (parsed.apis) {
                        for (const api of parsed.apis) apis.add(api);
                    } else {
                        apis = undefined;
                    }
                }
            }
        }
        if (!subscriptionIds.length) continue;
        send(token, 'trains', {
            trn,
            heartbeat,
            status: filterApis(currentTrains.get(trn), apis) ?? null
        }, subscriptionIds);
    }
}

/** Calls the function for each token with a connected stream, so that an error for one token doesn't affect others */
function forEachStreamingToken(callback: (token: SubscriptionToken) => void) {
    for (const token of tokens.values()) {
        if (!token.streams.length) continue;
        try {
            callback(token);
        } catch (e) {
            console.error(`[SUBSCRIPTIONS] Failed to send messages for ${token.value}:`, e);
        }
    }
}

eventEmitter.on("heartbeat-end", ({ heartbeat, previousTrains, currentTrains, dueTimes }: HeartbeatEnd) => {
    // Only calculate the train changes once and only if any subscriptions need them
    let trainChanges: Map<string, TrainDataAPI[]> | undefined;
    forEachStreamingToken(token => {
        const subscriptions = [...token.subscriptions.values()];
        if (dueTimes) sendDueTimes(token, subscriptions, dueTimes, currentTrains, heartbeat);
        const trainsSubscriptions = subscriptions.filter(parsed => isTopic(parsed, 'trains'));
        if (trainsSubscriptions.length) {
            trainChanges ??= getTrainChanges(previousTrains, currentTrains);
            sendTrainChanges(token, trainsSubscriptions, trainChanges, previousTrains, currentTrains, heartbeat);
        }
        // This is sent last, so clients know they have received all the heartbeat's messages
        const heartbeatsSubscription = subscriptions.find(({ subscription }) => subscription.topic === 'heartbeats');
        if (heartbeatsSubscription) send(token, 'heartbeats', { heartbeat }, [heartbeatsSubscription.subscription.id]);
    });
});

function sendDiagnostic(topic: 'heartbeat-errors' | 'heartbeat-warnings', payload: HeartbeatError | HeartbeatWarning) {
    forEachStreamingToken(token => {
        const subscriptionIds = [...token.subscriptions.values()]
            .filter(parsed => isTopic(parsed, topic) && (!parsed.apis || parsed.apis.has(payload.api)))
            .map(({ subscription }) => subscription.id);
        if (subscriptionIds.length) send(token, topic, payload, subscriptionIds);
    });
}

eventEmitter.on("heartbeat-error", (error: HeartbeatError) => sendDiagnostic('heartbeat-errors', error));
eventEmitter.on("heartbeat-warning", (warning: HeartbeatWarning) => sendDiagnostic('heartbeat-warnings', warning));
