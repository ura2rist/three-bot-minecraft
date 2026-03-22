import { LogEntry, Logger } from '../../src/application/shared/ports/Logger';

export class TestLogger implements Logger {
  private readonly entries: LogEntry[] = [];

  info(message: string): void {
    this.entries.push({ timestamp: new Date(0).toISOString(), level: 'info', message });
  }

  warn(message: string): void {
    this.entries.push({ timestamp: new Date(0).toISOString(), level: 'warn', message });
  }

  error(message: string, error?: unknown): void {
    this.entries.push({
      timestamp: new Date(0).toISOString(),
      level: 'error',
      message,
      error: error instanceof Error ? error.message : error === undefined ? undefined : String(error),
    });
  }

  child(context: string): Logger {
    const parent = this;

    return {
      info(message: string): void {
        parent.entries.push({ timestamp: new Date(0).toISOString(), level: 'info', context, message });
      },
      warn(message: string): void {
        parent.entries.push({ timestamp: new Date(0).toISOString(), level: 'warn', context, message });
      },
      error(message: string, error?: unknown): void {
        parent.entries.push({
          timestamp: new Date(0).toISOString(),
          level: 'error',
          context,
          message,
          error: error instanceof Error ? error.message : error === undefined ? undefined : String(error),
        });
      },
      child(nextContext: string): Logger {
        return parent.child(`${context}:${nextContext}`);
      },
      getEntries(): readonly LogEntry[] {
        return parent.entries;
      },
    };
  }

  getEntries(): readonly LogEntry[] {
    return this.entries;
  }
}
