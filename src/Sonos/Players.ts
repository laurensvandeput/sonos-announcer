import { SonosPlayer } from '../types';
import { isRecord } from '../validation';
import { SonosError } from './Errors';

export function normalizePlayerId(value: unknown): string | undefined {
  return typeof value === 'string' && /^RINCON_[A-F0-9]{12}\d{5}$/iu.test(value) ? value.toUpperCase() : undefined;
}

export function speakerUrl(value: unknown): string {
  try {
    if (typeof value !== 'string') throw new Error();
    const url = new URL(value);
    if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash || url.pathname !== '/websocket/api') throw new Error();
    return url.toString();
  } catch {
    throw new SonosError('PROTOCOL_ERROR', 'Sonos returned an invalid speaker address.');
  }
}

export interface PlayerIssue {
  index: number;
  playerId?: string;
  reason: 'invalid_id' | 'duplicate_id' | 'invalid_address' | 'invalid_capabilities';
}

export function parsePlayers(body: Record<string, unknown>, householdId: string): { players: SonosPlayer[]; issues: PlayerIssue[] } {
  if (!Array.isArray(body.players) || !body.players.length) {
    throw new SonosError('PROTOCOL_ERROR', 'Sonos returned no player descriptions.');
  }
  const counts = new Map<string, number>();
  for (const value of body.players) {
    const id = isRecord(value) ? normalizePlayerId(value.id) : undefined;
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const players: SonosPlayer[] = [];
  const issues: PlayerIssue[] = [];
  body.players.forEach((value: unknown, index: number) => {
    const id = isRecord(value) ? normalizePlayerId(value.id) : undefined;
    if (!isRecord(value) || !id) { issues.push({ index, reason: 'invalid_id' }); return; }
    if (counts.get(id) !== 1) { issues.push({ index, playerId: id, reason: 'duplicate_id' }); return; }
    let websocketUrl: string;
    try { websocketUrl = speakerUrl(value.websocketUrl); }
    catch { issues.push({ index, playerId: id, reason: 'invalid_address' }); return; }
    const capabilities = value.capabilities;
    const device = Array.isArray(value.devices) ? value.devices.find(item =>
      isRecord(item) && normalizePlayerId(item.id) === id) : undefined;
    const deviceCapabilities: unknown = isRecord(device) ? device.capabilities : undefined;
    const validCapabilities = (input: unknown): input is string[] => Array.isArray(input) && input.every(item => typeof item === 'string');
    if (!validCapabilities(capabilities) && !validCapabilities(deviceCapabilities)) {
      issues.push({ index, playerId: id, reason: 'invalid_capabilities' }); return;
    }
    players.push({
      id, householdId, websocketUrl,
      // A missing display name must not affect selection by physical identity.
      name: typeof value.name === 'string' && value.name.trim() ? value.name : id,
      supportsAudioClip: (validCapabilities(capabilities) && capabilities.includes('AUDIO_CLIP')) ||
        (validCapabilities(deviceCapabilities) && deviceCapabilities.includes('AUDIO_CLIP')),
    });
  });
  return { players, issues };
}
