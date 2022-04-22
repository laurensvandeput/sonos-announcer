import { NextFunction, Request, Response } from 'express';
import { Logger } from 'winston';
import { StateService } from '../Service/State.service';
import { SpeakerState } from '../types';

export class StateController {
  private systemState: SpeakerState[] = [];

  constructor(private stateSerice: StateService, private logger: Logger) {
  }

  saveCurrentState = (req: Request, res: Response, next: NextFunction) => {
    this.stateSerice.getSpeakerStates()
      .then(systemState => {
        this.systemState = systemState;

        res.status(200);
        next();
      })
      .catch(error => res.status(500).json(error));
  }

  restorePreviousState = (req: Request, res: Response) => {
    this.stateSerice.updateSpeakerStates(this.systemState)
      .then(() => res.status(200).json({success: true}))
      .catch(error => res.status(500).json(error));
  }

}
