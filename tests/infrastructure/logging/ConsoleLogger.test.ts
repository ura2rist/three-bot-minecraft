import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConsoleLogger } from '../../../src/infrastructure/logging/ConsoleLogger';

test('ConsoleLogger can suppress info and warn output while always emitting errors', () => {
  const originalInfoEnabled = process.env.LOG_INFO_ENABLED;
  const originalWarnEnabled = process.env.LOG_WARN_ENABLED;
  const originalLogFilePath = process.env.LOG_FILE_PATH;
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;
  const logFilePath = resolve(process.cwd(), 'logs/console-logger.test.log');
  const consoleCalls = {
    info: 0,
    warn: 0,
    error: 0,
  };

  process.env.LOG_INFO_ENABLED = 'false';
  process.env.LOG_WARN_ENABLED = 'false';
  process.env.LOG_FILE_PATH = logFilePath;
  console.log = () => {
    consoleCalls.info += 1;
  };
  console.warn = () => {
    consoleCalls.warn += 1;
  };
  console.error = () => {
    consoleCalls.error += 1;
  };

  try {
    rmSync(logFilePath, { force: true });

    const logger = new ConsoleLogger();
    logger.info('hidden info');
    logger.warn('hidden warn');
    logger.error('visible error');

    assert.equal(consoleCalls.info, 0);
    assert.equal(consoleCalls.warn, 0);
    assert.equal(consoleCalls.error, 1);
    assert.deepEqual(
      logger.getEntries().map((entry) => entry.level),
      ['info', 'warn', 'error'],
    );
  } finally {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;

    if (originalInfoEnabled === undefined) {
      delete process.env.LOG_INFO_ENABLED;
    } else {
      process.env.LOG_INFO_ENABLED = originalInfoEnabled;
    }

    if (originalWarnEnabled === undefined) {
      delete process.env.LOG_WARN_ENABLED;
    } else {
      process.env.LOG_WARN_ENABLED = originalWarnEnabled;
    }

    if (originalLogFilePath === undefined) {
      delete process.env.LOG_FILE_PATH;
    } else {
      process.env.LOG_FILE_PATH = originalLogFilePath;
    }

    rmSync(logFilePath, { force: true });
  }
});
