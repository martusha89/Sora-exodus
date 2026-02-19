import { DatabaseSync } from 'node:sqlite';
import { readdir, readFile, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const BATCH_SIZE = 500;
const THUMB_WIDTH = 300;
const CONCURRENCY = 8;

export async function runImport(dbPath, thumbDir, generationsDir) {
  console.log(`\n  Sora Gallery Import`);
  console.log(`  Source: ${generationsDir}`);
  console.log(`  Database: ${dbPath}`);
  console.log(`  Thumbnails: ${thumbDir}\n`);

  await mkdir(thumbDir, { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');

  createSchema(db);

  const existingCount = db.prepare('SELECT COUNT(*) as c FROM generations').get().c;
  if (existingCount > 0) {
    console.log(`  Database already has ${existingCount} records.`);
  }

  // Walk generation directories
  console.log('  Scanning generation folders...');
  const entries = await readdir(generationsDir);
  const genDirs = entries.filter(e => e.startsWith('gen_')).sort();
  console.log(`  Found ${genDirs.length} generation folders.\n`);

  // Batch import metadata
  let imported = 0;
  let skipped = 0;
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO generations
    (gen_id, task_id, prompt, created_at, type, width, height, quality, seed, is_favorite, has_thumb, file_primary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `);

  const beginTx = db.prepare('BEGIN');
  const commitTx = db.prepare('COMMIT');

  for (let i = 0; i < genDirs.length; i += BATCH_SIZE) {
    const batch = genDirs.slice(i, i + BATCH_SIZE);
    beginTx.run();

    for (const dir of batch) {
      const metaPath = path.join(generationsDir, dir, 'metadata.json');
      try {
        const raw = await readFile(metaPath, 'utf8');
        const meta = JSON.parse(raw);
        const filePrimary = pickPrimaryFile(meta, generationsDir);

        const result = insertStmt.run(
          meta.gen_id,
          meta.task_id || null,
          meta.prompt || '',
          meta.created_at || null,
          meta.type || 'image_gen',
          meta.width || 0,
          meta.height || 0,
          meta.quality || null,
          meta.seed || null,
          meta.is_favorite ? 1 : 0,
          filePrimary
        );

        if (result.changes > 0) imported++;
        else skipped++;
      } catch (err) {
        // Skip broken metadata
      }
    }

    commitTx.run();
    const total = Math.min(i + BATCH_SIZE, genDirs.length);
    process.stdout.write(`\r  Metadata: ${total}/${genDirs.length} (${imported} new, ${skipped} existing)`);
  }

  console.log(`\n  Metadata import complete: ${imported} new, ${skipped} existing.\n`);

  // Build FTS5 index
  console.log('  Building full-text search index...');
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS generations_fts
    USING fts5(gen_id UNINDEXED, prompt, content_rowid='rowid')
  `);

  const ftsCount = db.prepare('SELECT COUNT(*) as c FROM generations_fts').get().c;
  if (ftsCount === 0) {
    db.exec(`
      INSERT INTO generations_fts(gen_id, prompt)
      SELECT gen_id, prompt FROM generations WHERE prompt != ''
    `);
    console.log('  FTS5 index built.\n');
  } else {
    // Incremental: add any missing entries
    db.exec(`
      INSERT OR IGNORE INTO generations_fts(gen_id, prompt)
      SELECT g.gen_id, g.prompt FROM generations g
      LEFT JOIN generations_fts f ON g.gen_id = f.gen_id
      WHERE f.gen_id IS NULL AND g.prompt != ''
    `);
    console.log('  FTS5 index updated.\n');
  }

  // Build task_stats
  console.log('  Building task variant stats...');
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_stats (
      task_id TEXT PRIMARY KEY,
      variant_count INTEGER
    )
  `);
  db.exec('DELETE FROM task_stats');
  db.exec(`
    INSERT INTO task_stats (task_id, variant_count)
    SELECT task_id, COUNT(*) FROM generations
    WHERE task_id IS NOT NULL
    GROUP BY task_id
    HAVING COUNT(*) > 1
  `);
  const taskCount = db.prepare('SELECT COUNT(*) as c FROM task_stats').get().c;
  console.log(`  ${taskCount} tasks with multiple variants.\n`);

  // Generate thumbnails
  await generateThumbnails(db, thumbDir, generationsDir);

  db.close();
  console.log('\n  Import complete.\n');
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS generations (
      gen_id TEXT PRIMARY KEY,
      task_id TEXT,
      prompt TEXT,
      created_at TEXT,
      type TEXT,
      width INTEGER,
      height INTEGER,
      quality TEXT,
      seed INTEGER,
      is_favorite INTEGER DEFAULT 0,
      has_thumb INTEGER DEFAULT 0,
      file_primary TEXT
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_type ON generations(type)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_quality ON generations(quality)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_created_at ON generations(created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_id ON generations(task_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_dims ON generations(width, height)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_favorite ON generations(is_favorite)');
}

function pickPrimaryFile(meta, generationsDir) {
  const files = meta.files || [];
  if (meta.type === 'video_gen') {
    if (files.includes('video.mp4')) return 'video.mp4';
    if (files.includes('original.mp4')) return 'original.mp4';
    return files.find(f => f.endsWith('.mp4')) || files[0] || null;
  }
  // Image — prefer original.png (always exists), then check others on disk
  const preferred = ['original.png', 'image.png', 'image.webp'];
  for (const f of preferred) {
    if (files.includes(f) && existsSync(path.join(generationsDir, meta.gen_id, f))) return f;
  }
  // Fallback: first file that exists
  for (const f of files) {
    if (existsSync(path.join(generationsDir, meta.gen_id, f))) return f;
  }
  return files[0] || null;
}

async function generateThumbnails(db, thumbDir, generationsDir) {
  const rows = db.prepare(`
    SELECT gen_id, type, file_primary FROM generations
    WHERE has_thumb = 0 AND type = 'image_gen' AND file_primary IS NOT NULL
  `).all();

  if (rows.length === 0) {
    console.log('  All thumbnails up to date.');
    return;
  }

  console.log(`  Generating ${rows.length} thumbnails (${CONCURRENCY} concurrent)...`);

  const updateThumb = db.prepare('UPDATE generations SET has_thumb = 1 WHERE gen_id = ?');
  let done = 0;
  let failed = 0;
  const startTime = Date.now();

  // Process in concurrent batches
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    const promises = batch.map(async (row) => {
      const thumbPath = path.join(thumbDir, `${row.gen_id}.webp`);

      // Skip if thumbnail already exists on disk
      if (existsSync(thumbPath)) {
        updateThumb.run(row.gen_id);
        return true;
      }

      const srcPath = path.join(generationsDir, row.gen_id, row.file_primary);
      try {
        await sharp(srcPath)
          .resize(THUMB_WIDTH, null, { withoutEnlargement: true })
          .webp({ quality: 75 })
          .toFile(thumbPath);
        updateThumb.run(row.gen_id);
        return true;
      } catch (err) {
        failed++;
        if (failed <= 3) console.error(`\n  Thumb error [${row.gen_id}]: ${err.message}`);
        return false;
      }
    });

    await Promise.all(promises);
    done += batch.length;

    const elapsed = (Date.now() - startTime) / 1000;
    const rate = done / elapsed;
    const remaining = Math.round((rows.length - done) / rate);
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    process.stdout.write(
      `\r  Thumbnails: ${done}/${rows.length} (${rate.toFixed(0)}/s, ~${mins}m${secs}s remaining)   `
    );
  }

  console.log(`\n  Thumbnails: ${done - failed} generated, ${failed} failed.`);
}
