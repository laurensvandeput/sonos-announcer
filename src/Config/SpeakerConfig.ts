import { Speaker } from '../types';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function isActiveAtHour(speaker: Speaker, hour: number): boolean {
  if (!speaker.active) return true;
  const { start, end } = speaker.active;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export class SpeakerConfig {
  private readonly speakers = new Map<string, Speaker>();

  constructor(config: unknown) {
    if (!isRecord(config) || !isRecord(config.speakers) || Object.keys(config.speakers).length === 0) {
      throw new Error('The configuration must contain a non-empty speakers mapping.');
    }

    const ids = new Set<string>();
    for (const [zone, value] of Object.entries(config.speakers)) {
      if (!zone.trim() || zone === '.' || zone === '..' || /[\u0000-\u001f\u007f]/u.test(zone)) {
        throw new Error('Speaker labels must be non-empty and contain no control characters.');
      }
      if (!isRecord(value) || !isIntegerInRange(value.volume, 0, 100)) {
        throw new Error("Speaker '" + zone + "' must have an integer volume between 0 and 100.");
      }
      if (typeof value.uuid !== 'string' || !/^RINCON_[A-F0-9]{12}\d{5}$/iu.test(value.uuid)) {
        throw new Error("Speaker '" + zone + "' must have a Sonos UUID, for example RINCON_347E5C8246BA01400.");
      }
      const uuid = value.uuid.toUpperCase();
      if (ids.has(uuid)) throw new Error('Each speaker UUID must appear only once.');
      ids.add(uuid);
      const speaker: Speaker = { uuid, volume: value.volume };
      if (value.active !== undefined) {
        const active = value.active;
        if (!isRecord(active) || !isIntegerInRange(active.start, 0, 23) ||
          !isIntegerInRange(active.end, 0, 24) || active.start === active.end) {
          throw new Error("Speaker '" + zone + "' needs distinct active.start (0–23) and active.end (0–24) hours.");
        }
        speaker.active = { start: active.start, end: active.end };
      }
      this.speakers.set(zone, speaker);
    }
  }

  getZones(): string[] {
    return [...this.speakers.keys()];
  }

  getConfig(zone: string): Speaker {
    const speaker = this.speakers.get(zone);
    if (!speaker) throw new Error("There is no configuration for '" + zone + "'.");
    return speaker;
  }
}
