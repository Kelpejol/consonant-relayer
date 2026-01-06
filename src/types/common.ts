/**
 * @fileoverview Common Types - Shared Across All Services
 * 
 * Base types and utilities used throughout the relayer.
 * 
 * @author Consonant Engineering
 * @version 2.0.0
 */

/**
 * Log level
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * Environment
 */
export type Environment = 'development' | 'staging' | 'production';

/**
 * Result type (for error handling)
 */
export type Result<T, E = Error> = 
  | { success: true; value: T }
  | { success: false; error: E };

/**
 * Optional type helper
 */
export type Optional<T> = T | undefined;

/**
 * Nullable type helper
 */
export type Nullable<T> = T | null;

/**
 * Deep readonly helper
 */
export type DeepReadonly<T> = {
  readonly [P in keyof T]: T[P] extends object ? DeepReadonly<T[P]> : T[P];
};

/**
 * Extract array element type
 */
export type ArrayElement<T> = T extends (infer U)[] ? U : never;

/**
 * Make properties optional
 */
export type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/**
 * Make properties required
 */
export type RequiredBy<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>;