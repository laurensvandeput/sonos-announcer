import { NextFunction, Request, Response } from 'express';
import { Logger } from 'winston';
import { SpeakerConfig } from '../Config/SpeakerConfig';

export class AnnounceController {

  constructor(private config: SpeakerConfig, private logger: Logger) {
  }

  announce = (req: Request, res: Response, next: NextFunction) => {
    this.logger.info('Announcing', this.config.getSpeakers());

    res.status(200);

    next();
  }

}
