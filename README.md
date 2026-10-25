# Sonos announcer

Play an MP3 visitor announcement on selected Sonos speakers, with individual volumes and active hours. Apple Home triggers a Home Assistant switch, which calls `GET /announce` or `POST /announce`.

The app connects **directly to the speakers** using their local WebSocket API and native `audioClip` capability. No `node-sonos-http-api` service, Sonos cloud account or Home Assistant API connection is required. The MP3 is served by this app.

## Setup

Requires Node.js 24 or newer. Docker uses Node.js 24 LTS.

1. Put your MP3 in `clips/announce.mp3`. Local audio is ignored by Git and excluded from Docker builds; mount it separately in production.
2. Copy `.env.dist` to `.env`. Leave `SONOS_HOSTS` and `MEDIA_BASE_URL` unset for automatic speaker discovery and media addressing. Connect the app to the speaker network; see the Docker networking instructions below.
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

With `SONOS_HOSTS` unset or empty, the app discovers speakers automatically using SSDP. Like [node-sonos-discovery](https://github.com/jishi/node-sonos-discovery/blob/master/lib/sonos-ssdp.js), it sends searches over both multicast and broadcast on the available IPv4 network interfaces. Set `SONOS_DISCOVERY_INTERFACE` only if you need to select a particular local interface address. No additional Sonos library or service is needed.

On each announcement, known addresses and newly discovered candidates are tried concurrently. The first reachable speaker supplies the household's current player addresses; an unavailable speaker does not delay an available one. Discovered addresses are cached for fast subsequent announcements, while SSDP can find changed IP addresses. The search stops after a successful response or three seconds; connection attempts share the overall `SONOS_REQUEST_TIMEOUT_MS` deadline. Discovery starts when needed, so an offline speaker does not prevent the HTTP server from starting. A network with one Sonos household is assumed.

If your network blocks discovery, set `SONOS_HOSTS` to one or more speaker IP addresses or hostnames. This overrides automatic discovery. Use DHCP reservations for fixed seed IP addresses; at least one configured seed must remain reachable. All seeds should belong to the same Sonos household.

Each target's identity and `AUDIO_CLIP` capability are checked before playback. A missing or unsupported target fails individually without blocking other rooms. Malformed player descriptions are skipped with a diagnostic warning. Ambiguous duplicate UUIDs are excluded entirely, while usable speakers remain available. A missing display name falls back to the UUID.

Read-only discovery from your shell:

```sh
npm run speakers
# Or inside the deployed image:
docker exec sonos-announcer node speakers.js
```

This prints names, UUIDs, addresses and audio clip support as JSON on stdout. Diagnostic warnings and failures go to stderr. It supports automatic discovery without any environment variables; no MP3 or media URL is required. There is no public `/zones` endpoint or Sonos API proxy.

## Serving the mounted MP3

Speakers fetch the mounted MP3 from this app over HTTP. The app constructs the URL automatically from **its own local IP address on the connection to each speaker** and the HTTP listening port (`PORT`, or legacy `NODE_PORT`). It does not need a configured domain name, public URL or reverse-proxy mapping. The address is resolved for each announcement, so network changes are picked up on the next connection. HTTP `Host` and forwarded headers do not influence the media address.

This follows the approach of [node-sonos-http-api's clip action](https://github.com/jishi/node-sonos-http-api/blob/master/lib/actions/clip.js), which also served mounted files over HTTP using its local endpoint and listening port. The speaker never reads the Docker mount directly. Home Assistant can use the existing reverse proxy for `/announce`, while Sonos fetches the MP3 directly on the internal speaker network.

The network layer must allow the speakers to reach the container at that address and port. A direct IPvlan/macvlan attachment or suitable host networking provides this without application URL configuration. Automatic addressing cannot infer an arbitrary NAT port translation or external proxy URL. `MEDIA_BASE_URL` remains an optional override for those deployments; existing explicit values continue to work. An override can include a path prefix if the proxy strips it.

## Playback and schedules

The native clip feature handles coexistence with music or TV audio on the speaker. This app sends no pause, seek, volume-change, regrouping or restoration commands. Clip volume is supplied with the clip, rather than changing the regular player volume. The Beam and Era 300 in the example configuration have both advertised `AUDIO_CLIP` support during a read-only check.

This differs from the old URI/preset workaround: there is no `RESTORE_MODE` and no application snapshot to reapply after the chime. Native behavior with your playback sources still needs an audible check when deploying. Older speakers without `AUDIO_CLIP` are not supported by this implementation.

Volumes are integers from 0 to 100; Sonos may clamp clip volume to its own audible limits. Active hours include the start and exclude the end. Omit `active` for all-day announcements. Overnight windows such as `start: 22, end: 7` are supported; `end: 24` means the end of the day. Equal start and end hours are rejected. Scheduling uses `TIME_ZONE`, including daylight saving changes. Configuration changes require a restart.

The app subscribes to clip status before requesting playback, then waits for `DONE` for its own clip ID. An acknowledgement that a clip was scheduled is not treated as completed playback. `ERROR`, `DISMISSED` and `INTERRUPTED` are failures. A timeout or connection loss means completion is unknown; it does not cancel the speaker's clip. Commands are not automatically retried.

Protocol references: [Sonos audioClip](https://docs.sonos.com/reference/audioclip), [clip states](https://docs.sonos.com/reference/audioclip-parameters), and the [local WebSocket transport used by Home Assistant](https://github.com/jjlawren/sonos-websocket). The local transport is not the documented cloud HTTP API and may need adjustment after firmware changes.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `SONOS_HOSTS` | Unset: automatic discovery | Optional comma-separated speaker IP addresses or hostnames that override SSDP discovery; port defaults to 1443. |
| `SONOS_DISCOVERY_INTERFACE` | All IPv4 interfaces | Optional local interface IPv4 address for SSDP searches; this is the container/server address, not a speaker address. |
| `MEDIA_BASE_URL` | Unset: automatic addressing | Optional HTTP(S) override for NAT/proxy deployments. Otherwise use the app's local address on each speaker connection and the HTTP listening port. No credentials, query or fragment in an override. |
| `CLIP_FILE` | `./clips/doorbell.mp3` | Local MP3 path. The example environment uses `./clips/announce.mp3`. Must be non-empty, readable and at most 10 MiB. |
| `PORT` | `3000` | Listening port. Legacy `NODE_PORT` takes precedence. |
| `SPEAKERS_CONFIG` | `./config/speakers.yaml` | YAML configuration file. |
| `TIME_ZONE` | Process timezone | IANA timezone; the example uses `Europe/Brussels`. |
| `SONOS_REQUEST_TIMEOUT_MS` | `60000` | Total deadline for discovery, or for each target operation including playback completion. |
| `SHUTDOWN_TIMEOUT_MS` | Two operation timeouts + 5000 | Maximum shutdown drain time, default 125 seconds. |
| `ANNOUNCE_TOKEN` | Unset | Optional bearer token required for `/announce`. |

Use short MP3 clips and allow enough time for fetching and playback. Home Assistant and any reverse proxy must allow the HTTP request to wait for discovery and completion. Sonos must reach the app on its HTTP listening port (3000 by default), and the app must reach the speakers on TCP 1443. If a media override is configured, Sonos must reach that address instead. Automatic discovery additionally needs UDP searches to multicast `239.255.255.250:1900` or broadcast `255.255.255.255:1900`, with unicast responses allowed back to the app's ephemeral UDP ports. No inbound Sonos event callback ports are needed.

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

A speaker failure returns HTTP 502 and `success: false`, with a per-room `errors` array containing a `discovery` or `announcement` stage, a stable error `code` and a safe message. Other eligible rooms still run. If every room is outside active hours, the result is a successful no-op without contacting Sonos.

Overlapping requests share the current announcement and result; they do not queue another chime. Once it finishes, a new request starts a new announcement. A disconnected caller does not cancel the operation. Coalescing is local to one process; run one replica to avoid simultaneous playback commands from multiple instances.

`GET /health` returns 200 while accepting announcements and 503 while shutting down. It does not query speaker connectivity or represent the Home Assistant switch state. `HEAD /announce` and `OPTIONS /announce` return 204 without audio, other methods return 405, and subpaths return 404. Do not poll `GET /announce` for switch state.

With `ANNOUNCE_TOKEN`, add `Authorization: Bearer <token>` to the Home Assistant request. The clip itself is available without that header at a random `/clips/<token>.mp3` path supplied directly to Sonos. This path changes on restart; only the configured file is served, with byte-range support and no directory listing. The token is an unguessable URL, not user authentication. Restrict `/clips/` to the speaker network at your proxy if you do not want it internet-accessible. `/zones` is always absent.

## Error diagnosis

The HTTP response includes a short code and message. Logs also include the affected room, operation, speaker address and applicable system/Sonos error code or HTTP handshake status. Raw response bodies, WebSocket close reasons, media URLs and credentials are not logged by the Sonos adapter. When all discovery seeds fail, the log retains each seed's individual failure.

| Code | Meaning |
| --- | --- |
| `CONNECTION_FAILED` | Could not establish a connection; logs may include an OS code such as `ECONNREFUSED`. |
| `HANDSHAKE_REJECTED` | The speaker rejected the WebSocket upgrade; logs include the HTTP status. |
| `CONNECTION_CLOSED` | The established connection failed or closed before completion. |
| `TIMEOUT` | A connection or command exceeded its deadline; logs identify the phase and pending command. |
| `COMMAND_REJECTED` | Sonos rejected a command; a safe Sonos error code is retained when supplied. |
| `PROTOCOL_ERROR` | A message, command response or clip status was invalid. |
| `DISCOVERY_FAILED` | Network discovery found no reachable players, or all configured/cached/discovered addresses failed. Check network attachment and SSDP reachability. |
| `PLAYER_NOT_FOUND` | The target UUID was missing, ambiguous or no longer matched the address. |
| `UNSUPPORTED_PLAYER` | The target does not advertise `AUDIO_CLIP`. |
| `MEDIA_ADDRESS_UNAVAILABLE` | The connection did not provide a usable local IP address for serving the MP3. No playback command is sent. |
| `CLIP_FAILED` | Sonos reported `ERROR`, `DISMISSED` or `INTERRUPTED`. |
| `CLIP_TIMEOUT` | Sonos acknowledged the clip but did not confirm completion before the deadline. |
| `UNEXPECTED_ERROR` | An unexpected application failure occurred during the speaker operation. |

Timeouts and connection loss never trigger an automatic replay: the clip might already have started. A `CLIP_TIMEOUT` does not mean Sonos stopped playing.

## Migration from sonos-api

The existing Home Assistant `/announce` integration can remain. Update the container configuration before replacing the old image:

1. Preserve the current MP3. On your Docker host, the current source is `sonos-api:/app/static/clips/announce.mp3`. Reuse its existing clips volume as a read-only mount in the new container, or copy it:

   ```sh
   mkdir -p clips
   docker cp sonos-api:/app/static/clips/announce.mp3 ./clips/announce.mp3
   ```

2. Mount the clips directory at `/usr/src/app/clips` and set `CLIP_FILE=./clips/announce.mp3`. Attach the container to the speaker network as described below; speaker discovery and the MP3 URL are automatic. Alternatively, set `SONOS_HOSTS=10.1.60.156,10.1.60.216` when multicast/broadcast is unavailable. A media override is only needed if your deployment requires address/port translation.
3. Replace room-name-only configuration with the UUID mapping above. Remove `SONOS_HTTP_SERVER`, `CLIP` and `RESTORE_MODE`; they are no longer used.
4. Deploy, check `/health`, and run `docker exec sonos-announcer node speakers.js`. Then check a real announcement with music/TV playing and while paused, including any usual speaker groups.
5. Remove the old sonos-api service only after that check and after confirming nothing else uses it.

## GitHub Container Registry and releases

The GitHub Actions workflow builds **`linux/amd64`** images and publishes them to:

```text
ghcr.io/laurensvandeput/sonos-announcer
```

Every push and manual workflow run first runs lint, compilation and the complete test suite. Publishing starts only after those checks pass. Pull requests run the checks without publishing an image. Builds use GitHub's native AMD64 runner and Buildx; no QEMU is needed in CI.

| Trigger | Published tags |
| --- | --- |
| Push to `master` | `latest`, `branch-master`, `sha-<full-commit-sha>` |
| Push to another branch | `branch-<sanitized-branch-name>`, `sha-<full-commit-sha>` |
| Push a version tag such as `v1.0.0` | `1.0.0`, `sha-<full-commit-sha>` |
| Push a prerelease tag such as `v1.1.0-beta.1` | `1.1.0-beta.1`, `sha-<full-commit-sha>` |
| Manual run | Tags for the selected branch or version tag, as above |

The current development branch publishes `branch-codex-native-sonos-announcements`. Only `master` updates `latest`; version tags and development branches leave it unchanged. For a deployment you want to reproduce exactly, use the image digest shown in the workflow's build summary (`ghcr.io/laurensvandeput/sonos-announcer@sha256:...`). Branch tags and `latest` move as new builds complete.

To publish a version after merging and testing the desired commit:

```sh
git switch master
git pull --ff-only
git tag v1.0.0
git push origin v1.0.0
```

Choose a new version number for each release. There is no need to create a GitHub Release object; pushing the version tag triggers publication. Existing Docker Hub publishing and its secrets are no longer used by this workflow.

The workflow authenticates with the automatic `GITHUB_TOKEN`, with `packages: write` scoped to the publishing job. No additional publishing token is required. A newly published GHCR package is private by default. To pull it without credentials, change its visibility to public in the package settings. For private packages, authenticate your Docker server or Portainer registry with a GitHub personal access token (classic) that has `read:packages` and access to this package. See [GitHub's Container registry authentication guide](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-to-the-container-registry).

```sh
# For a private package, enter your read:packages token at the password prompt.
docker login ghcr.io --username laurensvandeput
```

If the package name already exists, ensure this repository has Actions access in the package settings. The image's source label connects new packages to this repository. See [GitHub's publishing guide](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images#publishing-images-to-github-packages).

## Running the image on your Docker server

Keep `.env`, `config/speakers.yaml` and `clips/announce.mp3` on the server, using the migration instructions above. With a direct connection to the speaker network, leave `MEDIA_BASE_URL` unset; the app derives its internal media address automatically.

### Docker networking for automatic discovery

The container must receive discovery responses from the speaker network. A Docker bridge with a published HTTP port alone does not provide this. On a Linux server directly connected to the speaker LAN, [host networking](https://docs.docker.com/engine/network/drivers/host/) is one option: use `--network host` instead of `-p 3000:3000`. Host networking does not by itself bridge separate VLANs.

On the existing Portainer server, `sonos-api` has an additional connection to the **`home_sonos_iot` IPvlan network**, with address `10.1.60.250`. The announcer currently has only `proxy` and `home_sonos_internal`. To use automatic discovery there, attach `sonos-announcer` to `home_sonos_iot` as well, with its own free address reserved for the container. Keep `proxy` for reverse-proxy access and select `proxy` explicitly in Traefik's Docker network setting if needed. Do not reuse `10.1.60.250` while `sonos-api` is still running. Add the attachment to the Portainer stack definition so it survives redeployment.

For example, merge the following network settings into your existing Compose service, retaining its image, environment, volumes and labels:

```yaml
services:
  sonos-announcer:
    networks:
      proxy: {}
      sonos_iot:
        ipv4_address: ${SONOS_ANNOUNCER_IP:?Set a free reserved address on the Sonos IoT subnet}

networks:
  proxy:
    external: true
    name: proxy
  sonos_iot:
    external: true
    name: home_sonos_iot
```

`SONOS_ANNOUNCER_IP` is the container's own address, managed by Docker; it does not need to be copied into an application URL setting. No `SONOS_HOSTS` or `MEDIA_BASE_URL` is needed with this direct network attachment. You can retain `home_sonos_internal` if another service still needs it. A working multicast relay is another option for separate networks; if discovery cannot be enabled, explicit `SONOS_HOSTS` still works over routed TCP connections. In all cases, allow the speakers to reach the app's HTTP port for MP3 downloads.

### Starting the container

For a published version on a Linux server directly connected to the speaker LAN (replace `1.0.0` with your version; use the IPvlan attachment above for the existing Portainer server):

```sh
docker pull --platform linux/amd64 ghcr.io/laurensvandeput/sonos-announcer:1.0.0
docker run --name sonos-announcer --restart unless-stopped \
  --platform linux/amd64 \
  --stop-timeout 130 \
  --env-file .env \
  --network host \
  --mount type=bind,src="$(pwd)/config",dst=/usr/src/app/config,readonly \
  --mount type=bind,src="$(pwd)/clips",dst=/usr/src/app/clips,readonly \
  ghcr.io/laurensvandeput/sonos-announcer:1.0.0
```

To try the current development branch, use `ghcr.io/laurensvandeput/sonos-announcer:branch-codex-native-sonos-announcements` instead. `latest` becomes available after the workflow runs successfully on `master`.

In Portainer, configure a `ghcr.io` registry with the credentials above if the package is private, then use the desired full image reference in your existing container or stack. Preserve the required environment variables, port and read-only mounts. Pull/redeploy the container to use the new image; pulling alone does not replace a running container. The workflow publishes images and does not deploy to your server.

The image runs as the unprivileged `node` user, so mounted files must be readable by that user. With host networking, ensure `PORT`/`NODE_PORT` is free on the host; port publishing is unnecessary. If using a bridge with explicit `SONOS_HOSTS`, use `-p 3000:3000` instead and adjust it when overriding the listening port. For a local build, run `docker build --platform linux/amd64 -t sonos-announcer .`.

SIGINT, SIGTERM and SIGQUIT reject new announcements and wait for active clips, while keeping the MP3 available for the speakers. Docker's stop timeout must exceed `SHUTDOWN_TIMEOUT_MS`; 130 seconds covers the default 125 seconds.

## Code structure

The application stays on TypeScript, Node.js and Express. The Sonos adapter uses `ws` directly, without a separate Sonos service or SDK.

| Module | Responsibility |
| --- | --- |
| `Service/Announce.service.ts` | Schedules, target selection, concurrent-request coalescing and per-speaker results. |
| `Sonos/Client.ts` | Discovery failover, connection lifetime and checking the selected target before playback. |
| `Sonos/Ssdp.ts` | Bounded multicast/broadcast discovery, response validation and UDP socket cleanup. |
| `Sonos/Session.ts` | WebSocket transport, the OS-selected local connection address, request/response correlation, generic event buffering and deadlines. |
| `Sonos/Protocol.ts` | Typed wire envelopes and runtime validation. |
| `Sonos/Players.ts` | Player identity, addresses, capabilities and isolation of malformed descriptions. |
| `Sonos/AudioClip.ts` | Clip subscription, loading and completion/error states. |
| `Sonos/Errors.ts` | Stable error codes and sanitized diagnostics. |
| `app.ts`, `Media/Clip.ts` | HTTP routes, authorization, automatic media URL construction and serving the configured MP3. |
| `Config/*`, `index.ts` | Configuration, dependency wiring and process shutdown. |

## Development and checks

- `npm start`: watch and run the TypeScript application.
- `npm run build`: compile production JavaScript with strict type checking.
- `npm run lint`: lint application source.
- `npm test`: build and run the Node test suite.
- `npm run test:watch`: watch source-based tests. Build first; process tests exercise the compiled entry point.
- `npm run speakers`: read-only discovery.

Tests use simulated speakers over local TLS WebSockets, UDP discovery responders and loopback HTTP servers. They cover automatic discovery, changed addresses, UDP retries/cancellation, startup without seed addresses or a media URL, automatic media downloads independent of proxy headers, UUID identity, rename handling, capability checks, malformed/duplicate player isolation, discovery failover, handshake/command diagnostics, clip completion and errors, concurrency, schedules, media downloads, authentication and shutdown. The certificate/key in `test/fixtures` is a public test fixture, never used by the application. No real audio is played by tests.

CI runs lint, build and tests for pull requests, branch/version-tag pushes and manual runs. Successful push/manual runs then publish an AMD64 image to GHCR using the tags described above.
