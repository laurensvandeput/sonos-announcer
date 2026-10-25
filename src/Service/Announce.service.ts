import { isActiveAtHour, SpeakerConfig } from '../Config/SpeakerConfig';
import { AnnouncementMedia, AnnouncementResult, AnnouncementStage, Logger, SonosGateway, SonosPlayer, SpeakerResult } from '../types';
import { errorDiagnostic, SonosError } from '../Sonos/Errors';

export class ShuttingDownError extends Error {}

export class AnnounceService {
  private inFlight?: Promise<AnnouncementResult>;
  private stopping = false;
  private readonly hourFormatter: Intl.DateTimeFormat;

  constructor(
    private readonly client: SonosGateway,
    private readonly config: SpeakerConfig,
    private readonly clip: AnnouncementMedia,
    private readonly logger: Logger,
    timeZone: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.hourFormatter = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' });
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  announce(): Promise<AnnouncementResult> {
    if (this.stopping) return Promise.reject(new ShuttingDownError('The service is shutting down.'));
    if (!this.inFlight) {
      this.inFlight = Promise.resolve().then(() => this.run()).finally(() => { this.inFlight = undefined; });
    }
    return this.inFlight;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.inFlight;
  }

  private async run(): Promise<AnnouncementResult> {
    const hour = Number(this.hourFormatter.format(this.now()));
    const results: SpeakerResult[] = this.config.getZones().map(zone =>
      isActiveAtHour(this.config.getConfig(zone), hour)
        ? { zone, status: 'announced' }
        : { zone, status: 'skipped', reason: 'outside_active_hours' });
    const active = results.filter(result => result.status !== 'skipped');
    this.logger.info('Starting announcement.', { rooms: active.map(result => result.zone) });

    if (active.length) {
      // Refresh discovery each time to follow speaker name and IP changes.
      const discovery = this.client.discover();
      await Promise.all(active.map(async result => {
        const speaker = this.config.getConfig(result.zone);
        const player = await this.attempt<SonosPlayer>(result, 'discovery', async () => {
          const matches = (await discovery).filter(candidate => candidate.id === speaker.uuid);
          if (matches.length !== 1) throw new SonosError('PLAYER_NOT_FOUND', 'Configured speaker UUID was not uniquely found.');
          const player = matches[0];
          if (!player.supportsAudioClip) throw new SonosError('UNSUPPORTED_PLAYER', 'Speaker does not support AUDIO_CLIP.');
          return player;
        });
        if (player) {
          await this.attempt(result, 'announcement', () => this.client.sendAnnouncement(player, speaker.volume, this.clip));
        }
      }));
    }

    const outcome = { success: results.every(result => result.status !== 'failed'), speakers: results };
    this.logger.info('Announcement completed.', outcome);
    return outcome;
  }

  private async attempt<T>(result: SpeakerResult, stage: AnnouncementStage, action: () => Promise<T>): Promise<T | undefined> {
    try {
      return await action();
    } catch (error) {
      const diagnostic = errorDiagnostic(error);
      result.status = 'failed';
      (result.errors ??= []).push({ stage, code: diagnostic.code, message: diagnostic.message });
      this.logger.warn('Speaker operation failed.', { zone: result.zone, stage, ...diagnostic });
      return undefined;
    }
  }
}
