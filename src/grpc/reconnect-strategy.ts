import { logger } from '../utils/logger.js';

export interface ReconnectConfig {
  initialDelay: number;
  maxDelay: number;
  multiplier: number;
  jitter: number;
}

export class ReconnectStrategy {
  private attempt = 0;

  constructor(private config: ReconnectConfig) {}

  getDelay(): number {
    const delay = Math.min(
      this.config.maxDelay,
      this.config.initialDelay * Math.pow(this.config.multiplier, this.attempt)
    );

    // Add jitter
    const jitter = delay * this.config.jitter * (Math.random() * 2 - 1);
    const finalDelay = Math.max(0, delay + jitter);

    logger.debug({
      attempt: this.attempt,
      baseDelay: delay,
      jitter,
      finalDelay
    }, '[ReconnectStrategy] Calculated delay');

    return finalDelay;
  }

  incrementAttempt(): void {
    this.attempt++;
  }

  reset(): void {
    this.attempt = 0;
  }

  getAttempt(): number {
    return this.attempt;
  }
}