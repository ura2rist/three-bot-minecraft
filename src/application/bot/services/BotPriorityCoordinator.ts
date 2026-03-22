import { BotTaskName } from '../events/BotActivityEvent';

type BotPhase = 'rally' | 'mission';

export class BotPriorityCoordinator {
  private phase: BotPhase = 'rally';
  private activeThreats = 0;
  private currentTask: BotTaskName | 'idle' = 'idle';
  private resumeWaiters = new Set<() => void>();

  onRallyStarted(): void {
    this.phase = 'rally';
    this.currentTask = 'rally';
    this.activeThreats = 0;
    this.resolveResumeWaiters();
  }

  onRallyCompleted(): void {
    this.phase = 'mission';
    if (this.currentTask === 'rally') {
      this.currentTask = 'idle';
    }
  }

  onRespawned(): void {
    this.phase = 'rally';
    this.currentTask = 'idle';
    this.activeThreats = 0;
    this.resolveResumeWaiters();
  }

  onBotDied(): void {
    this.phase = 'rally';
    this.currentTask = 'idle';
    this.activeThreats = 0;
    this.resolveResumeWaiters();
  }

  onTaskStarted(task: BotTaskName): void {
    if (this.phase !== 'mission' && task !== 'rally') {
      return;
    }

    this.currentTask = task;
  }

  onTaskCompleted(task: BotTaskName): void {
    if (this.currentTask === task) {
      this.currentTask = 'idle';
    }
  }

  onThreatEngaged(): void {
    if (this.phase !== 'mission') {
      return;
    }

    this.activeThreats += 1;
  }

  onThreatResolved(): void {
    this.activeThreats = Math.max(0, this.activeThreats - 1);

    if (this.activeThreats === 0) {
      this.resolveResumeWaiters();
    }
  }

  canInterruptWithThreatResponse(): boolean {
    return this.phase === 'mission';
  }

  isThreatResponseActive(): boolean {
    return this.phase === 'mission' && this.activeThreats > 0;
  }

  async waitUntilTaskMayProceed(isScenarioActive: () => boolean): Promise<void> {
    while (this.phase === 'mission' && this.activeThreats > 0) {
      if (!isScenarioActive()) {
        return;
      }

      await new Promise<void>((resolve) => {
        this.resumeWaiters.add(resolve);
      });
    }
  }

  getCurrentTask(): BotTaskName | 'idle' {
    return this.currentTask;
  }

  private resolveResumeWaiters(): void {
    for (const resolve of this.resumeWaiters) {
      resolve();
    }

    this.resumeWaiters.clear();
  }
}
