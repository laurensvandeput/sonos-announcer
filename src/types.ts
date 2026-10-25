export interface Speaker {
  uuid: string;
  volume: number;
  active?: { start: number; end: number };
}

export interface SonosPlayer {
  id: string;
  name: string;
  householdId: string;
  websocketUrl: string;
  supportsAudioClip: boolean;
}

export interface SonosGateway {
  discover(): Promise<SonosPlayer[]>;
  sendAnnouncement(player: SonosPlayer, volume: number, clipUrl: string): Promise<void>;
}

export type AnnouncementStage = 'discovery' | 'announcement';

export interface SpeakerResult {
  zone: string;
  status: 'announced' | 'skipped' | 'failed';
  reason?: 'outside_active_hours';
  errors?: { stage: AnnouncementStage; message: string }[];
}

export interface AnnouncementResult {
  success: boolean;
  speakers: SpeakerResult[];
}

export type Logger = Pick<import('winston').Logger, 'info' | 'warn' | 'error'>;
