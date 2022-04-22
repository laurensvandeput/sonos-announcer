import axios from 'axios';
import { Logger } from 'winston';
import { SpeakerState } from '../types';

export class SonosClient {

  constructor(private baseUrl: string, private logger: Logger) {
  }

  getState(zone: string) {
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

}
