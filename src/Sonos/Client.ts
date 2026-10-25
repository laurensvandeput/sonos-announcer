import { SonosGateway, SonosPlayer } from '../types';
import { playAudioClip } from './AudioClip';
import { errorDiagnostic, SonosError } from './Errors';
import { parsePlayers, speakerUrl } from './Players';
import { Session } from './Session';

interface Diagnostics { warn(message: string, details: unknown): void }

export class SonosClient implements SonosGateway {
  private readonly urls: string[];

  constructor(urls: string[], private readonly timeoutMs = 60_000, private readonly logger?: Diagnostics) {
    // Validate every seed before opening any connection, so invalid configuration
    // cannot leave already-created sockets outside the cleanup path.
    this.urls = [...new Set(urls.map(speakerUrl))];
    if (!this.urls.length) throw new SonosError('DISCOVERY_FAILED', 'No Sonos discovery addresses configured.');
  }

  async discover(): Promise<SonosPlayer[]> {
    const sessions: Session[] = [];
    try {
      return await Promise.any(this.urls.map(async url => {
        const session = new Session(url, this.timeoutMs);
        sessions.push(session);
        try {
          await session.open();
          return await this.readPlayers(session);
        } catch (error) {
          // Losing connections are intentionally closed after the first success.
          if (!(error instanceof SonosError && error.code === 'SESSION_CLOSED')) {
            this.logger?.warn('Sonos discovery seed failed.', { host: new URL(url).host, ...errorDiagnostic(error) });
          }
          throw error;
        }
      }));
    } catch (error) {
      const failures: unknown[] = error instanceof AggregateError ? error.errors : [];
      throw new SonosError('DISCOVERY_FAILED', 'Could not discover Sonos players through any configured SONOS_HOSTS address.', {
        attempts: this.urls.map((url, index) => {
          const failure = failures[index];
          return { host: new URL(url).host, code: failure instanceof SonosError ? failure.code : 'CONNECTION_FAILED',
            details: failure instanceof SonosError ? failure.details : {} };
        }),
      }, { cause: error });
    } finally {
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
