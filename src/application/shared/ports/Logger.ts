export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  context?: string;
  message: string;
  error?: string;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
  child(context: string): Logger;
  getEntries(): readonly LogEntry[];
}
