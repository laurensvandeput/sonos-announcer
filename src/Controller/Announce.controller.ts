import { NextFunction, Request, Response } from 'express';
import { Logger } from 'winston';
import { AnnounceService } from '../Service/Announce.service';

export class AnnounceController {

  constructor(private announceService: AnnounceService, private logger: Logger) {
  }

  announce = (req: Request, res: Response, next: NextFunction) => {
    this.announceService.broadcast()
      .then(() => {
        this.logger.info('Sent announcement to the speakers.')

        res.status(200);
        next();
      })
  }

}
