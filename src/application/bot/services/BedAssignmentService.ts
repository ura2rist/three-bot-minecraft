import { BotRole } from '../../../domain/bot/entities/BotRole';

const BED_ASSIGNMENT_ORDER: readonly BotRole[] = ['farm', 'mine', 'trading'] as const;

export class BedAssignmentService {
  getAssignmentOrder(role: BotRole, totalBeds: number): number[] {
    if (totalBeds <= 0) {
      return [];
    }

    const preferredIndex = this.getPreferredIndex(role, totalBeds);

    return Array.from({ length: totalBeds }, (_, offset) => {
      return (preferredIndex + offset) % totalBeds;
    });
  }

  private getPreferredIndex(role: BotRole, totalBeds: number): number {
    const roleIndex = BED_ASSIGNMENT_ORDER.indexOf(role);

    if (roleIndex < 0) {
      return 0;
    }

    return roleIndex % totalBeds;
  }
}
