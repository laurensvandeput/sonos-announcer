import { isRecord } from '../validation';
import { SonosError } from './Errors';

export interface CommandHeader {
  namespace: string;
  command: string;
  householdId?: string;
  playerId?: string;
}

// An empty command is the local API's household identity handshake.
export type RequestHeader = CommandHeader | { namespace?: never; command?: never };

export interface MessageHeader {
  namespace: string;
  cmdId?: string;
  response?: string;
  name?: string;
  type?: string;
  householdId?: string;
  playerId?: string;
  success?: boolean;
  errorCode?: string;
}

export interface Message { header: MessageHeader; body: Record<string, unknown> }

export function parseMessage(text: string): Message {
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || value.length !== 2 || !isRecord(value[0]) || !isRecord(value[1])) throw new Error();
    const source = value[0];
    if (typeof source.namespace !== 'string' || !source.namespace) throw new Error();
    const header: MessageHeader = { namespace: source.namespace };
    for (const key of ['cmdId', 'response', 'name', 'type', 'householdId', 'playerId', 'errorCode'] as const) {
      if (source[key] !== undefined) {
        if (typeof source[key] !== 'string') throw new Error();
        header[key] = source[key];
      }
    }
    if (source.success !== undefined) {
      if (typeof source.success !== 'boolean') throw new Error();
      header.success = source.success;
    }
    return { header, body: value[1] };
  } catch {
    throw new SonosError('PROTOCOL_ERROR', 'Sonos returned an invalid protocol message.');
  }
}

export function isEvent(header: MessageHeader): boolean {
  return header.response === undefined && header.cmdId === undefined &&
    (header.name !== undefined || header.type !== undefined);
}
