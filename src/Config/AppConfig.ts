import { isIPv4 } from 'node:net';

export interface AppConfig {
  port: number;
  sonosUrls: string[];
  discoveryInterface?: string;
  clipFile: string;
  mediaBaseUrl?: string;
  speakersFile: string;
  timeZone: string;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
  announceToken?: string;
}

function positiveInteger(name: string, value: string, max = 600_000): number {
  const number = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(number) || number < 1 || number > max) {
    throw new Error(name + ' must be an integer between 1 and ' + max + '.');
  }
  return number;
}

export function readSonosUrls(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const hosts = (value || '').split(',').map(host => host.trim());
  let sonosUrls: string[];
  try {
    if (hosts.length > 16) throw new Error();
    sonosUrls = [...new Set(hosts.map(host => {
      if (!host || /[\s/@?#\\]/u.test(host)) throw new Error();
      const url = new URL('wss://' + host);
      if (!url.hostname || url.username || url.password) throw new Error();
      if (!url.port) url.port = '1443';
      url.pathname = '/websocket/api';
      return url.toString();
    }))];
  } catch {
    throw new Error('SONOS_HOSTS must contain 1–16 comma-separated speaker IP addresses or hostnames (optional :port).');
  }

  return sonosUrls;
}

export function readDiscoveryInterface(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  if (!isIPv4(value.trim())) throw new Error('SONOS_DISCOVERY_INTERFACE must be a local IPv4 address.');
  return value.trim();
}

export function readAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const sonosUrls = readSonosUrls(env.SONOS_HOSTS);
  let mediaBaseUrl: URL | undefined;
  try {
    if (env.MEDIA_BASE_URL?.trim()) {
      mediaBaseUrl = new URL(env.MEDIA_BASE_URL.trim());
      if (!['http:', 'https:'].includes(mediaBaseUrl.protocol) || mediaBaseUrl.username ||
        mediaBaseUrl.password || mediaBaseUrl.search || mediaBaseUrl.hash) throw new Error();
    }
  } catch {
    throw new Error('MEDIA_BASE_URL must be the HTTP(S) address of this app as reached by the speakers, without credentials, query or fragment.');
  }
  const clipFile = env.CLIP_FILE || './clips/doorbell.mp3';
  if (!/\.mp3$/iu.test(clipFile)) throw new Error('CLIP_FILE must be a local MP3 file path.');

  const timeZone = env.TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone }).format();
  } catch {
    throw new Error('TIME_ZONE must be a valid IANA timezone, for example Europe/Brussels.');
  }
  if (env.ANNOUNCE_TOKEN && env.ANNOUNCE_TOKEN.trim() !== env.ANNOUNCE_TOKEN) {
    throw new Error('ANNOUNCE_TOKEN must not contain leading or trailing whitespace.');
  }
  const requestTimeoutMs = positiveInteger('SONOS_REQUEST_TIMEOUT_MS', env.SONOS_REQUEST_TIMEOUT_MS || '60000');
  return {
    port: positiveInteger('PORT / NODE_PORT', env.NODE_PORT || env.PORT || '3000', 65535),
    sonosUrls,
    discoveryInterface: readDiscoveryInterface(env.SONOS_DISCOVERY_INTERFACE),
    clipFile,
    mediaBaseUrl: mediaBaseUrl?.toString().replace(/\/+$/u, ''),
    speakersFile: env.SPEAKERS_CONFIG || './config/speakers.yaml',
    timeZone,
    requestTimeoutMs,
    shutdownTimeoutMs: positiveInteger('SHUTDOWN_TIMEOUT_MS', env.SHUTDOWN_TIMEOUT_MS || String(requestTimeoutMs * 2 + 5000), 1_205_000),
    announceToken: env.ANNOUNCE_TOKEN || undefined,
  };
}
