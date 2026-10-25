import { createSocket, Socket } from 'node:dgram';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { SonosError, systemErrorCode } from './Errors';
import { normalizePlayerId } from './Players';

const zonePlayer = 'urn:schemas-upnp-org:device:ZonePlayer:1';
const search = Buffer.from([
  'M-SEARCH * HTTP/1.1', 'HOST: 239.255.255.250:1900', 'MAN: "ssdp:discover"',
  'MX: 1', 'ST: ' + zonePlayer, '', '',
].join('\r\n'));

export interface DiscoveryOptions {
  timeoutMs: number;
  signal: AbortSignal;
  interfaceAddress?: string;
  onAddress(url: string): void;
}
export type DiscoverySearch = (options: DiscoveryOptions) => Promise<void>;

// Only the advertised address is used: no XML fetching or arbitrary URL requests.
export function ssdpSpeakerUrl(data: Buffer): string | undefined {
  if (data.length > 8192) return undefined;
  const [status, ...lines] = data.toString('utf8').split('\r\n');
  if (!/^HTTP\/1\.[01] 200(?: |$)/u.test(status)) return undefined;
  const headers = new Map<string, string>();
  for (const line of lines) {
    if (!line) break;
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (headers.has(key)) return undefined;
    headers.set(key, line.slice(colon + 1).trim());
  }
  if (headers.get('st') !== zonePlayer) return undefined;
  const id = headers.get('usn')?.match(/^uuid:(RINCON_[A-F0-9]+)(?:::.*)?$/iu)?.[1];
  if (!normalizePlayerId(id)) return undefined;
  try {
    const location = new URL(headers.get('location') || '');
    if (location.protocol !== 'http:' || !isIPv4(location.hostname) || location.username ||
      location.password || location.search || location.hash) return undefined;
    return `wss://${location.hostname}:1443/websocket/api`;
  } catch {
    return undefined;
  }
}

interface DiscoveryNetwork {
  addresses?: string[];
  destinations?: { address: string; port: number }[];
}

// Like node-sonos-discovery, search with both multicast and broadcast on each
// IPv4 interface. Ephemeral reply ports allow multiple instances to coexist.
export async function searchSonos(options: DiscoveryOptions, network: DiscoveryNetwork = {}): Promise<void> {
  if (options.signal.aborted) return;
  const addresses = options.interfaceAddress ? [options.interfaceAddress] : network.addresses || [
    '0.0.0.0', ...Object.values(networkInterfaces()).flatMap(entries =>
      (entries || []).filter(entry => entry.family === 'IPv4' && !entry.internal).map(entry => entry.address)),
  ];
  const destinations = network.destinations || [
    { address: '239.255.255.250', port: 1900 }, { address: '255.255.255.255', port: 1900 },
  ];
  const sockets = new Set<Socket>();
  const ready = new Set<Socket>();
  const seen = new Set<string>();
  const failures: unknown[] = [];
  let finished = false;
  let timer: NodeJS.Timeout;
  let retry: NodeJS.Timeout;

  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(retry);
      options.signal.removeEventListener('abort', finish);
      for (const socket of sockets) socket.close();
      if (!options.signal.aborted && !seen.size && !ready.size && failures.length) {
        reject(new SonosError('DISCOVERY_FAILED', 'Could not send Sonos discovery requests on the local network.',
          { systemCode: systemErrorCode(failures[0]) }));
      } else resolve();
    };
    const send = (socket: Socket) => {
      if (finished || !ready.has(socket)) return;
      for (const destination of destinations) {
        socket.send(search, destination.port, destination.address, error => {
          if (error) failures.push(error);
        });
      }
    };
    options.signal.addEventListener('abort', finish, { once: true });
    timer = setTimeout(finish, options.timeoutMs);
    retry = setInterval(() => { for (const socket of ready) send(socket); }, 1000);
    for (const address of new Set(addresses)) {
      const socket = createSocket('udp4');
      sockets.add(socket);
      socket.on('error', error => {
        failures.push(error);
        ready.delete(socket);
        if (sockets.delete(socket)) socket.close();
        if (!sockets.size) finish();
      });
      socket.on('message', data => {
        if (finished || seen.size >= 32) return;
        const url = ssdpSpeakerUrl(data);
        if (!url || seen.has(url)) return;
        seen.add(url);
        options.onAddress(url);
      });
      socket.bind(0, address, () => {
        if (finished) return;
        try {
          socket.setMulticastTTL(4);
          socket.setMulticastInterface(address);
          socket.setBroadcast(true);
          ready.add(socket);
          send(socket);
        } catch (error) {
          failures.push(error);
          if (sockets.delete(socket)) socket.close();
          if (!sockets.size) finish();
        }
      });
    }
  });
}
