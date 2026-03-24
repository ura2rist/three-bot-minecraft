import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { LogEntry, LogLevel, Logger } from '../../application/shared/ports/Logger';

export class ConsoleLogger implements Logger {
  private readonly logFilePath = this.resolveLogFilePath(process.env.LOG_FILE_PATH);
  private readonly infoEnabled = this.parseBoolean(process.env.LOG_INFO_ENABLED, true);
  private readonly warnEnabled = this.parseBoolean(process.env.LOG_WARN_ENABLED, true);

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

    if (!this.shouldEmit(level)) {
      return;
    }

    const prefix = [entry.timestamp, level.toUpperCase(), this.context]
      .filter((part): part is string => Boolean(part))
      .join(' ');

    const output = `${prefix} ${message}`;
    this.writeToFile(output, entry.error);

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

  private shouldEmit(level: LogLevel): boolean {
    if (level === 'error') {
      return true;
    }

    if (level === 'warn') {
      return this.warnEnabled;
    }

    return this.infoEnabled;
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

  private resolveLogFilePath(logFilePath: string | undefined): string {
    const resolvedPath = resolve(process.cwd(), logFilePath ?? 'logs/app.log');

    mkdirSync(dirname(resolvedPath), { recursive: true });
    return resolvedPath;
  }

  private parseBoolean(rawValue: string | undefined, defaultValue: boolean): boolean {
    if (rawValue === undefined) {
      return defaultValue;
    }

    const normalized = rawValue.trim().toLowerCase();

    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
      return true;
    }

    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
      return false;
    }

    return defaultValue;
  }

  private writeToFile(message: string, error?: string): void {
    appendFileSync(this.logFilePath, `${message}\n`, 'utf8');

    if (!error) {
      return;
    }

    appendFileSync(this.logFilePath, `${error}\n`, 'utf8');
  }
}
