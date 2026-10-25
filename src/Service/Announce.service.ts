import { isActiveAtHour, SpeakerConfig } from '../Config/SpeakerConfig';
import { AnnouncementResult, AnnouncementStage, Logger, SonosGateway, SonosPlayer, SpeakerResult } from '../types';

export class ShuttingDownError extends Error {}

export class AnnounceService {
  private inFlight?: Promise<AnnouncementResult>;
  private stopping = false;
  private readonly hourFormatter: Intl.DateTimeFormat;

  constructor(
    private readonly client: SonosGateway,
    private readonly config: SpeakerConfig,
    private readonly clip: string,
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
        let player: SonosPlayer | undefined;
        await this.attempt(result, 'discovery', async () => {
          const matches = (await discovery).filter(candidate => candidate.id === speaker.uuid);
          if (matches.length !== 1) throw new Error('Configured speaker UUID was not uniquely found.');
          player = matches[0];
          if (!player.supportsAudioClip) throw new Error('Speaker does not support AUDIO_CLIP.');
        });
        if (player && result.status !== 'failed') {
          const target = player;
          await this.attempt(result, 'announcement', () => this.client.sendAnnouncement(target, speaker.volume, this.clip));
        }
      }));
    }

    const outcome = { success: results.every(result => result.status !== 'failed'), speakers: results };
    this.logger.info('Announcement completed.', outcome);
    return outcome;
  }

  private async attempt(result: SpeakerResult, stage: AnnouncementStage, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Sonos error.';
      result.status = 'failed';
      (result.errors ??= []).push({ stage, message });
      this.logger.warn('Speaker operation failed.', { zone: result.zone, stage, message });
    }
  }
}
