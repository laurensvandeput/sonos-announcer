import { SpeakerPreset, Speakers } from '../types';

export class SpeakerConfig {
  private readonly config: Speakers;

  constructor(config: any) {
    if (!(config && 'speakers' in config)) {
      throw new Error('The configuration YAML is invalid.');
    }

    this.config = config.speakers as Speakers;
  }

  public getSpeakers(): string[] {
    return Object.keys(this.config);
  }

  public getConfig(speaker: string): SpeakerPreset {
    if (!(speaker in this.config)) {
      throw new Error(`There is no configuration for '${speaker}'`);
    }

    return this.config[speaker];
  }
  
}
