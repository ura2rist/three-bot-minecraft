export type NightlyShelterSleepDecisionReason =
  | 'before_sleep_window'
  | 'no_beds_available'
  | 'all_beds_occupied'
  | 'free_bed_available'
  | 'night_missed';

export type NightlyShelterSleepDecision =
  | {
      kind: 'wait';
      reason:
        | 'before_sleep_window'
        | 'no_beds_available'
        | 'all_beds_occupied';
      nextSleepWindowObserved: boolean;
    }
  | {
      kind: 'try_sleep';
      reason: 'free_bed_available';
      nextSleepWindowObserved: true;
    }
  | {
      kind: 'expand_after_morning';
      reason: 'night_missed';
      nextSleepWindowObserved: true;
    };

export interface NightlyShelterSleepSnapshot {
  sleepWindowObserved: boolean;
  isSleepWindow: boolean;
  isDay: boolean;
  totalBeds: number;
  freeBeds: number;
}

export class NightlyShelterSleepDecisionService {
  evaluate(snapshot: NightlyShelterSleepSnapshot): NightlyShelterSleepDecision {
    if (!snapshot.isSleepWindow) {
      if (snapshot.sleepWindowObserved && snapshot.isDay) {
        return {
          kind: 'expand_after_morning',
          reason: 'night_missed',
          nextSleepWindowObserved: true,
        };
      }

      return {
        kind: 'wait',
        reason: 'before_sleep_window',
        nextSleepWindowObserved: snapshot.sleepWindowObserved,
      };
    }

    if (snapshot.freeBeds > 0) {
      return {
        kind: 'try_sleep',
        reason: 'free_bed_available',
        nextSleepWindowObserved: true,
      };
    }

    return {
      kind: 'wait',
      reason: snapshot.totalBeds > 0 ? 'all_beds_occupied' : 'no_beds_available',
      nextSleepWindowObserved: true,
    };
  }
}
