import { Logger } from '../../application/shared/ports/Logger';

export class ConsoleLogger implements Logger {
  info(message: string): void {
    console.log(`[INFO] ${message}`);
  }

  error(message: string, error?: unknown): void {
    console.error(`[ERROR] ${message}`);

    if (error instanceof Error) {
      console.error(error.stack ?? error.message);
      return;
    }

    if (error !== undefined) {
      console.error(error);
    }
  }
}
