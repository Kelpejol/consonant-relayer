/**
 * Cryptographic Utilities
 * 
 * Provides secure random ID generation
 */

import { randomBytes } from 'crypto';

/**
 * Generate a UUID-like identifier
 * Format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 * 
 * Uses crypto.randomBytes for secure randomness
 */
export function generateUUID(): string {
  const bytes = randomBytes(16);
  
  // Set version (4) and variant bits
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  
  const hex = bytes.toString('hex');
  
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Generate a short random ID
 * Format: base62 string of specified length
 */
export function generateShortId(length: number = 12): string {
  const bytes = randomBytes(Math.ceil(length * 0.75));
  const base62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  
  let result = '';
  for (const byte of bytes) {
    result += base62[byte % 62]!;
    if (result.length >= length) break;
  }
  
  return result.slice(0, length);
}

/**
 * Generate a prefixed ID
 * Format: prefix_timestamp_random
 * Example: evt_1703764800000_a1b2c3d4
 */
export function generatePrefixedId(prefix: string): string {
  const timestamp = Date.now();
  const random = randomBytes(4).toString('hex');
  return `${prefix}_${timestamp}_${random}`;
}