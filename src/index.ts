import * as fs from 'fs';
import * as dotenv from 'dotenv';
import * as http from 'http';
import express from 'express';
import YAML from 'yaml';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import Signals = NodeJS.Signals;
import { SpeakerConfig } from './Config/SpeakerConfig';
import { createLogger, format, transports } from 'winston';
import { AnnounceController } from './Controller/Announce.controller';
import { StateController } from './Controller/State.controller';
import { StateService } from './Service/State.service';
import { SonosClient } from './Sonos/Client';
import { AnnounceService } from './Service/Announce.service';

if ((process.env.NODE_ENV || 'development') === 'development') {
  dotenv.config();
}

const logger = createLogger({
    level: 'info',
    format: format.combine(
      format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss',
      }),
      format.errors({stack: true}),
      format.splat(),
      format.json(),
    ),
    defaultMeta: {service: 'sonos-announcer'},
    transports: [
      new transports.Console({
        format: format.combine(
          format.colorize(),
          format.simple(),
        ),
      }),
    ],
  },
);

if (process.env.NODE_ENV === 'development') {
  logger.level = 'debug';
}

const app: express.Application = express();
const server: http.Server = http.createServer(app);
const port = process.env.NODE_PORT;

app.use(cors());
app.use(helmet());
app.use(compression());
app.use(express.json());

try {
  const yaml = YAML.parse(fs.readFileSync('./config/speakers.yaml', 'utf8'));
  const speakerConfig = new SpeakerConfig(yaml);

  const sonosClient = new SonosClient(process.env.SONOS_HTTP_SERVER, logger);
  const stateService = new StateService(sonosClient, speakerConfig, logger);
  const stateController = new StateController(stateService, logger);
  const announceService = new AnnounceService(sonosClient, speakerConfig, process.env.CLIP, logger);
  const announceController = new AnnounceController(announceService, logger);

  app.use('/announce', stateController.saveCurrentState);
  app.use('/announce', announceController.announce);
  app.use('/announce', stateController.restorePreviousState);

  server.listen(port, () => {
    logger.info(`sonos-announcer listening on port ${port}`);
  });
}
catch (e: any) {
  logger.error(e.message);
}

['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach((signal: Signals) => {
  process.on(signal, async () => {
    if (server) {
      logger.info('Closing the server...');

      server.close();
    }

    process.exit();
  });
});
