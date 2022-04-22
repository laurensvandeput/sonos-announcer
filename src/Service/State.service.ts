import { SonosClient } from '../Sonos/Client';
import { Logger } from 'winston';
import { SpeakerConfig } from '../Config/SpeakerConfig';
import { SpeakerState } from '../types';

export class StateService {

  constructor(private client: SonosClient, private config: SpeakerConfig, private logger: Logger) {
  }

  getSpeakerStates(): Promise<Awaited<SpeakerState>[]> {
    const promises: Promise<SpeakerState>[] = [];

    this.config.getSpeakers().forEach(speaker => {
      promises.push(this.client.getState(speaker));
    });

    return Promise.all(promises);
  }

}
