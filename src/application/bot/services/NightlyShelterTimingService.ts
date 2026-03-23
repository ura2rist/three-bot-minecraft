export class NightlyShelterTimingService {
  private readonly dayLengthTicks = 24000;

  constructor(
    private readonly nightStartTimeOfDay = 13000,
    private readonly returnLeadTicks = 600,
  ) {}

  getReturnWindowStartTimeOfDay(): number {
    return this.normalizeTimeOfDay(this.nightStartTimeOfDay - this.returnLeadTicks);
  }

  shouldReturnToShelter(timeOfDay: number | null | undefined): boolean {
    if (timeOfDay === null || timeOfDay === undefined) {
      return false;
    }

    return this.normalizeTimeOfDay(timeOfDay) >= this.getReturnWindowStartTimeOfDay();
  }

  getTicksUntilReturnWindow(timeOfDay: number | null | undefined): number {
    if (timeOfDay === null || timeOfDay === undefined) {
      return this.returnLeadTicks;
    }

    const normalizedTime = this.normalizeTimeOfDay(timeOfDay);
    const returnWindowStart = this.getReturnWindowStartTimeOfDay();

    if (normalizedTime >= returnWindowStart) {
      return 0;
    }

    return returnWindowStart - normalizedTime;
  }

  private normalizeTimeOfDay(timeOfDay: number): number {
    return ((timeOfDay % this.dayLengthTicks) + this.dayLengthTicks) % this.dayLengthTicks;
  }
}
