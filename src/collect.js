import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { SORA_BASE } from './browser.js';
import { log, sleep, ensureDir, writeJson } from './utils.js';

const GEN_IDS_FILE = 'gen_ids.json';
const TASKS_FILE = 'tasks.json';
const API_BASE = 'https://sora.chatgpt.com/backend';

/**
 * Capture the Bearer token from Sora's own API requests.
 * Scrolls the library page to trigger backend calls, then intercepts the auth header.
 */
export async function captureAuthToken(page) {
  let authToken = null;

  page.on('request', (request) => {
    if (request.url().includes('/backend/') && !authToken) {
      const headers = request.headers();
      if (headers['authorization']) {
        authToken = headers['authorization'];
      }
    }
  });

  // Navigate and scroll to trigger API calls
  await page.goto(`${SORA_BASE}/library`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  for (let i = 0; i < 3 && !authToken; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
    await sleep(2000);
  }

  if (!authToken) {
    throw new Error('Could not capture auth token. Make sure you are logged into Sora.');
  }

  log.success('Auth token captured.');
  return authToken;
}

/**
 * Fetch all tasks from Sora's API using cursor-based pagination.
 * Returns the full task objects with generation data and image URLs.
 */
export async function collectAll(page, outputDir, authToken) {
  ensureDir(outputDir);

  log.info('Collecting all generations via API...');

  const allTasks = [];
  let cursor = null;
  let pageNum = 0;
  const limit = 50;

  while (true) {
    pageNum++;

    let url = `${API_BASE}/v2/list_tasks?limit=${limit}`;
    if (cursor) url += `&after=${cursor}`;

    const result = await page.evaluate(async ({ apiUrl, token }) => {
      try {
        const response = await fetch(apiUrl, {
          headers: { 'Authorization': token },
        });
        if (!response.ok) {
          return { error: `HTTP ${response.status}`, tasks: [] };
        }
        return await response.json();
      } catch (err) {
        return { error: err.message, tasks: [] };
      }
    }, { apiUrl: url, token: authToken });

    if (result.error) {
      log.error(`API error: ${result.error}`);
      break;
    }

    const tasks = result.task_responses || [];

    if (tasks.length === 0) {
      break;
    }

    allTasks.push(...tasks);

    // Count total generations across all tasks
    const totalGens = allTasks.reduce((sum, t) => sum + (t.generations?.length || 0), 0);
    log.info(`  Page ${pageNum}: ${tasks.length} tasks (${allTasks.length} tasks / ${totalGens} generations total)`);

    // Cursor is the last task ID
    cursor = tasks[tasks.length - 1].id;

    await sleep(300);
  }

  // Extract flat list of generations with all metadata
  const generations = [];

  for (const task of allTasks) {
    if (!task.generations) continue;

    for (const gen of task.generations) {
      // Skip deleted generations
      if (gen.deleted_at) continue;

      // Get the best image/video URL
      const sourceUrl = gen.encodings?.source?.path || gen.url || null;
      const thumbnailUrl = gen.encodings?.thumbnail?.path || null;

      // For videos, check for video-specific encodings
      const videoUrl = gen.encodings?.md?.path || gen.encodings?.ld?.path || null;

      generations.push({
        gen_id: gen.id,
        task_id: task.id,
        prompt: task.prompt || gen.prompt || '',
        created_at: gen.created_at || task.created_at,
        type: task.type || 'image_gen',
        width: gen.width || task.width,
        height: gen.height || task.height,
        n_frames: gen.n_frames || task.n_frames || 1,
        source_url: sourceUrl,
        thumbnail_url: thumbnailUrl,
        video_url: videoUrl,
        original_url: gen.url,
        seed: gen.seed,
        quality: gen.quality || task.quality,
        is_favorite: gen.is_favorite,
        is_public: gen.is_public,
      });
    }
  }

  // Save full task data (for debugging/completeness)
  writeJson(join(outputDir, TASKS_FILE), allTasks);

  // Save generation list
  const result = {
    generations,
    task_count: allTasks.length,
    generation_count: generations.length,
    collected_at: new Date().toISOString(),
    total: generations.length,
    // Keep backward compat with gen_ids.json format
    ids: generations.map(g => g.gen_id),
  };

  writeJson(join(outputDir, GEN_IDS_FILE), result);

  log.success(`Collected ${generations.length} generations from ${allTasks.length} tasks`);
  log.info(`Saved to ${join(outputDir, GEN_IDS_FILE)}`);

  return result;
}

/**
 * Load previously collected data.
 */
export function loadCollectedIds(outputDir) {
  const filePath = join(outputDir, GEN_IDS_FILE);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}
