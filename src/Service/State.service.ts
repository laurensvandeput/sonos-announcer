import { SonosClient } from '../Sonos/Client';
import { Logger } from 'winston';
import { SpeakerConfig } from '../Config/SpeakerConfig';
import { PlaybackState, SpeakerState } from '../types';
import { SpeakerPresetFactory } from '../Factory/SpeakerPreset.factory';

export class StateService {

  constructor(private client: SonosClient, private config: SpeakerConfig, private logger: Logger) {
  }

  getSpeakerStates(): Promise<Awaited<SpeakerState>[]> {
    const promises: Promise<SpeakerState>[] = [];

    this.config.getZones().forEach(zone => {
      promises.push(this.client.getSpeakerState(zone));
    });

    return Promise.all(promises);
  }

  updateSpeakerStates(systemState: SpeakerState[]) {
    const promises: Promise<boolean>[] = [];

    systemState.forEach(state => {
      if (state.playbackState === PlaybackState.PLAYING) {
        promises.push(this.client.updateSpeakerState(SpeakerPresetFactory.fromSpeakerState(state)));
      }
    });

    return Promise.all(promises);
  }

}
