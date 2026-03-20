import { LogEntry, LogLevel, Logger } from '../../application/shared/ports/Logger';

export class ConsoleLogger implements Logger {
  constructor(
    private readonly entries: LogEntry[] = [],
    private readonly context?: string,
  ) {}

  info(message: string): void {
    this.write('info', message);
  }

  warn(message: string): void {
    this.write('warn', message);
  }

  error(message: string, error?: unknown): void {
    this.write('error', message, error);
  }

  child(context: string): Logger {
    const nextContext = this.context ? `${this.context}:${context}` : context;

    return new ConsoleLogger(this.entries, nextContext);
  }

  getEntries(): readonly LogEntry[] {
    return this.entries;
  }

  private write(level: LogLevel, message: string, error?: unknown): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      context: this.context,
      message,
      error: this.serializeError(error),
    };

    this.entries.push(entry);

    const prefix = [entry.timestamp, level.toUpperCase(), this.context]
      .filter((part): part is string => Boolean(part))
      .join(' ');

    const output = `${prefix} ${message}`;

    if (level === 'error') {
      console.error(output);

      if (entry.error) {
        console.error(entry.error);
      }

      return;
    }

    if (level === 'warn') {
      console.warn(output);
      return;
    }

    console.log(output);
  }

  private serializeError(error: unknown): string | undefined {
    if (error instanceof Error) {
      return error.stack ?? error.message;
    }

    if (typeof error === 'string') {
      return error;
    }

    if (error === undefined) {
      return undefined;
    }

    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
}
