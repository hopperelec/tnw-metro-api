import {LOCATION_ABBREVIATIONS} from "./constants";
import * as TimesAPI from "./parsing/rti/times-api";
import * as GeoAPI from "./parsing/rti/geo-api";
import {ApiType} from "../generated/prisma/enums";

export type LocationAbbreviation = keyof typeof LOCATION_ABBREVIATIONS;
export type LineName = 'green' | 'yellow';

export type Platform = { station: string; platformNumber: number };
/** A location to filter by, which is any platform at the station if `platformNumber` is omitted */
export type ParsedLocation = Pick<Platform, 'station'> & Partial<Platform>;

export const TrainDataAPIs = ['TIMES', 'GEO'] as const satisfies (keyof typeof ApiType)[];
export type TrainDataAPI = typeof TrainDataAPIs[number];

/** Filters for trains, as used by the history endpoints and `trains` subscriptions. Missing filters match everything. */
export interface TrainFilters {
    trns?: Set<string>;
    apis?: Set<TrainDataAPI>;
    eventTypes?: Set<string>;
    locations?: ParsedLocation[];
    destinations?: Set<string>;
}

export type CollatedTrain = Partial<{
    timesAPI: TimesAPI.ParsedTrain | Omit<TimesAPI.ParsedTrain, 'nextPlatforms'>
    geoAPI: GeoAPI.TrainStatus;
}>;
