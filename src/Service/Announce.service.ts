import { SonosClient } from '../Sonos/Client';
import { Logger } from 'winston';
import { SpeakerConfig } from '../Config/SpeakerConfig';

export class AnnounceService {

  constructor(private client: SonosClient, private config: SpeakerConfig, private clip: string, private logger: Logger) {
  }

  broadcast(): Promise<Awaited<boolean>[]> {
    const promises: Promise<boolean>[] = [];

    this.config.getZones().forEach(zone => {
      const speaker = this.config.getConfig(zone);
      const currentHour = new Date().getHours();

      if (speaker.active && !(currentHour >= speaker.active.start && currentHour < speaker.active.end)) {
        this.logger.info(`Ignoring ${zone}, ${currentHour} is not within ${speaker.active.start}-${speaker.active.end}`);
      } else {
        this.logger.info(`Triggering ${zone} with volume ${speaker.volume}`);
        promises.push(this.client.sendAnnouncement(zone, speaker, this.clip));
      }
    });

    return Promise.all(promises);
  }

}
