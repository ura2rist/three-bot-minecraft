import { BotConfiguration } from '../../../domain/bot/entities/BotConfiguration';
import { Logger } from '../../shared/ports/Logger';
import { MicroBasePort } from '../ports/MicroBasePort';
import { DeterministicMicroBaseAssignmentPolicy } from './DeterministicMicroBaseAssignmentPolicy';

export class EstablishMicroBaseService {
  constructor(
    private readonly assignmentPolicy: DeterministicMicroBaseAssignmentPolicy,
    private readonly microBasePort: MicroBasePort,
    private readonly logger: Logger,
  ) {}

  async execute(configuration: BotConfiguration): Promise<void> {
    if (!configuration.rallyPoint) {
      this.logger.info('Skipping micro-base scenario because no rally point is configured.');
      return;
    }

    const leaderUsername = this.assignmentPolicy.getLeaderUsername();

    if (!leaderUsername) {
      this.logger.warn('Skipping micro-base scenario because no squad leader was assigned.');
      return;
    }

    await this.microBasePort.ensureWoodenSwordNearRallyPoint(configuration.rallyPoint);

    if (this.assignmentPolicy.isLeader(configuration)) {
      this.logger.info('This bot is the micro-base leader. Starting the leader scenario.');
      await this.microBasePort.establishAtRallyPoint(configuration.rallyPoint);
      return;
    }

    this.logger.info(`This bot will escort "${leaderUsername}" during the micro-base scenario.`);
    await this.microBasePort.supportLeader(leaderUsername, configuration.rallyPoint);
  }
}
