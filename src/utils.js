import { mkdirSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Structured logging with prefixes.
 */
export const log = {
  info: (msg) => console.log(`  ${msg}`),
  success: (msg) => console.log(`  [OK] ${msg}`),
  warn: (msg) => console.log(`  [!] ${msg}`),
  error: (msg) => console.error(`  [ERROR] ${msg}`),
  progress: (current, total, msg) => {
    const pct = Math.round((current / total) * 100);
    process.stdout.write(`\r  [${current}/${total}] (${pct}%) ${msg}`.padEnd(80));
  },
  progressDone: () => console.log(),
};

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleep with random jitter to avoid detection.
 * Base delay + random 0-50% extra.
 */
export function sleepWithJitter(baseMs) {
  const jitter = Math.random() * baseMs * 0.5;
  return sleep(baseMs + jitter);
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
export function ensureDir(dirPath) {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Write JSON to a file with pretty formatting.
 */
export function writeJson(filePath, data) {
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Sanitize a string for use as a filename.
 */
export function sanitize(str) {
  return str.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 200);
}

/**
 * Truncate a string to a given length with ellipsis.
 */
export function truncate(str, len = 100) {
  if (str.length <= len) return str;
  return str.slice(0, len - 3) + '...';
}

/**
 * Format a date for display.
 */
export function formatDate(date) {
  return new Date(date).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Default output directory.
 */
export const DEFAULT_OUTPUT_DIR = 'sora-export';

/**
 * Default delay between requests (ms).
 */
export const DEFAULT_DELAY = 500;
