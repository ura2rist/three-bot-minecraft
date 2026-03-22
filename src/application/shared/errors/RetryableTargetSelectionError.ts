export class RetryableTargetSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableTargetSelectionError';
  }
}
