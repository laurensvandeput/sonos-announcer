import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createLogger, format, transports } from 'winston';
import dotenv from 'dotenv';
import YAML from 'yaml';
import { readAppConfig } from './Config/AppConfig';
import { SpeakerConfig } from './Config/SpeakerConfig';
import { SonosClient } from './Sonos/Client';
import { AnnounceService } from './Service/Announce.service';
import { createApp } from './app';
import { Clip } from './Media/Clip';

if ((process.env.NODE_ENV || 'development') === 'development') dotenv.config();

const logger = createLogger({
  level: 'info',
  format: format.combine(format.timestamp(), format.errors({ stack: true }), format.json()),
  defaultMeta: { service: 'sonos-announcer' },
  transports: [new transports.Console()],
});

try {
  const config = readAppConfig();
  const speakers = new SpeakerConfig(YAML.parse(readFileSync(config.speakersFile, 'utf8')));
  const clip = new Clip(config.clipFile, config.port, config.mediaBaseUrl);
  const client = new SonosClient(config.sonosUrls, config.requestTimeoutMs, logger, {
    interfaceAddress: config.discoveryInterface,
  });
  const service = new AnnounceService(client, speakers,
    clip, logger, config.timeZone);
  const server = createServer(createApp(service, logger, config.announceToken, clip));

  server.on('error', error => {
    logger.error('HTTP server failed.', { message: error.message });
    process.exitCode = 1;
  });
  server.listen(config.port, () => logger.info('Listening for announcements.', {
    port: config.port, timeZone: config.timeZone, discovery: config.sonosUrls.length ? 'configured hosts' : 'automatic SSDP',
    mediaAddress: config.mediaBaseUrl ? 'configured override' : 'automatic from speaker connection',
  }));

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down; waiting for active announcement.');
    const deadline = setTimeout(() => {
      logger.error('Shutdown deadline exceeded.');
      process.exit(1);
    }, config.shutdownTimeoutMs);
    deadline.unref();
    try {
      // Keep the media server available until the speakers finish.
      await service.stop();
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    } catch (error) {
      logger.error('Shutdown failed.', { message: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGQUIT'] as const) {
    process.on(signal, () => { void shutdown(); });
  }
} catch (error) {
  logger.error('Startup failed.', { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
