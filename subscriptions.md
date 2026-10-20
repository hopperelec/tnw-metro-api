# tnw-metro-api - Subscriptions

For realtime updates, this proxy provides a subscription-based [Server-Sent Events (SSE)](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/) stream, which is strongly recommended over polling the REST endpoints.

The basic idea is:
- Your client tells the proxy what it wants realtime updates for by subscribing to one or more topics.
- The proxy leases your client a token identifying your subscriptions.
- That token has an SSE stream, which your client connects to.
- The proxy sends any messages you subscribed to, whenever they occur, to your stream.

## Endpoints

### `POST /v1/subscriptions`

Leases a token with some subscriptions.

#### Example request body:
```json
{
  "subscriptions": [
    { "id": "monument-due-times", "topic": "station-due-times", "station": "MMT" },
    { "id": "t101", "topic": "trains", "trns": ["101"] },
    { "topic": "heartbeat-errors" }
  ]
}
```

#### Example response:
```json
{
  "token": "abc123",
  "subscriptions": [
    { "id": "monument-due-times", "topic": "station-due-times", "station": "MMT" },
    { "id": "t101", "topic": "trains", "trns": ["101"] },
    { "id": "1", "topic": "heartbeat-errors" }
  ],
  "replaced": []
}
```

### `GET /v1/subscriptions/:token`

Gets information about a token, such as its current `subscriptions`, how many `streams` are connected (0 or 1), and when it `expiresAt` (or `null` while a stream is connected).

#### Example response:
```json
{
  "subscriptions": [
    { "id": "monument-due-times", "topic": "station-due-times", "station": "MMT" },
    { "id": "t101", "topic": "trains", "trns": ["101"] },
    { "id": "1", "topic": "heartbeat-errors" }
  ],
  "streams": 0,
  "expiresAt": 1791408778123
}
```

### `POST /v1/subscriptions/:token`

Adds subscriptions to the token.

#### Example request body:
```json
{
  "subscriptions": [
    { "id": "all-trains", "topic": "trains" }
  ]
}
```

#### Example response:
```json
{
  "subscriptions": [
    { "id": "monument-due-times", "topic": "station-due-times", "station": "MMT" },
    { "id": "1", "topic": "heartbeat-errors" },
    { "id": "all-trains", "topic": "trains" }
  ],
  "replaced": ["t101"]
}
```

### `DELETE /v1/subscriptions/:token/:id`

Removes a single subscription from the token.

### `DELETE /v1/subscriptions/:token`

Deletes the token, along with its subscriptions. Any connected streams are closed.

### `GET /v1/subscriptions/:token/stream`

The token's stream. Add the `subscriptionIds` query parameter to include the IDs of the matching subscriptions in each message.

The stream conforms to the [Server-Sent Events specification](https://html.spec.whatwg.org/multipage/server-sent-events.html). The stream starts with a `keepalive` comment, which is also sent periodically whenever there is inactivity as a measure to maintain the connection. Each message is only sent once, even if it matches multiple subscriptions.

Only one connection to the stream can be open at a time. Opening a new connection will close the previous one, and the previous one will receive a `stream-closed` message with `reason` set to `replaced`.

#### Example stream body (with `subscriptionIds`):
```text
:keepalive

event: station-due-times
data: {"station":"MMT","heartbeat":{...},"dueTimes":[...],"subscriptionIds":["monument-due-times"]}

event: train
data: {"trn":"101","heartbeat":{...},"status":{...},"subscriptionIds":["t101","all-trains"]}

:keepalive

event: heartbeat-error
data: {"api":"TIMES","message":"TypeError: Cannot read property 'length' of undefined","heartbeat":{...},"subscriptionIds":["1"]}
```

## Tokens

Tokens are opaque strings which identify a stream and its subscriptions. Clients should typically only have one token at a time. Tokens should be treated as secret, as well as ephemeral since they may expire at any time (e.g., if the proxy restarts). If a token expires, the proxy will respond to all requests involving the token with HTTP `404` and the client should create a new token and re-subscribe to the topics it needs.

## Subscriptions

Both `POST` endpoints take an array of subscriptions, where each subscription is an object with a `topic`, an optional `id`, and the parameters for that topic:

```json
{
  "subscriptions": [
    { "id": "monument-due-times", "topic": "station-due-times", "station": "MMT" },
    { "id": "to-south-hylton", "topic": "trains", "destinations": ["South Hylton"] },
    { "topic": "heartbeat-errors" }
  ]
}
```

- `id` identifies the subscription in messages and for removing/replacing it. It can be up to 64 letters, digits, hyphens or underscores, and only needs to be unique within the token. If you do not provide one, then one is generated for you. Subscribing with the ID of an existing subscription replaces that subscription.
- A subscription is **redundant** if every message it would cause would already be sent for another subscription on the same token. For example, a platform when its station is already subscribed to, a specific train when all trains are already subscribed to, or errors from one API when errors from all APIs are already subscribed to. Redundant subscriptions are rejected.
- Conversely, existing subscriptions which are covered by a new subscription are removed, and their IDs are listed in the response's `replaced`.
- Either all or none of the subscriptions in a request are added, depending on if any are invalid, redundant, or would exceed the limits.

Subscriptions are returned normalised: aliases are converted (e.g., `MTE` to `MTW`), filter values are sorted with duplicates removed, and empty filters are omitted.

## Limits

These are also available from `/v1/constants`.

<table>
  <thead>
    <tr>
        <th>Limit</th>
        <th>Value</th>
        <th>Constant</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Tokens per IP address</td>
      <td>5</td>
      <td><code>MAX_SUBSCRIPTION_TOKENS_PER_IP</code></td>
    </tr>
    <tr>
      <td>Subscriptions per token</td>
      <td>50</td>
      <td><code>MAX_SUBSCRIPTIONS_PER_TOKEN</code></td>
    </tr>
    <tr>
      <td>Filter values (e.g., TRNs and destinations) per subscription</td>
      <td>100</td>
      <td><code>MAX_SUBSCRIPTION_FILTER_VALUES</code></td>
    </tr>
    <tr>
      <td>Streams per token</td>
      <td>1</td>
      <td><code>MAX_STREAMS_PER_TOKEN</code></td>
    </tr>
  </tbody>
</table>

## Topics

<table>
    <thead>
        <tr>
            <th>Topic</th>
            <th>Parameters</th>
            <th>Events</th>
            <th>Redundant if already subscribed to</th>
        </tr>
    </thead>
    <tbody>
        <tr>
            <td><code>station-due-times</code></td>
            <td><code>station</code>: a station code, e.g., <code>MMT</code></td>
            <td><code>station-due-times</code>: The trains due at the station, when subscribing and after each heartbeat</td>
            <td>The same station, or <code>MMT</code> for <code>MTS</code> and <code>MTW</code></td>
        </tr>
        <tr>
            <td><code>platform-due-times</code></td>
            <td><code>platform</code>: a platform code, e.g., <code>MTW;3</code></td>
            <td><code>platform-due-times</code>: The trains due at the platform, when subscribing and after each heartbeat</td>
            <td>The same platform, or its station</td>
        </tr>
        <tr>
            <td><code>trains</code></td>
            <td>
                Optional filters, all arrays of strings. If a filter is not provided, any value matches. If a filter is provided, only trains which match any of its values are included.<br>
                - <code>trns</code>: Only include trains with these train running numbers (TRNs, without the leading "T", e.g., "101").<br>
                - <code>apis</code>: Only include data from these APIs (e.g., <code>TIMES</code> and/or <code>GEO</code>).<br>
                - <code>eventTypes</code>: Only include trains where the last event is of one of these types.<br>
                - <code>locations</code>: Only include trains where the last event was at one of these locations, in the format <code>&lt;station code&gt;_&lt;platform number&gt;</code> (e.g., <code>MTW_4</code>), or just a station code for all platforms at a station.<br>
                - <code>destinations</code>: Only include trains with one of these destinations (e.g., <code>South Hylton</code>). For the Times API, this is the first planned destination.
            </td>
            <td><code>train</code>: A train's new status whenever it changes, or it becomes inactive</td>
            <td>A <code>trains</code> subscription whose filters each match everything this one's does</td>
        </tr>
        <tr>
            <td><code>heartbeat-errors</code></td>
            <td><code>apis</code> (optional)</td>
            <td><code>heartbeat-error</code>: Errors which occur during heartbeats</td>
            <td><code>heartbeat-errors</code> for the same or more APIs</td>
        </tr>
        <tr>
            <td><code>heartbeat-warnings</code></td>
            <td><code>apis</code> (optional)</td>
            <td><code>heartbeat-warning</code>: Warnings produced during heartbeats</td>
            <td><code>heartbeat-warnings</code> for the same or more APIs</td>
        </tr>
        <tr>
            <td><code>heartbeats</code></td>
            <td>(none)</td>
            <td><code>heartbeat-end</code>: The end of each heartbeat</td>
            <td><code>heartbeats</code></td>
        </tr>
    </tbody>
</table>

A heartbeat is the proxy polling Nexus' APIs, which happens at least every `PASSIVE_REFRESH_INTERVAL` milliseconds (see `/v1/constants`), and more often when the REST endpoints are used.

## Events

Events for a heartbeat are sent in this order:

1. `heartbeat-error` and `heartbeat-warning`, as soon as they occur
2. `station-due-times` and `platform-due-times`
3. `train`
4. `heartbeat-end`

### `station-due-times`

Sent when subscribing (if the due times are available) and when the stream connects, and then after each heartbeat which successfully fetched the due times, regardless of whether they have changed.

#### Data Payload

`station`: The station code, as subscribed to.

`heartbeat`: The corresponding heartbeat.

`dueTimes`: An array of objects in the same format as the `/v1/due-times/station/:station` endpoint, in order of `time.dueIn`. Each train's `status` is in the same format as `/v1/train/:trn`.

#### Example

```json
{
  "station": "MMT",
  "heartbeat": {
    "startedAt": 1791231124968,
    "endedAt": 1791231125102
  },
  "dueTimes": [
    {
      "platform": 3,
      "trn": "101",
      "time": {
        "dueIn": 5,
        "actualScheduledTime": 1791231420000,
        "actualPredictedTime": 1791231440000
      },
      "status": {
        "timesAPI": {...},
        "geoAPI": {...}
      }
    },
    ...
  ]
}
```

### `platform-due-times`

Sent at the same times as `station-due-times`.

#### Data Payload

`platform`: The platform code, as subscribed to.

`heartbeat`: The corresponding heartbeat.

`dueTimes`: An array of objects in the same format as the `/v1/due-times/platform/:platform` endpoint, in order of `time.dueIn`.

#### Example

```json
{
  "platform": "MTW;3",
  "heartbeat": {
    "startedAt": 1791231124968,
    "endedAt": 1791231125102
  },
  "dueTimes": [
    {
      "trn": "101",
      "time": {
        "dueIn": 5,
        "actualScheduledTime": 1791231420000,
        "actualPredictedTime": 1791231440000
      },
      "status": {
        "timesAPI": {...},
        "geoAPI": {...}
      }
    },
    ...
  ]
}
```

### `train`

Sent for each train whose status changed during a heartbeat, or which became inactive, if it matches any of the `trains` subscriptions. To get the status of trains when first subscribing, use `/v1/trains` or `/v1/train/:trn`.

A train's status is only considered to have changed if the data which is stored in the history has changed. So, changes to just the Times API's `nextPlatforms`, or the times at which destinations are planned, don't count.

#### Data Payload

`trn`: The train's TRN.

`heartbeat`: The heartbeat during which the status changed.

`status`: The train's new status, in the same format as `/v1/train/:trn`, or `null` if it became inactive. This includes the data from each API included by any of the matching subscriptions. So, it can be missing an API's data which a matching subscription includes, if the train is no longer showing in that API.

#### Example

```json
{
  "trn": "101",
  "heartbeat": {
    "startedAt": 1791231124968,
    "endedAt": 1791231125102
  },
  "status": {
    "timesAPI": {
      "lastEvent": {
        "type": "APPROACHING",
        "location": {
          "station": "Monument",
          "platformNumber": 4
        },
        "time": 1791231119000
      },
      "plannedDestinations": [
        {
          "name": "St James",
          "from": {
            "platformCode": "MTW;4",
            "time": 1791231180000
          }
        },
        ...
      ],
      "nextPlatforms": [
        {
          "code": "MTW;4",
          "time": {
            "dueIn": -1,
            "actualScheduledTime": null,
            "actualPredictedTime": 1791231180000
          }
        },
        ...
      ]
    },
    "geoAPI": {
      "destination": "St James",
      "lastSeen": {
        "type": "APPROACHING",
        "station": "Monument",
        "platformNumber": 4,
        "time": 1791231120000
      }
    }
  }
}
```

### `heartbeat-error`

Sent when an unrecoverable error occurs, while fetching or parsing data from the underlying Nexus APIs, which will prevent any data from that API from being available. The most common cause of this is Nexus taking the APIs down due to system issues causing unreliable data, meaning it should be fixed at a later time. Sometimes, though, this may be caused by breaking changes in those underlying APIs which this proxy has not yet been updated to handle.

#### Data Payload

This is in the same format as the `/v1/history/heartbeat-errors` endpoint.

`api`: Identifier of the API that produced the error.

`message`: String containing the error message.

`heartbeat`: The heartbeat during which the error occurred. Its `endedAt` will always be `null`, since the heartbeat is still ongoing.

#### Example

```json
{
  "api": "TIMES",
  "message": "TypeError: Cannot read property 'length' of undefined",
  "heartbeat": {
    "startedAt": 1791231124968,
    "endedAt": null
  }
}
```

### `heartbeat-warning`

Sent when an issue occurs, or an inconsistency is spotted, while parsing or collating data from the underlying Nexus APIs, usually only affecting small parts of the data (e.g.: individual trains or stations) rather than the entire API. For example, this could be caused by multiple trains reporting the same TRN. This is not a fatal error, and the API will continue to function normally. However, it may indicate that the data being returned is not entirely accurate.

#### Data Payload

This is in the same format as the `/v1/history/heartbeat-errors?warnings` endpoint.

`api`: Identifier of the API that produced the warning.

`data`: The specific warning data. The structure will vary depending on the API that produced the warning. A list of APIs and their warning structures is provided at the end of this document.

`heartbeat`: The heartbeat during which the warning was produced. Its `endedAt` will always be `null`, since the heartbeat is still ongoing.

#### Example

```json
{
  "api": "TIMES",
  "data": {
    "SJM;1": [
      {
        "message": "Duplicate TRN in times API response. Keeping first.",
        "object": { "trn": "101", ... }
      }
    ]
  },
  "heartbeat": {
    "startedAt": 1791231124968,
    "endedAt": null
  }
}
```

### `heartbeat-end`

Sent at the end of every heartbeat, after all of the heartbeat's other messages.

#### Data Payload

`heartbeat`: The heartbeat which ended.

#### Example

```json
{
  "heartbeat": {
    "startedAt": 1791231124968,
    "endedAt": 1791231125102
  }
}
```

### `stream-closed`

Sent, regardless of the token's subscriptions, just before the proxy closes the stream.

#### Data Payload

`reason`: The reason for the stream closure. Either `replaced` (another stream connected for the token) or `deleted` (the token was deleted).

#### Example

```json
{
  "reason": "replaced"
}
```

## APIs

When handling errors or warnings which may occur when fetching and parsing data from the upstream APIs,
you should know what each API is responsible for. Below are the identifiers for each API, along with a brief description of their purpose and the structure of their warnings, if applicable.

### `GATEWAY`

This provides access to other RTI APIs, so issues with it will likely affect other APIs.

This will not produce warnings.

### `TIMES`

This is the API which powers the train times shown at the bottom of the "Track your Metro" page in the Pop app, under the map.

Warnings from this API will be in the following format:

```json
{
  "api": "TIMES",
  "data": {
    "SJM;1": [
      {
        "message": "Duplicate TRN in times API response. Keeping first.",
        "object": { ... }
      },
      ...
    ],
    ...
  },
  "heartbeat": { ... }
}
```

`SJM;1` is an example of a platform identifier (should be `<stationCode>;<platformNumber>`, but a warning may be caused by the identifier being malformed)

`object` is the platform object (if the warning is for the entire platform) or the train object (if the warning is for a specific train). Because warnings may be caused by malformed data, you should not assume the structure of the `object`.

### `GEO`

This API provides the locations and statuses of trains shown on the map in the Pop app.

Warnings from this API will be in the following format:

```json
{
  "api": "GEO",
  "data": [
    {
      "message": "Duplicate TRN as another placemark. Keeping first.",
      "data": { ... }
    },
    ...
  ],
  "heartbeat": { ... }
}
```

Warnings are per train. The structure of `data` may change or be malformed so you should not rely on it.
