import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const PROGRESS_FILE = 'progress.json';

/**
 * Load or initialize progress state.
 * Tracks which generations have been exported, failed, or are pending.
 */
export function loadProgress(outputDir) {
  const filePath = join(outputDir, PROGRESS_FILE);

  if (existsSync(filePath)) {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    return {
      completed: new Set(data.completed || []),
      failed: new Map(Object.entries(data.failed || {})),
      totalIds: data.total_ids || 0,
      lastRun: data.last_run || null,
      ...data,
    };
  }

  return {
    completed: new Set(),
    failed: new Map(),
    totalIds: 0,
    lastRun: null,
  };
}

/**
 * Save progress state to disk.
 */
export function saveProgress(outputDir, progress) {
  const filePath = join(outputDir, PROGRESS_FILE);

  const data = {
    total_ids: progress.totalIds,
    completed: Array.from(progress.completed),
    failed: Object.fromEntries(progress.failed),
    last_run: new Date().toISOString(),
  };

  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Mark a generation as successfully exported.
 */
export function markCompleted(progress, genId) {
  progress.completed.add(genId);
  progress.failed.delete(genId);
}

/**
 * Mark a generation as failed with a reason.
 */
export function markFailed(progress, genId, reason) {
  progress.failed.set(genId, reason);
}

/**
 * Check if a generation has already been exported.
 */
export function isCompleted(progress, genId) {
  return progress.completed.has(genId);
}

/**
 * Get a summary of current progress.
 */
export function getProgressSummary(progress) {
  const total = progress.totalIds;
  const completed = progress.completed.size;
  const failed = progress.failed.size;
  const remaining = total - completed - failed;

  return {
    total,
    completed,
    failed,
    remaining,
    percent: total > 0 ? Math.round((completed / total) * 100) : 0,
  };
}
