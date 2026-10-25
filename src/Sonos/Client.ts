import { SonosGateway, SonosPlayer } from '../types';
import { playAudioClip } from './AudioClip';
import { ErrorDetails, errorDiagnostic, SonosError } from './Errors';
import { parsePlayers, speakerUrl } from './Players';
import { Session } from './Session';
import { DiscoverySearch, searchSonos } from './Ssdp';

interface Diagnostics { warn(message: string, details: unknown): void }
interface DiscoverySettings { interfaceAddress?: string; search?: DiscoverySearch }

export class SonosClient implements SonosGateway {
  private readonly urls: string[];
  private cachedUrls: string[] = [];

  constructor(urls: string[] = [], private readonly timeoutMs = 60_000, private readonly logger?: Diagnostics,
    private readonly discovery: DiscoverySettings = {}) {
    // Validate every seed before opening any connection, so invalid configuration
    // cannot leave already-created sockets outside the cleanup path.
    this.urls = [...new Set(urls.map(speakerUrl))];
  }

  async discover(): Promise<SonosPlayer[]> {
    const sessions: Session[] = [];
    const controller = new AbortController();
    const automatic = !this.urls.length;
    const deadline = performance.now() + this.timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    try {
      return await new Promise<SonosPlayer[]>((resolve, reject) => {
        const attempts = new Map<string, NonNullable<ErrorDetails['attempts']>[number]>();
        let pending = 0;
        let searching = automatic;
        const fail = () => {
          if (settled) return;
          settled = true;
          reject(new SonosError('DISCOVERY_FAILED', automatic
            ? 'No reachable Sonos players found. Check Docker networking and SSDP multicast/broadcast, or set SONOS_HOSTS.'
            : 'Could not discover Sonos players through any configured SONOS_HOSTS address.',
          { attempts: [...attempts.values()] }));
        };
        const checkFinished = () => { if (!searching && !pending) fail(); };
        const connect = (address: string) => {
          if (settled || attempts.has(address) || attempts.size >= 32) return;
          const url = speakerUrl(address);
          const host = new URL(url).host;
          attempts.set(url, { host, code: 'TIMEOUT', details: {} });
          pending++;
          const session = new Session(url, Math.max(1, deadline - performance.now()));
          sessions.push(session);
          void session.open().then(() => this.readPlayers(session)).then(players => {
            if (settled) return;
            settled = true;
            // Reuse addresses for low latency, but always refresh the topology.
            // A concurrent SSDP search handles DHCP changes and offline seeds.
            if (automatic) this.cachedUrls = [...new Set([url, ...players.map(player => player.websocketUrl)])].slice(0, 16);
            resolve(players);
          }).catch(error => {
            if (settled) return;
            attempts.set(url, { host, code: error instanceof SonosError ? error.code : 'CONNECTION_FAILED',
              details: error instanceof SonosError ? error.details : {} });
            this.logger?.warn('Sonos discovery seed failed.', { host, ...errorDiagnostic(error) });
          }).finally(() => {
            pending--;
            session.close();
            checkFinished();
          });
        };
        timer = setTimeout(fail, this.timeoutMs);
        for (const url of automatic ? this.cachedUrls : this.urls) connect(url);
        if (automatic) {
          void (this.discovery.search || searchSonos)({
            timeoutMs: Math.min(3000, this.timeoutMs), signal: controller.signal,
            interfaceAddress: this.discovery.interfaceAddress, onAddress: connect,
          }).catch(error => {
            if (!settled) this.logger?.warn('Sonos network discovery failed.', errorDiagnostic(error));
          }).finally(() => { searching = false; checkFinished(); });
        } else checkFinished();
      });
    } finally {
      settled = true;
      clearTimeout(timer);
      controller.abort();
      for (const session of sessions) session.close();
    }
  }

  async sendAnnouncement(player: SonosPlayer, volume: number, clipUrl: string): Promise<void> {
    const url = speakerUrl(player.websocketUrl);
    const session = new Session(url, this.timeoutMs);
    try {
      await session.open();
      const candidates = (await this.readPlayers(session)).filter(candidate => candidate.id === player.id && candidate.websocketUrl === url);
      if (candidates.length !== 1) throw new SonosError('PLAYER_NOT_FOUND', 'Speaker address no longer matches the configured UUID.');
      const current = candidates[0];
      if (!current.supportsAudioClip) throw new SonosError('UNSUPPORTED_PLAYER', 'Speaker does not support AUDIO_CLIP.');
      await playAudioClip(session, current, volume, clipUrl);
    } finally {
      session.close();
    }
  }

  private async readPlayers(session: Session): Promise<SonosPlayer[]> {
    const identity = await session.command({});
    const householdId = identity.header.householdId;
    if (!householdId) throw new SonosError('PROTOCOL_ERROR', 'Sonos did not identify its household.');
    const { body } = await session.command({ namespace: 'groups:1', command: 'getGroups', householdId });
    const { players, issues } = parsePlayers(body, householdId);
    for (const issue of issues) this.logger?.warn('Ignoring unusable Sonos player description.', issue);
    if (!players.length) throw new SonosError('PROTOCOL_ERROR', 'Sonos returned no usable player descriptions.');
    return players;
  }
}
