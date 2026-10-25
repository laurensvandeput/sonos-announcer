import { randomBytes } from 'node:crypto';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { isIP, isIPv4 } from 'node:net';
import { AnnouncementMedia } from '../types';
import { SonosError } from '../Sonos/Errors';

export class Clip implements AnnouncementMedia {
  readonly file: string;
  readonly path = '/clips/' + randomBytes(32).toString('hex') + '.mp3';

  constructor(file: string, private readonly port: number, private readonly baseUrl?: string) {
    this.file = realpathSync(file);
    const stat = statSync(this.file);
    if (!stat.isFile() || stat.size === 0 || stat.size > 10 * 1024 * 1024) {
      throw new Error('CLIP_FILE must be a non-empty regular file of at most 10 MiB.');
    }
    accessSync(this.file, constants.R_OK);
  }

  urlFor(localAddress: string | undefined): string {
    if (this.baseUrl) return this.baseUrl.replace(/\/+$/u, '') + this.path;
    // Use the address selected by the OS for this speaker connection. HTTP
    // Host/Forwarded headers and unrelated Docker interfaces cannot influence it.
    const address = localAddress?.startsWith('::ffff:') && isIPv4(localAddress.slice(7))
      ? localAddress.slice(7) : localAddress;
    const family = address ? isIP(address) : 0;
    if (!address || !family || address === '0.0.0.0' || address === '::' || address.includes('%')) {
      throw new SonosError('MEDIA_ADDRESS_UNAVAILABLE', 'Could not determine a usable local address for serving the MP3 to Sonos.');
    }
    return `http://${family === 6 ? '[' + address + ']' : address}:${this.port}${this.path}`;
  }
}
