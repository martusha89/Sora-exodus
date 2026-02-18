import { join } from 'path';
import { createWriteStream, writeFileSync } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { loadProgress, saveProgress, markCompleted, markFailed, isCompleted } from './progress.js';
import { log, sleepWithJitter, ensureDir, writeJson, truncate, DEFAULT_DELAY } from './utils.js';
import { loadCollectedIds } from './collect.js';

/**
 * Download a file from a URL.
 * Sora image URLs are signed Azure Blob Storage URLs — no auth needed, just fetch.
 */
async function downloadFile(page, url, destPath, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const buffer = await page.evaluate(async (fileUrl) => {
        const response = await fetch(fileUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const arrayBuffer = await blob.arrayBuffer();
        return Array.from(new Uint8Array(arrayBuffer));
      }, url);

      const uint8 = new Uint8Array(buffer);
      const stream = Readable.from(Buffer.from(uint8));
      await pipeline(stream, createWriteStream(destPath));
      return true;
    } catch (err) {
      if (attempt === retries) {
        log.warn(`Download failed after ${retries} attempts: ${err.message}`);
        return false;
      }
      await sleepWithJitter(1000);
    }
  }
  return false;
}

/**
 * Get file extension from URL.
 */
function getExtension(url) {
  if (url.includes('.webp')) return '.webp';
  if (url.includes('.png')) return '.png';
  if (url.includes('.jpg') || url.includes('.jpeg')) return '.jpg';
  if (url.includes('.mp4')) return '.mp4';
  if (url.includes('.webm')) return '.webm';
  return '.webp';
}

/**
 * Export all generations — download images/videos and save metadata.
 * Uses data from the API directly, no page scraping needed.
 */
export async function exportGenerations(page, outputDir, options = {}) {
  const { delay = DEFAULT_DELAY } = options;

  const collected = loadCollectedIds(outputDir);
  if (!collected || !collected.generations) {
    throw new Error(
      'No generation data found. Run the collect phase first:\n' +
      '  sora-exodus collect'
    );
  }

  const genDir = join(outputDir, 'generations');
  ensureDir(genDir);

  const progress = loadProgress(outputDir);
  progress.totalIds = collected.generations.length;

  const generations = collected.generations;

  log.info(`Exporting ${generations.length} generations (${progress.completed.size} already done)`);

  const masterIndex = [];
  let exported = 0;
  let skipped = 0;

  for (let i = 0; i < generations.length; i++) {
    const gen = generations[i];

    if (isCompleted(progress, gen.gen_id)) {
      skipped++;
      continue;
    }

    log.progress(i + 1, generations.length, `${gen.gen_id}`);

    try {
      const itemDir = join(genDir, gen.gen_id);
      ensureDir(itemDir);

      const downloadedFiles = [];

      // Download source image
      if (gen.source_url) {
        const ext = getExtension(gen.source_url);
        const filename = `image${ext}`;
        const ok = await downloadFile(page, gen.source_url, join(itemDir, filename));
        if (ok) downloadedFiles.push(filename);
      }

      // Download original (higher quality PNG if available and different from source)
      if (gen.original_url && gen.original_url !== gen.source_url) {
        const ext = getExtension(gen.original_url);
        const filename = `original${ext}`;
        const ok = await downloadFile(page, gen.original_url, join(itemDir, filename));
        if (ok) downloadedFiles.push(filename);
      }

      // Download video if available
      if (gen.video_url) {
        const ext = getExtension(gen.video_url);
        const filename = `video${ext}`;
        const ok = await downloadFile(page, gen.video_url, join(itemDir, filename));
        if (ok) downloadedFiles.push(filename);
      }

      // Save metadata
      const metadata = {
        gen_id: gen.gen_id,
        task_id: gen.task_id,
        prompt: gen.prompt,
        created_at: gen.created_at,
        type: gen.type,
        width: gen.width,
        height: gen.height,
        quality: gen.quality,
        seed: gen.seed,
        is_favorite: gen.is_favorite,
        files: downloadedFiles,
        exported_at: new Date().toISOString(),
      };

      writeJson(join(itemDir, 'metadata.json'), metadata);
      masterIndex.push(metadata);

      markCompleted(progress, gen.gen_id);
      exported++;

      // Save progress every 20 generations
      if (exported % 20 === 0) {
        saveProgress(outputDir, progress);
      }
    } catch (err) {
      markFailed(progress, gen.gen_id, err.message);
      log.progressDone();
      log.warn(`Failed ${gen.gen_id}: ${err.message}`);
    }

    // Delay between downloads
    await sleepWithJitter(delay);
  }

  log.progressDone();

  // Final save
  saveProgress(outputDir, progress);
  writeJson(join(outputDir, 'index.json'), masterIndex);
  writeCsv(outputDir, masterIndex);

  log.success('Export complete!');
  log.info(`  Total generations: ${generations.length}`);
  log.info(`  Exported: ${exported}`);
  log.info(`  Skipped (already done): ${skipped}`);
  log.info(`  Failed: ${progress.failed.size}`);
  log.info(`  Output: ${outputDir}`);

  return progress;
}

/**
 * Write prompts CSV.
 */
function writeCsv(outputDir, index) {
  const header = 'gen_id,task_id,created_at,type,quality,width,height,seed,prompt_preview\n';
  const rows = index.map((item) => {
    const preview = truncate(item.prompt, 150).replace(/"/g, '""').replace(/\n/g, ' ');
    return `${item.gen_id},${item.task_id},${item.created_at},${item.type},${item.quality},${item.width},${item.height},${item.seed},"${preview}"`;
  });

  const csv = header + rows.join('\n') + '\n';
  writeFileSync(join(outputDir, 'prompts.csv'), csv);
  log.info(`Prompts CSV saved.`);
}
