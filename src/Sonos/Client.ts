import axios from 'axios';
import { Logger } from 'winston';
import { ResponseStatus, Speaker, SpeakerPreset, SpeakerState } from '../types';

export class SonosClient {

  constructor(private baseUrl: string, private logger: Logger) {
  }

  getSpeakerState(zone: string): Promise<SpeakerState> {
    return axios.get(`${this.baseUrl}/${zone}/state`)
      .then(response => {
        return {
          zone: zone,
          volume: response.data.volume,
          uri: response.data.currentTrack.uri,
          playbackState: response.data.playbackState,
        } as SpeakerState;
      })
      .catch(error => Promise.reject(error));
  }

  updateSpeakerState(speakerPreset: SpeakerPreset): Promise<boolean> {
    const json = JSON.stringify(speakerPreset.preset);

    return axios.get(`${this.baseUrl}/${speakerPreset.zone}/preset/${json}`)
      .then(response => response.data.status === ResponseStatus.SUCCESS)
      .catch(error => Promise.reject(error));
  }

  sendAnnouncement(zone: string, speaker: Speaker, clip: string): Promise<boolean> {
    return axios.get(`${this.baseUrl}/${zone}/clip/${clip}/${speaker.volume}`)
      .then(response => response.data.status === ResponseStatus.SUCCESS)
      .catch(error => Promise.reject(error));
  }

}
