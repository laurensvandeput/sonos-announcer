export interface Speakers {
  [speaker: string]: SpeakerPreset;
}

export interface SpeakerPreset {
  volume: number;
  active?: {
    start?: number;
    end?: number;
  }
}

export interface SpeakerState {
  zone: string;
  volume: number;
  uri: state;
  playbackState: string;
}
