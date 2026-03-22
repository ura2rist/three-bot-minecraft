export class SquadWeaponReadinessTracker {
  private readonly readyUsernames = new Set<string>();
  private readonly waiters = new Set<() => void>();

  reset(): void {
    this.readyUsernames.clear();
    this.resolveWaiters();
  }

  markReady(username: string): void {
    this.readyUsernames.add(username);
    this.resolveWaiters();
  }

  clearReady(username: string): void {
    if (!this.readyUsernames.delete(username)) {
      return;
    }

    this.resolveWaiters();
  }

  areAllReady(expectedUsernames: readonly string[]): boolean {
    return expectedUsernames.every((username) => this.readyUsernames.has(username));
  }

  async waitUntilAllReady(
    expectedUsernames: readonly string[],
    isStillActive: () => boolean,
  ): Promise<void> {
    while (!this.areAllReady(expectedUsernames)) {
      if (!isStillActive()) {
        return;
      }

      await new Promise<void>((resolve) => {
        this.waiters.add(resolve);
      });
    }
  }

  private resolveWaiters(): void {
    for (const resolve of this.waiters) {
      resolve();
    }

    this.waiters.clear();
  }
}
