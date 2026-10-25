import WebSocket from 'ws';
import { isRecord } from '../Config/SpeakerConfig';

export class SonosError extends Error {}
export interface Message { header: Record<string, unknown>; body: Record<string, unknown> }
interface Waiter<T> { resolve(value: T): void; reject(error: Error): void }

// The local Sonos API uses a self-signed certificate and this public placeholder
// API key, also used by Home Assistant's sonos-websocket transport.
export class Session {
  private readonly socket: WebSocket;
  private readonly deadline: NodeJS.Timeout;
  private readonly ready: Promise<void>;
  private openWaiter?: Waiter<void>;
  private pending?: Waiter<Message> & { cmdId: string; identity: boolean };
  private eventWaiter?: Waiter<Message>;
  private readonly events: Message[] = [];
  private failure?: Error;
  private sequence = 0;

  constructor(url: string, timeoutMs: number) {
    this.ready = new Promise((resolve, reject) => { this.openWaiter = { resolve, reject }; });
    this.socket = new WebSocket(url, 'v1.api.smartspeaker.audio', {
      headers: { 'X-Sonos-Api-Key': '123e4567-e89b-12d3-a456-426655440000' },
      // Scoped to local Sonos sockets; never change global TLS verification.
      rejectUnauthorized: false,
      followRedirects: false,
      perMessageDeflate: false,
      handshakeTimeout: timeoutMs,
      maxPayload: 512 * 1024,
    });
    this.deadline = setTimeout(() => this.fail(new SonosError('Sonos operation timed out after ' + timeoutMs + ' ms; playback completion is unknown.')), timeoutMs);
    this.socket.on('open', () => { this.openWaiter?.resolve(); this.openWaiter = undefined; });
    this.socket.on('error', () => this.fail(new SonosError('Could not communicate with the Sonos speaker.')));
    this.socket.on('close', () => this.fail(new SonosError('Sonos connection closed before completion.')));
    this.socket.on('message', data => {
      try {
        const value: unknown = JSON.parse(data.toString());
        if (!Array.isArray(value) || value.length !== 2 || !isRecord(value[0]) || !isRecord(value[1])) throw new Error();
        this.receive({ header: value[0], body: value[1] });
      } catch {
        this.fail(new SonosError('Sonos returned an invalid protocol message.'));
      }
    });
  }

  async open(): Promise<void> { await this.ready; }

  command(header: Record<string, unknown>, body: Record<string, unknown> = {}): Promise<Message> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new SonosError('A Sonos command is already pending.'));
    return new Promise((resolve, reject) => {
      const cmdId = String(++this.sequence);
      this.pending = { resolve, reject, cmdId, identity: !header.command };
      this.socket.send(JSON.stringify([{ ...header, cmdId }, body]), error => {
        if (error) this.fail(new SonosError('Could not send the Sonos command.'));
      });
    });
  }

  nextEvent(): Promise<Message> {
    if (this.failure) return Promise.reject(this.failure);
    const event = this.events.shift();
    if (event) return Promise.resolve(event);
    return new Promise((resolve, reject) => { this.eventWaiter = { resolve, reject }; });
  }

  close(): void { this.fail(new SonosError('Sonos session ended.')); }

  private receive(message: Message): void {
    if (this.failure) return;
    const { header } = message;
    const pending = this.pending;
    // The deliberately empty identity command returns a global error containing
    // householdId, without echoing cmdId. All subsequent responses echo cmdId.
    if (pending && (header.cmdId === pending.cmdId ||
      (pending.identity && header.namespace === 'global' && typeof header.householdId === 'string'))) {
      this.pending = undefined;
      if (!pending.identity && (header.success !== true || header.type === 'globalError')) {
        pending.reject(new SonosError('Sonos rejected the command.'));
      } else {
        pending.resolve(message);
      }
    } else if (header.name === 'audioClipStatus' || header.type === 'audioClipStatus') {
      if (this.eventWaiter) {
        this.eventWaiter.resolve(message);
        this.eventWaiter = undefined;
      } else if (this.events.length < 256) {
        this.events.push(message);
      } else {
        this.fail(new SonosError('Too many pending Sonos status events.'));
      }
    }
  }

  private fail(error: Error): void {
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
