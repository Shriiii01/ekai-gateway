import pino from 'pino';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { LOG_LEVEL } from '../config.js';

export interface LogContext {
  requestId?: string;
  operation?: string;
  provider?: string;
  model?: string;
  duration?: number;
  module?: string;
  [key: string]: unknown;
}

export interface Logger {
  info(message: string, meta?: LogContext): void;
  error(message: string, error?: unknown, meta?: LogContext): void;
  warn(message: string, meta?: LogContext): void;
  debug(message: string, meta?: LogContext): void;
  timer(operation: string): () => void;
}

class PinoLogger implements Logger {
  private p: pino.Logger;

  constructor() {
    // Ensure logs dir exists
    const logsDir = join(process.cwd(), 'logs');
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    const logFile = join(logsDir, 'gateway.log');

     // Build base streams: stdout (raw JSON) + file
     const streams: { stream: any; level?: string }[] = [
       { stream: process.stdout, level: LOG_LEVEL || 'info' },
       { stream: pino.destination(logFile), level: LOG_LEVEL || 'info' },
     ];

    const baseOpts: pino.LoggerOptions = {
      level: LOG_LEVEL || 'info',
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: ['password','token','key','secret','authorization','headers.authorization'],
      serializers: { err: pino.stdSerializers.err },
      base: {
        service: 'ekai-gateway',
        version: process.env.npm_package_version || 'dev'
      }
    };

    this.p = pino(baseOpts, pino.multistream(streams));
  }

  info(message: string, meta?: LogContext): void {
    this.p.info(meta || {}, message);
  }
  error(message: string, error?: unknown, meta?: LogContext): void {
    const logData = { ...(meta || {}), ...(error && { err: error }) };
    this.p.error(logData, message);
  }
  warn(message: string, meta?: LogContext): void {
    this.p.warn(meta || {}, message);
  }
  debug(message: string, meta?: LogContext): void {
    this.p.debug(meta || {}, message);
  }
  timer(operation: string): () => void {
    const start = Date.now();
    return () => this.debug('Operation completed', { operation, duration: Date.now() - start });
  }
}

// Singleton
export const logger: Logger = new PinoLogger();
