export interface Speakers {
  [speaker: string]: Speaker;
}

export interface Speaker {
  volume: number;
  active?: {
    start?: number;
    end?: number;
  }
}

export interface SpeakerState {
  zone: string;
  volume: number;
  uri: string;
  playbackState: string;
}

export interface SpeakerPreset {
  zone: string;
  preset: {
    players: [
      {
        roomName: string;
        volume: number
      }
    ];
    uri: string;
  };
}

export enum PlaybackState {
  PLAYING = 'PLAYING'
}

export enum ResponseStatus {
  SUCCESS = 'success',
  ERROR = 'error'
}
