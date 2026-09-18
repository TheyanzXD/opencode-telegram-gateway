import pino from 'pino';
import { config } from './config.js';

const transport =
  config.log.format === 'pretty'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } }
    : undefined;

export const logger = pino(
  {
    level: config.log.level,
    base: { service: 'opencode-gateway' },
    redact: ['telegram.token', 'apiKey', '*.apiKey'],
  },
  config.log.file
    ? pino.destination({ dest: config.log.file, sync: false, mkdir: true })
    : pino.transport(transport ?? { target: 'pino/file', options: { destination: 1 } })
);

export function childLogger(bindings) {
  return logger.child(bindings);
}
