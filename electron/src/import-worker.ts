import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';

const BATCH_SIZE = 500;
const THUMB_WIDTH = 300;
const CONCURRENCY = 8;

export interface ImportProgress {
  phase: 'metadata' | 'fts' | 'variants' | 'thumbnails' | 'done';
  current: number;
  total: number;
  message: string;
}

type ProgressCallback = (progress: ImportProgress) => void;

async function getSqlJs(): Promise<any> {
  const sqlPromise = initSqlJs({
    locateFile: (file: string) => {
      // In packaged app, look in node_modules
      const paths = [
        path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file),
        path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', file),
        path.join(process.resourcesPath || '', 'app', 'node_modules', 'sql.js', 'dist', file),
      ];
      for (const p of paths) {
        if (fs.existsSync(p)) return p;
      }
      return file;
    }
  });
  return sqlPromise;
}

function loadOrCreateDb(SQL: any, dbPath: string): SqlJsDatabase {
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    return new SQL.Database(buffer);
  }
  return new SQL.Database();
}

function saveDb(db: SqlJsDatabase, dbPath: string): void {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

export async function runImport(
  dbPath: string,
  thumbDir: string,
  generationsDir: string,
  onProgress: ProgressCallback
): Promise<void> {
  fs.mkdirSync(thumbDir, { recursive: true });
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const SQL = await getSqlJs();
  const db = loadOrCreateDb(SQL, dbPath);

  createSchema(db);

  // Scan generation directories
  onProgress({ phase: 'metadata', current: 0, total: 0, message: 'Scanning folders...' });
  const entries = fs.readdirSync(generationsDir);
  const genDirs = entries.filter(e => e.startsWith('gen_')).sort();

  // Batch import metadata
  let imported = 0;
  let skipped = 0;

  for (let i = 0; i < genDirs.length; i += BATCH_SIZE) {
    const batch = genDirs.slice(i, i + BATCH_SIZE);
    db.run('BEGIN');

    for (const dir of batch) {
      const metaPath = path.join(generationsDir, dir, 'metadata.json');
      try {
        const raw = fs.readFileSync(metaPath, 'utf8');
        const meta = JSON.parse(raw);
        const filePrimary = pickPrimaryFile(meta, generationsDir);

        db.run(
          `INSERT OR IGNORE INTO generations
           (gen_id, task_id, prompt, created_at, type, width, height, quality, seed, is_favorite, has_thumb, file_primary)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
          [
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
          ]
        );

        const changes = db.getRowsModified();
        if (changes > 0) imported++;
        else skipped++;
      } catch {
        // Skip broken metadata
      }
    }

    db.run('COMMIT');
    const total = Math.min(i + BATCH_SIZE, genDirs.length);
    onProgress({
      phase: 'metadata',
      current: total,
      total: genDirs.length,
      message: `Importing metadata: ${total}/${genDirs.length} (${imported} new, ${skipped} existing)`
    });
    // Yield to event loop so progress updates reach the renderer
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  // Build FTS index (batched to keep UI responsive)
  // Note: sql.js doesn't include FTS5, so we use FTS4
  try { db.run('DROP TABLE IF EXISTS generations_fts'); } catch {}
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS generations_fts
    USING fts4(gen_id, prompt, notindexed=gen_id)
  `);

  const ftsRows = db.exec(`SELECT gen_id, prompt FROM generations WHERE prompt != ''`);
  const ftsTotal = ftsRows.length > 0 ? ftsRows[0].values.length : 0;
  onProgress({ phase: 'fts', current: 0, total: ftsTotal, message: `Building search index: 0/${ftsTotal}` });

  if (ftsTotal > 0) {
    const values = ftsRows[0].values;
    for (let i = 0; i < values.length; i += BATCH_SIZE) {
      const end = Math.min(i + BATCH_SIZE, values.length);
      db.run('BEGIN');
      for (let j = i; j < end; j++) {
        db.run('INSERT INTO generations_fts(gen_id, prompt) VALUES (?, ?)', [values[j][0], values[j][1]]);
      }
      db.run('COMMIT');
      onProgress({ phase: 'fts', current: end, total: ftsTotal, message: `Building search index: ${end}/${ftsTotal}` });
      // Yield to event loop so IPC messages can be delivered
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  onProgress({ phase: 'fts', current: ftsTotal, total: ftsTotal, message: 'Search index built.' });

  // Build task_stats
  onProgress({ phase: 'variants', current: 0, total: 1, message: 'Building variant stats...' });
  db.run(`
    CREATE TABLE IF NOT EXISTS task_stats (
      task_id TEXT PRIMARY KEY,
      variant_count INTEGER
    )
  `);
  db.run('DELETE FROM task_stats');
  db.run(`
    INSERT INTO task_stats (task_id, variant_count)
    SELECT task_id, COUNT(*) FROM generations
    WHERE task_id IS NOT NULL
    GROUP BY task_id
    HAVING COUNT(*) > 1
  `);
  onProgress({ phase: 'variants', current: 1, total: 1, message: 'Variant stats built.' });

  // Save DB before thumbnails (so progress isn't lost if thumb gen crashes)
  saveDb(db, dbPath);

  // Generate thumbnails
  await generateThumbnails(db, dbPath, thumbDir, generationsDir, onProgress);

  db.close();
  onProgress({ phase: 'done', current: 1, total: 1, message: 'Import complete!' });
}

function createSchema(db: SqlJsDatabase): void {
  db.run(`
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

  db.run('CREATE INDEX IF NOT EXISTS idx_type ON generations(type)');
  db.run('CREATE INDEX IF NOT EXISTS idx_quality ON generations(quality)');
  db.run('CREATE INDEX IF NOT EXISTS idx_created_at ON generations(created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_task_id ON generations(task_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_dims ON generations(width, height)');
  db.run('CREATE INDEX IF NOT EXISTS idx_favorite ON generations(is_favorite)');
}

function pickPrimaryFile(meta: any, generationsDir: string): string | null {
  const files: string[] = meta.files || [];
  if (meta.type === 'video_gen') {
    if (files.includes('video.mp4')) return 'video.mp4';
    if (files.includes('original.mp4')) return 'original.mp4';
    return files.find(f => f.endsWith('.mp4')) || files[0] || null;
  }
  const preferred = ['original.png', 'image.png', 'image.webp'];
  for (const f of preferred) {
    if (files.includes(f) && fs.existsSync(path.join(generationsDir, meta.gen_id, f))) return f;
  }
  for (const f of files) {
    if (fs.existsSync(path.join(generationsDir, meta.gen_id, f))) return f;
  }
  return files[0] || null;
}

async function generateThumbnails(
  db: SqlJsDatabase,
  dbPath: string,
  thumbDir: string,
  generationsDir: string,
  onProgress: ProgressCallback
): Promise<void> {
  fs.mkdirSync(thumbDir, { recursive: true });

  const result = db.exec(`
    SELECT gen_id, type, file_primary FROM generations
    WHERE has_thumb = 0 AND type = 'image_gen' AND file_primary IS NOT NULL
  `);

  if (result.length === 0 || result[0].values.length === 0) {
    onProgress({ phase: 'thumbnails', current: 0, total: 0, message: 'All thumbnails up to date.' });
    return;
  }

  const rows = result[0].values.map((v: any[]) => ({
    gen_id: v[0] as string,
    type: v[1] as string,
    file_primary: v[2] as string
  }));

  let done = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    const promises = batch.map(async (row: { gen_id: string; type: string; file_primary: string }) => {
      const thumbPath = path.join(thumbDir, `${row.gen_id}.webp`);

      if (fs.existsSync(thumbPath)) {
        db.run('UPDATE generations SET has_thumb = 1 WHERE gen_id = ?', [row.gen_id]);
        return;
      }

      const srcPath = path.join(generationsDir, row.gen_id, row.file_primary);
      try {
        await sharp(srcPath)
          .resize(THUMB_WIDTH, null, { withoutEnlargement: true })
          .webp({ quality: 75 })
          .toFile(thumbPath);
        db.run('UPDATE generations SET has_thumb = 1 WHERE gen_id = ?', [row.gen_id]);
      } catch {
        failed++;
      }
    });

    await Promise.all(promises);
    done += batch.length;

    // Save periodically
    if (done % 200 === 0) saveDb(db, dbPath);

    onProgress({
      phase: 'thumbnails',
      current: done,
      total: rows.length,
      message: `Generating thumbnails: ${done}/${rows.length}${failed > 0 ? ` (${failed} failed)` : ''}`
    });
  }

  saveDb(db, dbPath);
}

// Helper to convert sql.js result to objects
function rowsToObjects(result: any): any[] {
  if (!result || result.length === 0) return [];
  const cols = result[0].columns;
  return result[0].values.map((row: any[]) => {
    const obj: any = {};
    cols.forEach((col: string, i: number) => obj[col] = row[i]);
    return obj;
  });
}

function getOne(db: SqlJsDatabase, sql: string, params: any[] = []): any | null {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const cols = stmt.getColumnNames();
    const vals = stmt.get();
    stmt.free();
    const obj: any = {};
    cols.forEach((col, i) => obj[col] = vals[i]);
    return obj;
  }
  stmt.free();
  return null;
}

function getAll(db: SqlJsDatabase, sql: string, params: any[] = []): any[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results: any[] = [];
  while (stmt.step()) {
    const cols = stmt.getColumnNames();
    const vals = stmt.get();
    const obj: any = {};
    cols.forEach((col, i) => obj[col] = vals[i]);
    results.push(obj);
  }
  stmt.free();
  return results;
}

function getCount(db: SqlJsDatabase, sql: string, params: any[] = []): number {
  const row = getOne(db, sql, params);
  if (!row) return 0;
  return Object.values(row)[0] as number;
}

// DB query functions used by main process
export function createQueryDb(dbPath: string, SQL: any) {
  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer) as SqlJsDatabase;

  const PAGE_SIZE = 60;

  return {
    getGenerations(filters: any) {
      const page = filters.page || 1;
      const offset = (page - 1) * PAGE_SIZE;
      const where: string[] = [];
      const params: any[] = [];

      if (filters.type) { where.push('g.type = ?'); params.push(filters.type); }
      if (filters.quality) { where.push('g.quality = ?'); params.push(filters.quality); }
      if (filters.dims === 'portrait') where.push('g.height > g.width');
      else if (filters.dims === 'landscape') where.push('g.width > g.height');
      else if (filters.dims === 'square') where.push('g.width = g.height');
      if (filters.from) { where.push('g.created_at >= ?'); params.push(filters.from); }
      if (filters.to) { where.push('g.created_at <= ?'); params.push(filters.to + 'T23:59:59Z'); }
      if (filters.favorites) where.push('g.is_favorite = 1');

      const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

      const total = getCount(db, `SELECT COUNT(*) as total FROM generations g ${whereClause}`, params);

      const rows = getAll(db, `
        SELECT g.gen_id, g.task_id, g.prompt, g.created_at, g.type, g.width, g.height,
               g.quality, g.is_favorite, g.has_thumb, g.file_primary,
               COALESCE(ts.variant_count, 0) as variant_count
        FROM generations g
        LEFT JOIN task_stats ts ON g.task_id = ts.task_id
        ${whereClause}
        ORDER BY g.created_at DESC
        LIMIT ? OFFSET ?
      `, [...params, PAGE_SIZE, offset]);

      return { generations: rows, total, page, pages: Math.ceil(total / PAGE_SIZE), pageSize: PAGE_SIZE };
    },

    search(query: string, page: number = 1) {
      if (!query || query.trim().length === 0) {
        return { generations: [], total: 0 };
      }

      const offset = (page - 1) * PAGE_SIZE;
      const sanitized = query.trim().split(/\s+/).map(w => `"${w.replace(/"/g, '')}"`).join(' ');

      try {
        const total = getCount(db, 'SELECT COUNT(*) as total FROM generations_fts WHERE generations_fts MATCH ?', [sanitized]);

        const rows = getAll(db, `
          SELECT g.gen_id, g.task_id, g.prompt, g.created_at, g.type, g.width, g.height,
                 g.quality, g.is_favorite, g.has_thumb, g.file_primary,
                 COALESCE(ts.variant_count, 0) as variant_count
          FROM generations_fts fts
          JOIN generations g ON fts.gen_id = g.gen_id
          LEFT JOIN task_stats ts ON g.task_id = ts.task_id
          WHERE generations_fts MATCH ?
          ORDER BY g.created_at DESC
          LIMIT ? OFFSET ?
        `, [sanitized, PAGE_SIZE, offset]);

        return { generations: rows, total, page, pages: Math.ceil(total / PAGE_SIZE), pageSize: PAGE_SIZE, query };
      } catch {
        return { generations: [], total: 0, query, error: 'Search syntax error' };
      }
    },

    getGeneration(id: string) {
      return getOne(db, `
        SELECT g.*, COALESCE(ts.variant_count, 0) as variant_count
        FROM generations g
        LEFT JOIN task_stats ts ON g.task_id = ts.task_id
        WHERE g.gen_id = ?
      `, [id]);
    },

    getTask(taskId: string) {
      const rows = getAll(db, `
        SELECT gen_id, prompt, created_at, type, width, height, quality, has_thumb, file_primary
        FROM generations WHERE task_id = ? ORDER BY created_at ASC
      `, [taskId]);
      return { task_id: taskId, variants: rows, count: rows.length };
    },

    getStats() {
      const total = getCount(db, 'SELECT COUNT(*) as c FROM generations');
      const images = getCount(db, "SELECT COUNT(*) as c FROM generations WHERE type = 'image_gen'");
      const videos = getCount(db, "SELECT COUNT(*) as c FROM generations WHERE type = 'video_gen'");
      const favorites = getCount(db, 'SELECT COUNT(*) as c FROM generations WHERE is_favorite = 1');
      const highQuality = getCount(db, "SELECT COUNT(*) as c FROM generations WHERE quality = 'high'");
      const standardQuality = getCount(db, "SELECT COUNT(*) as c FROM generations WHERE quality = 'standard'");
      const portrait = getCount(db, 'SELECT COUNT(*) as c FROM generations WHERE height > width');
      const landscape = getCount(db, 'SELECT COUNT(*) as c FROM generations WHERE width > height');
      const square = getCount(db, 'SELECT COUNT(*) as c FROM generations WHERE width = height');
      const dateRange = getOne(db, 'SELECT MIN(created_at) as earliest, MAX(created_at) as latest FROM generations');

      return {
        total, images, videos, favorites,
        quality: { high: highQuality, standard: standardQuality },
        dimensions: { portrait, landscape, square },
        dateRange: { earliest: dateRange?.earliest, latest: dateRange?.latest }
      };
    },

    close() {
      db.close();
    }
  };
}

// Mutation functions (need write access)
export function createMutationDb(dbPath: string, generationsDir: string, thumbDir: string, SQL: any) {
  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer) as SqlJsDatabase;
  const trashDir = path.join(path.dirname(generationsDir), 'trash');

  function save() {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  }

  return {
    deleteGeneration(genId: string): { success: boolean; error?: string } {
      const row = getOne(db, 'SELECT * FROM generations WHERE gen_id = ?', [genId]);
      if (!row) return { success: false, error: 'Not found' };

      const srcDir = path.join(generationsDir, genId);
      const destDir = path.join(trashDir, genId);

      try {
        fs.mkdirSync(trashDir, { recursive: true });
        if (fs.existsSync(srcDir)) fs.renameSync(srcDir, destDir);
        const thumbPath = path.join(thumbDir, `${genId}.webp`);
        if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
        db.run('DELETE FROM generations WHERE gen_id = ?', [genId]);
        db.run('DELETE FROM generations_fts WHERE gen_id = ?', [genId]);
        if (row.task_id) refreshTaskStats(db);
        save();
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },

    restoreGeneration(genId: string): { success: boolean; error?: string } {
      const trashGenDir = path.join(trashDir, genId);
      if (!fs.existsSync(trashGenDir)) return { success: false, error: 'Not found in trash' };

      const destDir = path.join(generationsDir, genId);

      try {
        fs.renameSync(trashGenDir, destDir);

        const metaPath = path.join(destDir, 'metadata.json');
        if (fs.existsSync(metaPath)) {
          const raw = fs.readFileSync(metaPath, 'utf8');
          const meta = JSON.parse(raw);
          const filePrimary = pickRestoredFile(meta, destDir);

          db.run(`
            INSERT OR IGNORE INTO generations
            (gen_id, task_id, prompt, created_at, type, width, height, quality, seed, is_favorite, has_thumb, file_primary)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
          `, [
            meta.gen_id, meta.task_id || null, meta.prompt || '',
            meta.created_at || null, meta.type || 'image_gen',
            meta.width || 0, meta.height || 0, meta.quality || null,
            meta.seed || null, meta.is_favorite ? 1 : 0, filePrimary
          ]);

          if (meta.prompt) {
            db.run('INSERT OR IGNORE INTO generations_fts(gen_id, prompt) VALUES (?, ?)', [meta.gen_id, meta.prompt]);
          }
          refreshTaskStats(db);
        }

        save();
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },

    getTrash(): { items: any[]; count: number } {
      if (!fs.existsSync(trashDir)) return { items: [], count: 0 };

      const entries = fs.readdirSync(trashDir).filter(e => e.startsWith('gen_'));
      const items: any[] = [];

      for (const dir of entries) {
        const metaPath = path.join(trashDir, dir, 'metadata.json');
        try {
          const raw = fs.readFileSync(metaPath, 'utf8');
          const meta = JSON.parse(raw);
          items.push({
            gen_id: meta.gen_id,
            prompt: meta.prompt || '',
            type: meta.type || 'image_gen',
            width: meta.width || 0,
            height: meta.height || 0,
            file_primary: pickRestoredFile(meta, path.join(trashDir, dir))
          });
        } catch {
          items.push({ gen_id: dir, prompt: '', type: 'unknown', width: 0, height: 0, file_primary: null });
        }
      }

      return { items, count: items.length };
    },

    trashDelete(genId: string): { success: boolean } {
      const genDir = path.join(trashDir, genId);
      try {
        if (fs.existsSync(genDir)) fs.rmSync(genDir, { recursive: true, force: true });
        return { success: true };
      } catch {
        return { success: false };
      }
    },

    emptyTrash(): { success: boolean } {
      try {
        if (fs.existsSync(trashDir)) fs.rmSync(trashDir, { recursive: true, force: true });
        return { success: true };
      } catch {
        return { success: false };
      }
    },

    close() {
      db.close();
    }
  };
}

function pickRestoredFile(meta: any, genDir: string): string | null {
  const files: string[] = meta.files || [];
  if (meta.type === 'video_gen') {
    for (const f of ['video.mp4', 'original.mp4']) {
      if (files.includes(f) && fs.existsSync(path.join(genDir, f))) return f;
    }
    return files.find(f => fs.existsSync(path.join(genDir, f))) || files[0] || null;
  }
  for (const f of ['original.png', 'image.png', 'image.webp']) {
    if (files.includes(f) && fs.existsSync(path.join(genDir, f))) return f;
  }
  return files.find(f => fs.existsSync(path.join(genDir, f))) || files[0] || null;
}

function refreshTaskStats(db: SqlJsDatabase): void {
  db.run('DELETE FROM task_stats');
  db.run(`
    INSERT INTO task_stats (task_id, variant_count)
    SELECT task_id, COUNT(*) FROM generations
    WHERE task_id IS NOT NULL
    GROUP BY task_id
    HAVING COUNT(*) > 1
  `);
}
