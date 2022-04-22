import { Speaker, Speakers } from '../types';

export class SpeakerConfig {
  private readonly config: Speakers;

  constructor(config: any) {
    if (!(config && 'speakers' in config)) {
      throw new Error('The configuration YAML is invalid.');
    }

    this.config = config.speakers as Speakers;
  }

  public getZones(): string[] {
    return Object.keys(this.config);
  }

  public getConfig(speaker: string): Speaker {
    if (!(speaker in this.config)) {
      throw new Error(`There is no configuration for '${speaker}'`);
    }

    return this.config[speaker];
  }
  
}
