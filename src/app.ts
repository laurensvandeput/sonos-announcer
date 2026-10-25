import { timingSafeEqual } from 'node:crypto';
import express, { ErrorRequestHandler, RequestHandler } from 'express';
import helmet from 'helmet';
import { AnnounceService, ShuttingDownError } from './Service/Announce.service';
import { Logger } from './types';
import { Clip } from './Media/Clip';

export function createApp(service: AnnounceService, logger: Logger, token?: string, clip?: Clip): express.Application {
  const app = express();
  app.use(helmet());
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/health', (_req, res) => {
    res.status(service.isStopping ? 503 : 200).json({ success: !service.isStopping });
  });

  // Sonos fetches only this file, without the Home Assistant bearer token.
  // No directory listing, user-supplied file paths or internal API proxy.
  if (clip) app.get(clip.path, (_req, res, next) => {
    res.type('audio/mpeg').sendFile(clip.file, { cacheControl: false, lastModified: false }, error => {
      if (error) next(error);
    });
  });

  const authorize: RequestHandler = (req, res, next) => {
    if (token) {
      const expected = Buffer.from('Bearer ' + token);
      const actual = Buffer.from(req.get('Authorization') || '');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        res.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }
    }
    next();
  };

  app.all('/announce', authorize, (req, res, next) => {
    res.set('Allow', 'GET, POST, HEAD, OPTIONS');
    if (req.method === 'HEAD' || req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.status(405).json({ success: false, error: 'Use GET or POST to announce.' });
      return;
    }
    service.announce()
      .then(result => res.status(result.success ? 200 : 502).json(result))
      .catch(next);
  });

  const handleError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (res.headersSent) { _next(error); return; }
    if (error instanceof ShuttingDownError) {
      res.status(503).json({ success: false, error: error.message });
      return;
    }
    logger.error('Unexpected announcement error.', { message: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Announcement failed.' });
  };
  app.use(handleError);
  return app;
}
