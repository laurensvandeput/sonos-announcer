import { isRecord } from '../Config/SpeakerConfig';
import { SonosGateway, SonosPlayer } from '../types';
import { Session, SonosError } from './Session';

function speakerUrl(value: unknown): string {
  if (typeof value !== 'string') throw new SonosError('Sonos returned a missing speaker address.');
  const url = new URL(value);
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash || url.pathname !== '/websocket/api') {
    throw new SonosError('Sonos returned an invalid speaker address.');
  }
  return url.toString();
}

async function readPlayers(session: Session): Promise<SonosPlayer[]> {
  const identity = await session.command({});
  const householdId = identity.header.householdId;
  if (typeof householdId !== 'string' || !householdId) throw new SonosError('Sonos did not identify its household.');
  const { body } = await session.command({ namespace: 'groups:1', command: 'getGroups', householdId });
  if (!Array.isArray(body.players) || !body.players.length) throw new SonosError('Sonos returned no players.');
  return body.players.map(value => {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') {
      throw new SonosError('Sonos returned an invalid player.');
    }
    const hasCapability = (capabilities: unknown) => Array.isArray(capabilities) && capabilities.includes('AUDIO_CLIP');
    return {
      id: value.id.toUpperCase(), name: value.name, householdId, websocketUrl: speakerUrl(value.websocketUrl),
      supportsAudioClip: hasCapability(value.capabilities) || (Array.isArray(value.devices) && value.devices.some(device =>
        isRecord(device) && device.id === value.id && hasCapability(device.capabilities))),
    };
  });
}

export class SonosClient implements SonosGateway {
  constructor(private readonly urls: string[], private readonly timeoutMs = 60_000) {}

  async discover(): Promise<SonosPlayer[]> {
    const sessions = this.urls.map(url => new Session(speakerUrl(url), this.timeoutMs));
    try {
      // A sleeping/offline seed must not delay the doorbell on available speakers.
      return await Promise.any(sessions.map(async session => { await session.open(); return readPlayers(session); }));
    } catch {
      throw new SonosError('Could not discover Sonos players through any configured SONOS_HOSTS address.');
    } finally {
      for (const session of sessions) session.close();
    }
  }

  async sendAnnouncement(player: SonosPlayer, volume: number, clipUrl: string): Promise<void> {
    const url = speakerUrl(player.websocketUrl);
    const session = new Session(url, this.timeoutMs);
    try {
      await session.open();
      // Check identity at the current address before sending any playback command.
      const current = (await readPlayers(session)).find(candidate => candidate.id === player.id && candidate.websocketUrl === url);
      if (!current) throw new SonosError('Speaker address no longer matches the configured UUID.');
      if (!current.supportsAudioClip) throw new SonosError('Speaker does not support AUDIO_CLIP.');
      const target = { namespace: 'audioClip:1', playerId: current.id, householdId: current.householdId };
      await session.command({ ...target, command: 'subscribe' });
      const { body } = await session.command({ ...target, command: 'loadAudioClip' }, {
        name: 'Visitor announcement', appId: 'com.syncleon.sonos-announcer',
        streamUrl: clipUrl, volume, priority: 'LOW',
      });
      if (typeof body.id !== 'string' || !body.id) {
        throw new SonosError('Sonos did not return an audio clip ID; playback completion is unknown.');
      }
      const id = body.id;
      // Subscribe before loading and keep early events: very short clips can end
      // before the command acknowledgement arrives. Other apps' clips are ignored.
      for (;;) {
        const event = await session.nextEvent();
        if (event.header.namespace !== 'audioClip:1' && event.header.namespace !== 'audioClip') continue;
        if (event.header.playerId !== current.id || !Array.isArray(event.body.audioClips)) continue;
        const clip = event.body.audioClips.find(value => isRecord(value) && value.id === id);
        if (!isRecord(clip)) continue;
        if (clip.status === 'DONE') return;
        if (['ERROR', 'DISMISSED', 'INTERRUPTED'].includes(String(clip.status))) {
          throw new SonosError('Sonos audio clip ended with status ' + String(clip.status) + '.');
        }
      }
    } finally {
      session.close();
    }
  }
}
