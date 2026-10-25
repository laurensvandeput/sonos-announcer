import { randomBytes } from 'node:crypto';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';

export class Clip {
  readonly file: string;
  readonly path = '/clips/' + randomBytes(32).toString('hex') + '.mp3';
  readonly url: string;

  constructor(file: string, baseUrl: string) {
    this.file = realpathSync(file);
    const stat = statSync(this.file);
    if (!stat.isFile() || stat.size === 0 || stat.size > 10 * 1024 * 1024) {
      throw new Error('CLIP_FILE must be a non-empty regular file of at most 10 MiB.');
    }
    accessSync(this.file, constants.R_OK);
    this.url = baseUrl.replace(/\/+$/u, '') + this.path;
  }
}
