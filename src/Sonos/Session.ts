import WebSocket from 'ws';
import { ErrorDetails, safeErrorCode, SonosError, systemErrorCode } from './Errors';
import { isEvent, Message, parseMessage, RequestHeader } from './Protocol';

interface Waiter<T> { resolve(value: T): void; reject(error: Error): void }
interface PendingCommand extends Waiter<Message> { cmdId: string; header: RequestHeader }

// Owns connection lifetime, request correlation and generic event buffering.
// Player discovery and audio clip interpretation belong to separate modules.
export class Session {
  private readonly socket: WebSocket;
  private readonly deadline: NodeJS.Timeout;
  private readonly ready: Promise<void>;
  private readonly host: string;
  private openWaiter?: Waiter<void>;
  private pending?: PendingCommand;
  private eventWaiter?: Waiter<Message>;
  private readonly events: Message[] = [];
  private failure?: SonosError;
  private sequence = 0;
  private connected = false;

  constructor(url: string, timeoutMs: number) {
    this.host = new URL(url).host;
    this.ready = new Promise((resolve, reject) => { this.openWaiter = { resolve, reject }; });
    this.socket = new WebSocket(url, 'v1.api.smartspeaker.audio', {
      // Public placeholder also used by Home Assistant's local transport.
      headers: { 'X-Sonos-Api-Key': '123e4567-e89b-12d3-a456-426655440000' },
      rejectUnauthorized: false, // Local Sonos certificate only; never global TLS settings.
      followRedirects: false,
      perMessageDeflate: false,
      maxPayload: 512 * 1024,
    });
    this.deadline = setTimeout(() => this.fail(new SonosError('TIMEOUT',
      'Sonos operation timed out after ' + timeoutMs + ' ms.', this.context())), timeoutMs);
    this.socket.on('open', () => { this.connected = true; this.openWaiter?.resolve(); this.openWaiter = undefined; });
    this.socket.on('unexpected-response', (_request, response) => {
      this.fail(new SonosError('HANDSHAKE_REJECTED', 'Sonos rejected the WebSocket handshake.',
        { ...this.context(), httpStatus: response.statusCode }));
      response.destroy();
    });
    this.socket.on('error', error => this.fail(new SonosError(this.connected ? 'CONNECTION_CLOSED' : 'CONNECTION_FAILED',
      this.connected ? 'Sonos connection failed before completion.' : 'Could not connect to the Sonos speaker.',
      { ...this.context(), systemCode: systemErrorCode(error) }, { cause: error })));
    this.socket.on('close', code => this.fail(new SonosError('CONNECTION_CLOSED', 'Sonos connection closed before completion.',
      { ...this.context(), closeCode: code })));
    this.socket.on('message', data => {
      try { this.receive(parseMessage(data.toString())); }
      catch (error) { this.fail(new SonosError('PROTOCOL_ERROR', 'Sonos returned an invalid protocol message.', this.context(), { cause: error })); }
    });
  }

  async open(): Promise<void> { await this.ready; }

  command(header: RequestHeader, body: Record<string, unknown> = {}): Promise<Message> {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.connected || this.pending) return Promise.reject(new SonosError('INVALID_STATE', 'Sonos session is not ready for another command.'));
    return new Promise((resolve, reject) => {
      const cmdId = String(++this.sequence);
      this.pending = { resolve, reject, cmdId, header };
      this.socket.send(JSON.stringify([{ ...header, cmdId }, body]), error => {
        if (error) this.fail(new SonosError('CONNECTION_CLOSED', 'Could not send the Sonos command.',
          { ...this.context(), systemCode: systemErrorCode(error) }, { cause: error }));
      });
    });
  }

  nextEvent(): Promise<Message> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.eventWaiter) return Promise.reject(new SonosError('INVALID_STATE', 'A Sonos event consumer is already waiting.'));
    const event = this.events.shift();
    if (event) return Promise.resolve(event);
    return new Promise((resolve, reject) => { this.eventWaiter = { resolve, reject }; });
  }

  close(): void { this.fail(new SonosError('SESSION_CLOSED', 'Sonos session ended.', this.context())); }

  private context(): ErrorDetails {
    return { host: this.host, phase: !this.connected ? 'connect' : this.pending ? 'command' : 'event',
      command: this.pending?.header.command, namespace: this.pending?.header.namespace };
  }

  private receive(message: Message): void {
    if (this.failure) return;
    const { header, body } = message;
    const pending = this.pending;
    // The identity handshake returns a global error with householdId, without cmdId.
    if (pending && (header.cmdId === pending.cmdId || (!pending.header.command && header.namespace === 'global' && header.householdId))) {
      const details = this.context();
      this.pending = undefined;
      if (pending.header.command && (header.success !== true || header.type === 'globalError' || header.errorCode)) {
        pending.reject(new SonosError('COMMAND_REJECTED', 'Sonos rejected the command.',
          { ...details, sonosCode: safeErrorCode(header.errorCode) || safeErrorCode(body.errorCode) }));
      } else if (pending.header.command && (header.response !== pending.header.command ||
        header.namespace.split(':')[0] !== pending.header.namespace.split(':')[0])) {
        pending.reject(new SonosError('PROTOCOL_ERROR', 'Sonos response does not match the pending command.', details));
      } else { pending.resolve(message); }
    } else if (isEvent(header)) {
      if (this.eventWaiter) {
        this.eventWaiter.resolve(message);
        this.eventWaiter = undefined;
      } else if (this.events.length < 256) { this.events.push(message); }
      else { this.fail(new SonosError('PROTOCOL_ERROR', 'Too many pending Sonos events.', this.context())); }
    }
  }

  private fail(error: SonosError): void {
    if (this.failure) return;
    this.failure = error;
    clearTimeout(this.deadline);
    this.openWaiter?.reject(error);
    this.pending?.reject(error);
    this.eventWaiter?.reject(error);
    this.openWaiter = this.pending = this.eventWaiter = undefined;
    this.events.length = 0;
    this.socket.terminate();
  }
}
