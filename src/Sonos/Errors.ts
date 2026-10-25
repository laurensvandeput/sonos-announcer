import { isRecord } from '../validation';

export type SonosErrorCode = 'CONNECTION_FAILED' | 'HANDSHAKE_REJECTED' | 'CONNECTION_CLOSED' |
  'TIMEOUT' | 'PROTOCOL_ERROR' | 'COMMAND_REJECTED' | 'DISCOVERY_FAILED' | 'PLAYER_NOT_FOUND' |
  'UNSUPPORTED_PLAYER' | 'CLIP_FAILED' | 'CLIP_TIMEOUT' | 'SESSION_CLOSED' | 'INVALID_STATE';

export interface ErrorDetails {
  host?: string;
  phase?: 'connect' | 'command' | 'event';
  command?: string;
  namespace?: string;
  httpStatus?: number;
  systemCode?: string;
  closeCode?: number;
  sonosCode?: string;
  clipStatus?: string;
  playerId?: string;
  attempts?: { host: string; code: SonosErrorCode; details: ErrorDetails }[];
}

export class SonosError extends Error {
  constructor(readonly code: SonosErrorCode, message: string, readonly details: ErrorDetails = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SonosError';
  }
}

// Only machine-readable codes are retained from external errors. Never log raw
// response bodies, close reasons, stream URLs or authorization headers.
export function safeErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/u.test(value) ? value : undefined;
}

export function systemErrorCode(error: unknown): string | undefined {
  return isRecord(error) ? safeErrorCode(error.code) : undefined;
}

export function errorDiagnostic(error: unknown): { code: string; message: string; details?: ErrorDetails } {
  return error instanceof SonosError
    ? { code: error.code, message: error.message, details: error.details }
    : { code: 'UNEXPECTED_ERROR', message: 'Unexpected speaker operation failure.' };
}
