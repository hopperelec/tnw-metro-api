import type {CollatedTrain, ParsedLocation, Platform, TrainDataAPI, TrainFilters} from "../../types";
import {geoDataKey, timesDataKey} from "../../history";
import {LOCATION_ABBREVIATIONS, MONUMENT_STATION_CODES} from "../../constants";
import * as TimesAPI from "../../parsing/rti/times-api";
import * as GeoAPI from "../../parsing/rti/geo-api";

/**
 * Parses locations to filter by, in the format `<station code>_<platform number>` or just a station code.
 * Throws an error if any are invalid.
 */
export function parseLocations(locations: string[]): ParsedLocation[] {
    return locations.map(location => {
        const [abbreviation, platformStr] = location.split('_');
        let locationName: string;
        if (MONUMENT_STATION_CODES.includes(abbreviation)) {
            locationName = 'Monument';
        } else {
            locationName = LOCATION_ABBREVIATIONS[abbreviation];
            if (!locationName) throw new Error(`Invalid location abbreviation: ${abbreviation}`);
        }
        let platformNumber: number | undefined = undefined;
        if (platformStr) {
            platformNumber = +platformStr;
            if (isNaN(platformNumber)) throw new Error(`Invalid location: ${location}`);
        }
        return {
            station: locationName,
            platformNumber,
        };
    });
}

/** A train's data from the included APIs (or all APIs), or undefined if it doesn't have data from any of them */
export function filterApis(train?: CollatedTrain, apis?: Set<TrainDataAPI>): CollatedTrain | undefined {
    if (!train) return;
    const filtered: CollatedTrain = {};
    if (train.timesAPI && (!apis || apis.has('TIMES'))) filtered.timesAPI = train.timesAPI;
    if (train.geoAPI && (!apis || apis.has('GEO'))) filtered.geoAPI = train.geoAPI;
    if (filtered.timesAPI || filtered.geoAPI) return filtered;
}

function matchesLocation(location: string | Platform, locations?: ParsedLocation[]) {
    if (!locations) return true;
    // Unparsed locations can't be matched, like in the history
    if (typeof location === 'string') return false;
    return locations.some(filter =>
        filter.station === location.station &&
        (filter.platformNumber === undefined || filter.platformNumber === location.platformNumber)
    );
}

function matchesTimesData(data: Omit<TimesAPI.ParsedTrain, 'nextPlatforms'>, filters: TrainFilters) {
    if (filters.eventTypes && !filters.eventTypes.has(data.lastEvent.type)) return false;
    if (filters.destinations && !filters.destinations.has(data.plannedDestinations[0]?.name)) return false;
    return matchesLocation(data.lastEvent.location, filters.locations);
}

function matchesGeoData(data: GeoAPI.TrainStatus, filters: TrainFilters) {
    if (filters.destinations && !filters.destinations.has(data.destination)) return false;
    if (!filters.eventTypes && !filters.locations) return true;
    // Event types and locations can only be matched if the last seen status was parsed, like in the history
    if (typeof data.lastSeen === 'string') return false;
    if (filters.eventTypes && !filters.eventTypes.has(data.lastSeen.type)) return false;
    return matchesLocation(data.lastSeen, filters.locations);
}

/** Whether any of the train's data matches the filters (other than `trns` and `apis`) */
export function matchesStatusFilters(train: CollatedTrain, filters: TrainFilters) {
    return (train.timesAPI !== undefined && matchesTimesData(train.timesAPI, filters)) ||
        (train.geoAPI !== undefined && matchesGeoData(train.geoAPI, filters));
}

/**
 * The APIs whose data for a train has changed (including starting or stopping showing the train).
 * Data is only considered changed if the data stored in the history changes.
 */
export function changedApis(previousTrain?: CollatedTrain, currentTrain?: CollatedTrain) {
    const changed: TrainDataAPI[] = [];
    const previousTimesKey = previousTrain?.timesAPI && timesDataKey(previousTrain.timesAPI);
    const currentTimesKey = currentTrain?.timesAPI && timesDataKey(currentTrain.timesAPI);
    if (previousTimesKey !== currentTimesKey) changed.push('TIMES');
    const previousGeoKey = previousTrain?.geoAPI && geoDataKey(previousTrain.geoAPI);
    const currentGeoKey = currentTrain?.geoAPI && geoDataKey(currentTrain.geoAPI);
    if (previousGeoKey !== currentGeoKey) changed.push('GEO');
    return changed;
}

/** Whether filter `a` matches everything which filter `b` does, where missing filters match everything */
export function setCovers<T>(a?: Set<T>, b?: Set<T>) {
    if (!a) return true;
    if (!b) return false;
    return [...b].every(value => a.has(value));
}

function locationsCover(a?: ParsedLocation[], b?: ParsedLocation[]) {
    if (!a) return true;
    if (!b) return false;
    return b.every(bLocation => a.some(aLocation =>
        aLocation.station === bLocation.station &&
        (aLocation.platformNumber === undefined || aLocation.platformNumber === bLocation.platformNumber)
    ));
}

/** Whether every train matching filters `b` also matches filters `a` */
export function trainFiltersCover(a: TrainFilters, b: TrainFilters) {
    // If `a` has status filters, its extra APIs' data could stop it from matching. For example, if `b` only includes
    //  the Geo API and a train stops showing in it, `b` matches if its Geo data did, but `a` would need its Times data to.
    const apisCover = a.eventTypes || a.locations || a.destinations
        ? setCovers(a.apis, b.apis) && setCovers(b.apis, a.apis)
        : setCovers(a.apis, b.apis);
    return setCovers(a.trns, b.trns) &&
        apisCover &&
        setCovers(a.eventTypes, b.eventTypes) &&
        setCovers(a.destinations, b.destinations) &&
        locationsCover(a.locations, b.locations);
}
