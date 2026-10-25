# Sonos announcer

Play an MP3 visitor announcement on selected Sonos speakers, with individual volumes and active hours. Apple Home triggers a Home Assistant switch, which calls `GET /announce` or `POST /announce`.

The app connects **directly to the speakers** using their local WebSocket API and native `audioClip` capability. No `node-sonos-http-api` service, Sonos cloud account or Home Assistant API connection is required. The MP3 is served by this app.

## Setup

Requires Node.js 24 or newer. Docker uses Node.js 24 LTS.

1. Put your MP3 in `clips/announce.mp3`. Local audio is ignored by Git and excluded from Docker builds; mount it separately in production.
2. Copy `.env.dist` to `.env`. Set `SONOS_HOSTS` to one or more speaker IP addresses, and `MEDIA_BASE_URL` to **this application's address as reached by the speakers**, for example `http://192.168.1.20:3000`. Docker service names and `localhost` usually cannot be reached by speakers.
3. Configure speaker UUIDs in `config/speakers.yaml`. The included configuration selects the Beam in Woonkamer and the Era 300 in Keuken.
4. Run `npm ci` and `npm start` for development.

For production, run `npm run build`, inject the environment variables, and run `NODE_ENV=production npm run start:production`. Production does not load `.env` automatically. Missing/unreadable/empty MP3 files and invalid configuration fail at startup.

## Speaker identity and discovery

```yaml
speakers:
  Woonkamer:
    uuid: RINCON_347E5C8246BA01400
    volume: 25
  Keuken:
    uuid: RINCON_804AF28596D001400
    volume: 30
    # Optional: announce only from 09:00 up to, but not including, 19:00.
    # active:
    #   start: 9
    #   end: 19
```

The mapping keys are your own labels, used in logs and HTTP responses. Selection uses the physical speaker's UUID, so renaming Woonkamer or Keuken in Sonos does not break announcements. UUIDs are required and duplicates are rejected. Selecting by model alone would also select any additional speakers of that model.

`SONOS_HOSTS` provides discovery addresses. On each announcement, the first reachable seed supplies the household's current player addresses; an unavailable seed does not delay an available one. Use DHCP reservations for the seed IP addresses. UUIDs survive IP changes, but at least one seed address must remain reachable. All seeds should belong to the same Sonos household. Each target's identity and `AUDIO_CLIP` capability are checked before playback. A missing or unsupported target fails individually without blocking other rooms.

Read-only discovery from your shell:

```sh
npm run speakers
# Or inside the deployed image:
docker exec sonos-announcer node speakers.js
```

This prints names, UUIDs, addresses and audio clip support. It only needs `SONOS_HOSTS`; no MP3 or media URL is required. There is no public `/zones` endpoint or Sonos API proxy.

## Playback and schedules

The native clip feature handles coexistence with music or TV audio on the speaker. This app sends no pause, seek, volume-change, regrouping or restoration commands. Clip volume is supplied with the clip, rather than changing the regular player volume. The Beam and Era 300 in the example configuration have both advertised `AUDIO_CLIP` support during a read-only check.

This differs from the old URI/preset workaround: there is no `RESTORE_MODE` and no application snapshot to reapply after the chime. Native behavior with your playback sources still needs an audible check when deploying. Older speakers without `AUDIO_CLIP` are not supported by this implementation.

Volumes are integers from 0 to 100; Sonos may clamp clip volume to its own audible limits. Active hours include the start and exclude the end. Omit `active` for all-day announcements. Overnight windows such as `start: 22, end: 7` are supported; `end: 24` means the end of the day. Equal start and end hours are rejected. Scheduling uses `TIME_ZONE`, including daylight saving changes. Configuration changes require a restart.

The app subscribes to clip status before requesting playback, then waits for `DONE` for its own clip ID. An acknowledgement that a clip was scheduled is not treated as completed playback. `ERROR`, `DISMISSED` and `INTERRUPTED` are failures. A timeout or connection loss means completion is unknown; it does not cancel the speaker's clip. Commands are not automatically retried.

Protocol references: [Sonos audioClip](https://docs.sonos.com/reference/audioclip), [clip states](https://docs.sonos.com/reference/audioclip-parameters), and the [local WebSocket transport used by Home Assistant](https://github.com/jjlawren/sonos-websocket). The local transport is not the documented cloud HTTP API and may need adjustment after firmware changes.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `SONOS_HOSTS` | Required | Comma-separated speaker IP addresses; port defaults to 1443. |
| `MEDIA_BASE_URL` | Required | HTTP(S) URL of this app, reachable from the speakers. No credentials, query or fragment. A reverse-proxy path prefix is supported if the proxy strips that prefix. |
| `CLIP_FILE` | `./clips/doorbell.mp3` | Local MP3 path. The example environment uses `./clips/announce.mp3`. Must be non-empty, readable and at most 10 MiB. |
| `PORT` | `3000` | Listening port. Legacy `NODE_PORT` takes precedence. |
| `SPEAKERS_CONFIG` | `./config/speakers.yaml` | YAML configuration file. |
| `TIME_ZONE` | Process timezone | IANA timezone; the example uses `Europe/Brussels`. |
| `SONOS_REQUEST_TIMEOUT_MS` | `60000` | Total deadline per discovery connection or target operation, including playback completion. |
| `SHUTDOWN_TIMEOUT_MS` | Two operation timeouts + 5000 | Maximum shutdown drain time, default 125 seconds. |
| `ANNOUNCE_TOKEN` | Unset | Optional bearer token required for `/announce`. |

Use short MP3 clips and allow enough time for fetching and playback. Home Assistant and any reverse proxy must allow the HTTP request to wait for discovery and completion. Sonos must reach `MEDIA_BASE_URL`, and the app must reach the speakers on TCP 1443. No multicast discovery or inbound Sonos event callback ports are needed.

Only local Sonos WebSocket connections allow the speakers' self-signed certificates. TLS verification is not disabled globally. If serving the MP3 through HTTPS, use a certificate the speakers trust.

## HTTP contract

`GET /announce` and `POST /announce` play the configured clip and wait for completion. Existing integrations can continue reading the `success` boolean. Successful requests return HTTP 200:

```json
{
  "success": true,
  "speakers": [
    { "zone": "Woonkamer", "status": "announced" },
    { "zone": "Keuken", "status": "skipped", "reason": "outside_active_hours" }
  ]
}
```

A speaker failure returns HTTP 502 and `success: false`, with a per-room `errors` array containing a `discovery` or `announcement` stage and a message. Other eligible rooms still run. If every room is outside active hours, the result is a successful no-op without contacting Sonos.

Overlapping requests share the current announcement and result; they do not queue another chime. Once it finishes, a new request starts a new announcement. A disconnected caller does not cancel the operation. Coalescing is local to one process; run one replica to avoid simultaneous playback commands from multiple instances.

`GET /health` returns 200 while accepting announcements and 503 while shutting down. It does not query speaker connectivity or represent the Home Assistant switch state. `HEAD /announce` and `OPTIONS /announce` return 204 without audio, other methods return 405, and subpaths return 404. Do not poll `GET /announce` for switch state.

With `ANNOUNCE_TOKEN`, add `Authorization: Bearer <token>` to the Home Assistant request. The clip itself is available without that header at a random `/clips/<token>.mp3` path supplied directly to Sonos. This path changes on restart; only the configured file is served, with byte-range support and no directory listing. The token is an unguessable URL, not user authentication. Restrict `/clips/` to the speaker network at your proxy if you do not want it internet-accessible. `/zones` is always absent.

## Migration from sonos-api

The existing Home Assistant `/announce` integration can remain. Update the container configuration before replacing the old image:

1. Preserve the current MP3. On your Docker host, the current source is `sonos-api:/app/static/clips/announce.mp3`. Reuse its existing clips volume as a read-only mount in the new container, or copy it:

   ```sh
   mkdir -p clips
   docker cp sonos-api:/app/static/clips/announce.mp3 ./clips/announce.mp3
   ```

2. Mount the clips directory at `/usr/src/app/clips`, set `CLIP_FILE=./clips/announce.mp3`, `SONOS_HOSTS=10.1.60.156,10.1.60.216`, and a reachable `MEDIA_BASE_URL`.
3. Replace room-name-only configuration with the UUID mapping above. Remove `SONOS_HTTP_SERVER`, `CLIP` and `RESTORE_MODE`; they are no longer used.
4. Deploy, check `/health`, and run `docker exec sonos-announcer node speakers.js`. Then check a real announcement with music/TV playing and while paused, including any usual speaker groups.
5. Remove the old sonos-api service only after that check and after confirming nothing else uses it.

## Docker

```sh
docker build -t sonos-announcer .
docker run --name sonos-announcer --restart unless-stopped \
  --stop-timeout 130 \
  --env-file .env \
  -p 3000:3000 \
  --mount type=bind,src="$(pwd)/config",dst=/usr/src/app/config,readonly \
  --mount type=bind,src="$(pwd)/clips",dst=/usr/src/app/clips,readonly \
  sonos-announcer
```

The image includes the example speaker configuration. It runs as the unprivileged `node` user, so mounted files must be readable by that user. Adjust the published port when overriding `PORT` or `NODE_PORT`.

SIGINT, SIGTERM and SIGQUIT reject new announcements and wait for active clips, while keeping the MP3 available for the speakers. Docker's stop timeout must exceed `SHUTDOWN_TIMEOUT_MS`; 130 seconds covers the default 125 seconds.

## Development and checks

- `npm start`: watch and run the TypeScript application.
- `npm run build`: compile production JavaScript with strict type checking.
- `npm run lint`: lint application source.
- `npm test`: build and run the Node test suite.
- `npm run test:watch`: watch source-based tests. Build first; process tests exercise the compiled entry point.
- `npm run speakers`: read-only discovery.

Tests use simulated speakers over local TLS WebSockets and loopback HTTP servers. They cover UUID identity, rename handling, capability checks, discovery failover, clip completion and errors, concurrency, schedules, media downloads, authentication and shutdown. The certificate/key in `test/fixtures` is a public test fixture, never used by the application. No real audio is played by tests.

CI runs lint, build and tests for pull requests and master pushes. Docker publishing remains restricted to master after those checks pass.
