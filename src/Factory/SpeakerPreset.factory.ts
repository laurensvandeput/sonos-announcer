import { SpeakerPreset, SpeakerState } from '../types';

export class SpeakerPresetFactory {

  static fromSpeakerState(state: SpeakerState): SpeakerPreset {
    return {
      zone: state.zone,
      preset: {
        players: [
          {
            roomName: state.zone,
            volume: state.volume
          }
        ],
        uri: state.uri
      }
    } as SpeakerPreset;
  }

}
