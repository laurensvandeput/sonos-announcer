import { SonosPlayer } from '../types';
import { isRecord } from '../validation';
import { safeErrorCode, SonosError } from './Errors';
import { Message } from './Protocol';
import { Session } from './Session';

type ClipState = 'PENDING' | 'ACTIVE' | 'DONE' | 'ERROR' | 'DISMISSED' | 'INTERRUPTED';
const states: readonly string[] = ['PENDING', 'ACTIVE', 'DONE', 'ERROR', 'DISMISSED', 'INTERRUPTED'];
interface ClipStatus { state: ClipState; sonosCode?: string }

function clipStatus(event: Message, playerId: string, clipId: string): ClipStatus | undefined {
  const { header, body } = event;
  if ((header.namespace !== 'audioClip:1' && header.namespace !== 'audioClip') ||
    (header.name !== 'audioClipStatus' && header.type !== 'audioClipStatus') || header.playerId !== playerId) return;
  if (!Array.isArray(body.audioClips)) throw new SonosError('PROTOCOL_ERROR', 'Sonos returned invalid audio clip status.');
  const clip = body.audioClips.find(value => isRecord(value) && value.id === clipId);
  if (!isRecord(clip)) return;
  if (typeof clip.status !== 'string' || !states.includes(clip.status)) {
    throw new SonosError('PROTOCOL_ERROR', 'Sonos returned an invalid state for the announcement clip.');
  }
  return { state: clip.status as ClipState, sonosCode: safeErrorCode(clip.errorCode) };
}

export async function playAudioClip(session: Session, player: SonosPlayer, volume: number, clipUrl: string): Promise<void> {
  const target = { namespace: 'audioClip:1', playerId: player.id, householdId: player.householdId };
  await session.command({ ...target, command: 'subscribe' });
  const { body } = await session.command({ ...target, command: 'loadAudioClip' }, {
    name: 'Visitor announcement', appId: 'com.syncleon.sonos-announcer',
    streamUrl: clipUrl, volume, priority: 'LOW',
  });
  if (typeof body.id !== 'string' || !body.id) {
    throw new SonosError('PROTOCOL_ERROR', 'Sonos did not return an audio clip ID; playback completion is unknown.');
  }
  // Subscription precedes playback; Session buffers events arriving before the
  // acknowledgement. Completion is tracked by clip ID, independently of other apps.
  try {
    for (;;) {
      const status = clipStatus(await session.nextEvent(), player.id, body.id);
      if (!status || status.state === 'PENDING' || status.state === 'ACTIVE') continue;
      if (status.state === 'DONE') return;
      throw new SonosError('CLIP_FAILED', 'Sonos audio clip ended with status ' + status.state + '.',
        { playerId: player.id, clipStatus: status.state, sonosCode: status.sonosCode });
    }
  } catch (error) {
    if (error instanceof SonosError && error.code === 'TIMEOUT') {
      throw new SonosError('CLIP_TIMEOUT', 'Sonos did not confirm clip completion before the deadline; playback completion is unknown.',
        { ...error.details, playerId: player.id }, { cause: error });
    }
    throw error;
  }
}
