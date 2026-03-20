export interface LogHarvestingPort {
  gatherNearestLog(): Promise<void>;
}
