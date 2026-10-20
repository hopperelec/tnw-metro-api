import {FastifyReply} from "fastify";

type Primitive = string | number | boolean | null;

export type SourceValue = Primitive | SourceContainer | Date;
export type SourceContainer =
    | { [key: string]: SourceValue }
    | SourceValue[]
    | Map<string, SourceValue>
    | Set<Primitive>;

type OutputValue = Primitive | OutputContainer;
type OutputContainer =
    | { [key: string]: OutputValue }
    | OutputValue[];

type PropTree = {
    [key: string]: PropTree | true; // true indicates a leaf (property to be extracted)
};

/**
 * Sends a response, filtered by `props`.
 * Response schemas mark properties as required, which makes serializing fail if they've been filtered out, so filtered
 *  responses aren't serialized using the schema. This is fine since `extractProps` already converts them to JSON values.
 */
export function sendWithProps(res: FastifyReply, value: SourceContainer, props: string | undefined) {
    if (props !== undefined) res.serializer(JSON.stringify);
    return res.send(extractProps(value, props));
}

export function extractProps(value: SourceContainer, props: string): OutputValue {
    if (props === undefined) return convertContainers(value);
    const tree: PropTree = {};
    nextProp: for (const prop of props.split(",")) {
        if (!prop) continue;
        const path = prop.split('.');
        let currentNode = tree;
        for (let i = 0; i < path.length; i++) {
            const segment = path[i];
            if (i === path.length - 1) {
                currentNode[segment] = true;
            } else {
                let nextNode = currentNode[segment];
                if (nextNode === true) {
                    // Already a leaf, no need to specifically include its children
                    continue nextProp;
                }
                if (nextNode === undefined) {
                    nextNode = {};
                    currentNode[segment] = nextNode;
                }
                currentNode = nextNode;
            }
        }
    }
    return traverseWithTree(value, tree);
}

function isPrimitive(value: unknown): value is Primitive {
    return value === null || typeof value !== 'object';
}

function isArrayOrSet(value: SourceContainer): value is SourceValue[] | Set<Primitive> {
    return Array.isArray(value) || value instanceof Set;
}

function traverseWithTree(value: SourceValue, tree: PropTree): OutputValue {
    if (isPrimitive(value)) return value;
    if (value instanceof Date) return value.getTime();

    // Immediately traverse the values of an array/Set
    if (isArrayOrSet(value)) {
        const results = [];
        for (const item of value) {
            results.push(traverseWithTree(item, tree));
        }
        return results;
    }

    // Special case for just requesting keys of an object/Map
    if (tree.keys && Object.keys(tree).length === 1) {
        if (value instanceof Map) return Array.from(value.keys());
        return Object.keys(value);
    }

    // Immediately traverse the values of a Map
    if (value instanceof Map) {
        return Object.fromEntries(
            Array.from(value.entries()).map(([key, val]) => [
                key,
                traverseWithTree(val, tree),
            ])
        );
    }

    // Compare the keys of the object with the PropTree
    const result = {};
    for (const [key, subtree] of Object.entries(tree)) {
        if (key in value) {
            if (subtree === true) {
                result[key] = convertContainers(value[key]);
            } else {
                result[key] = traverseWithTree(value[key], subtree);
            }
        }
    }
    return result;
}

export function convertContainers(value: SourceContainer | SourceValue): OutputValue {
    if (isPrimitive(value)) return value;
    if (value instanceof Date) return value.getTime();
    if (isArrayOrSet(value)) {
        const arr = [];
        for (const item of value) {
            arr.push(convertContainers(item));
        }
        return arr;
    }
    const obj = {};
    for (
        const [k, v] of
        value instanceof Map ? value.entries() : Object.entries(value)
    ) obj[k] = convertContainers(v);
    return obj;
}