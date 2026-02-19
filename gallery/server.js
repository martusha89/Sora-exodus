import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, rename, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const PAGE_SIZE = 60;

export function startServer(port, dbPath, thumbDir, generationsDir, htmlPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  const trashDir = path.join(path.dirname(generationsDir), 'trash');

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${port}`);
      const pathname = url.pathname;

      // Static routes
      if (pathname === '/' || pathname === '/index.html') {
        return serveFile(res, htmlPath, '.html');
      }

      // API routes
      if (pathname === '/api/generations') return apiGenerations(db, url, res);
      if (pathname === '/api/search') return apiSearch(db, url, res);
      if (pathname === '/api/stats') return apiStats(db, res);
      if (pathname.startsWith('/api/generations/') && pathname.endsWith('/restore') && req.method === 'POST') {
        const id = pathname.split('/')[3];
        return apiRestore(db, id, generationsDir, trashDir, thumbDir, res);
      }
      if (pathname.startsWith('/api/generations/') && req.method === 'DELETE') {
        const id = pathname.split('/')[3];
        return apiDelete(db, id, generationsDir, trashDir, thumbDir, res);
      }
      if (pathname.startsWith('/api/generations/')) {
        const id = pathname.split('/')[3];
        return apiGeneration(db, id, res);
      }
      if (pathname.startsWith('/api/tasks/')) {
        const id = pathname.split('/')[3];
        return apiTask(db, id, res);
      }
      if (pathname === '/api/trash' && req.method === 'DELETE') {
        return apiEmptyTrash(trashDir, res);
      }
      if (pathname === '/api/trash') {
        return apiTrash(trashDir, res);
      }
      if (pathname.startsWith('/api/trash/') && req.method === 'DELETE') {
        const id = pathname.split('/')[3];
        return apiTrashDelete(id, trashDir, res);
      }

      // Thumbnail route
      if (pathname.startsWith('/thumb/')) {
        const genId = pathname.split('/')[2];
        const thumbPath = path.join(thumbDir, `${genId}.webp`);
        return serveFile(res, thumbPath, '.webp');
      }

      // Media route (original files)
      if (pathname.startsWith('/media/')) {
        const parts = pathname.split('/');
        const genId = parts[2];
        const filename = parts[3];
        if (!genId || !filename || filename.includes('..')) {
          return send(res, 400, { error: 'Bad request' });
        }
        const filePath = path.join(generationsDir, genId, filename);
        return serveMedia(req, res, filePath, filename);
      }

      // Trash media route
      if (pathname.startsWith('/trash-media/')) {
        const parts = pathname.split('/');
        const genId = parts[2];
        const filename = parts[3];
        if (!genId || !filename || filename.includes('..')) {
          return send(res, 400, { error: 'Bad request' });
        }
        const filePath = path.join(trashDir, genId, filename);
        return serveMedia(req, res, filePath, filename);
      }

      send(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error('Server error:', err);
      send(res, 500, { error: 'Internal server error' });
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${port} is already in use. Kill the existing process or use a different port.\n`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, () => {
    console.log(`  Gallery server running at http://localhost:${port}\n`);
  });

  return server;
}

function apiGenerations(db, url, res) {
  const page = parseInt(url.searchParams.get('page')) || 1;
  const offset = (page - 1) * PAGE_SIZE;

  let where = [];
  let params = [];

  const type = url.searchParams.get('type');
  if (type) { where.push('g.type = ?'); params.push(type); }

  const quality = url.searchParams.get('quality');
  if (quality) { where.push('g.quality = ?'); params.push(quality); }

  const dims = url.searchParams.get('dims');
  if (dims === 'portrait') { where.push('g.height > g.width'); }
  else if (dims === 'landscape') { where.push('g.width > g.height'); }
  else if (dims === 'square') { where.push('g.width = g.height'); }

  const dateFrom = url.searchParams.get('from');
  if (dateFrom) { where.push('g.created_at >= ?'); params.push(dateFrom); }

  const dateTo = url.searchParams.get('to');
  if (dateTo) { where.push('g.created_at <= ?'); params.push(dateTo + 'T23:59:59Z'); }

  const fav = url.searchParams.get('favorites');
  if (fav === '1') { where.push('g.is_favorite = 1'); }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  const countSql = `SELECT COUNT(*) as total FROM generations g ${whereClause}`;
  const total = db.prepare(countSql).get(...params).total;

  const dataSql = `
    SELECT g.gen_id, g.task_id, g.prompt, g.created_at, g.type, g.width, g.height,
           g.quality, g.is_favorite, g.has_thumb, g.file_primary,
           COALESCE(ts.variant_count, 0) as variant_count
    FROM generations g
    LEFT JOIN task_stats ts ON g.task_id = ts.task_id
    ${whereClause}
    ORDER BY g.created_at DESC
    LIMIT ? OFFSET ?
  `;

  const rows = db.prepare(dataSql).all(...params, PAGE_SIZE, offset);

  send(res, 200, {
    generations: rows,
    total,
    page,
    pages: Math.ceil(total / PAGE_SIZE),
    pageSize: PAGE_SIZE,
  });
}

function apiSearch(db, url, res) {
  const q = url.searchParams.get('q');
  if (!q || q.trim().length === 0) {
    return send(res, 200, { generations: [], total: 0 });
  }

  const page = parseInt(url.searchParams.get('page')) || 1;
  const offset = (page - 1) * PAGE_SIZE;

  // Sanitize FTS5 query — wrap each word in quotes to avoid syntax errors
  const sanitized = q.trim().split(/\s+/).map(w => `"${w.replace(/"/g, '')}"`).join(' ');

  try {
    const countSql = `
      SELECT COUNT(*) as total FROM generations_fts
      WHERE generations_fts MATCH ?
    `;
    const total = db.prepare(countSql).get(sanitized).total;

    const dataSql = `
      SELECT g.gen_id, g.task_id, g.prompt, g.created_at, g.type, g.width, g.height,
             g.quality, g.is_favorite, g.has_thumb, g.file_primary,
             COALESCE(ts.variant_count, 0) as variant_count
      FROM generations_fts fts
      JOIN generations g ON fts.gen_id = g.gen_id
      LEFT JOIN task_stats ts ON g.task_id = ts.task_id
      WHERE generations_fts MATCH ?
      ORDER BY rank
      LIMIT ? OFFSET ?
    `;

    const rows = db.prepare(dataSql).all(sanitized, PAGE_SIZE, offset);

    send(res, 200, {
      generations: rows,
      total,
      page,
      pages: Math.ceil(total / PAGE_SIZE),
      pageSize: PAGE_SIZE,
      query: q,
    });
  } catch (err) {
    send(res, 200, { generations: [], total: 0, query: q, error: 'Search syntax error' });
  }
}

function apiGeneration(db, id, res) {
  const row = db.prepare(`
    SELECT g.*, COALESCE(ts.variant_count, 0) as variant_count
    FROM generations g
    LEFT JOIN task_stats ts ON g.task_id = ts.task_id
    WHERE g.gen_id = ?
  `).get(id);

  if (!row) return send(res, 404, { error: 'Not found' });
  send(res, 200, row);
}

function apiTask(db, taskId, res) {
  const rows = db.prepare(`
    SELECT gen_id, prompt, created_at, type, width, height, quality, has_thumb, file_primary
    FROM generations
    WHERE task_id = ?
    ORDER BY created_at ASC
  `).all(taskId);

  send(res, 200, { task_id: taskId, variants: rows, count: rows.length });
}

function apiStats(db, res) {
  const total = db.prepare('SELECT COUNT(*) as c FROM generations').get().c;
  const images = db.prepare("SELECT COUNT(*) as c FROM generations WHERE type = 'image_gen'").get().c;
  const videos = db.prepare("SELECT COUNT(*) as c FROM generations WHERE type = 'video_gen'").get().c;
  const favorites = db.prepare('SELECT COUNT(*) as c FROM generations WHERE is_favorite = 1').get().c;
  const highQuality = db.prepare("SELECT COUNT(*) as c FROM generations WHERE quality = 'high'").get().c;
  const standardQuality = db.prepare("SELECT COUNT(*) as c FROM generations WHERE quality = 'standard'").get().c;
  const portrait = db.prepare('SELECT COUNT(*) as c FROM generations WHERE height > width').get().c;
  const landscape = db.prepare('SELECT COUNT(*) as c FROM generations WHERE width > height').get().c;
  const square = db.prepare('SELECT COUNT(*) as c FROM generations WHERE width = height').get().c;

  const dateRange = db.prepare('SELECT MIN(created_at) as earliest, MAX(created_at) as latest FROM generations').get();

  send(res, 200, {
    total, images, videos, favorites,
    quality: { high: highQuality, standard: standardQuality },
    dimensions: { portrait, landscape, square },
    dateRange: { earliest: dateRange.earliest, latest: dateRange.latest },
  });
}

async function apiDelete(db, genId, generationsDir, trashDir, thumbDir, res) {
  const row = db.prepare('SELECT * FROM generations WHERE gen_id = ?').get(genId);
  if (!row) return send(res, 404, { error: 'Not found' });

  const srcDir = path.join(generationsDir, genId);
  const destDir = path.join(trashDir, genId);

  try {
    await mkdir(trashDir, { recursive: true });
    if (existsSync(srcDir)) {
      await rename(srcDir, destDir);
    }
    // Remove thumbnail
    const thumbPath = path.join(thumbDir, `${genId}.webp`);
    if (existsSync(thumbPath)) {
      await rm(thumbPath);
    }
    // Remove from DB
    db.prepare('DELETE FROM generations WHERE gen_id = ?').run(genId);
    db.prepare('DELETE FROM generations_fts WHERE gen_id = ?').run(genId);
    // Refresh task_stats
    if (row.task_id) refreshTaskStats(db, row.task_id);

    send(res, 200, { deleted: genId });
  } catch (err) {
    console.error('Delete error:', err);
    send(res, 500, { error: 'Failed to delete' });
  }
}

async function apiRestore(db, genId, generationsDir, trashDir, thumbDir, res) {
  const trashGenDir = path.join(trashDir, genId);
  if (!existsSync(trashGenDir)) {
    return send(res, 404, { error: 'Not found in trash' });
  }

  const destDir = path.join(generationsDir, genId);
  const metaPath = path.join(trashGenDir, 'metadata.json');

  try {
    // Move back
    await rename(trashGenDir, destDir);

    // Reimport metadata
    if (existsSync(path.join(destDir, 'metadata.json'))) {
      const raw = await readFile(path.join(destDir, 'metadata.json'), 'utf8');
      const meta = JSON.parse(raw);
      const filePrimary = pickRestoredFile(meta, destDir);

      db.prepare(`
        INSERT OR IGNORE INTO generations
        (gen_id, task_id, prompt, created_at, type, width, height, quality, seed, is_favorite, has_thumb, file_primary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `).run(
        meta.gen_id, meta.task_id || null, meta.prompt || '',
        meta.created_at || null, meta.type || 'image_gen',
        meta.width || 0, meta.height || 0, meta.quality || null,
        meta.seed || null, meta.is_favorite ? 1 : 0, filePrimary
      );

      // Restore FTS
      if (meta.prompt) {
        db.prepare('INSERT OR IGNORE INTO generations_fts(gen_id, prompt) VALUES (?, ?)').run(meta.gen_id, meta.prompt);
      }

      // Refresh task_stats
      if (meta.task_id) refreshTaskStats(db, meta.task_id);

      // Regenerate thumbnail asynchronously
      if (meta.type === 'image_gen' && filePrimary) {
        regenThumb(destDir, filePrimary, genId, thumbDir, db).catch(() => {});
      }
    }

    send(res, 200, { restored: genId });
  } catch (err) {
    console.error('Restore error:', err);
    send(res, 500, { error: 'Failed to restore' });
  }
}

async function apiTrash(trashDir, res) {
  try {
    if (!existsSync(trashDir)) {
      return send(res, 200, { items: [], count: 0 });
    }
    const entries = await readdir(trashDir);
    const genDirs = entries.filter(e => e.startsWith('gen_'));
    const items = [];

    for (const dir of genDirs) {
      const metaPath = path.join(trashDir, dir, 'metadata.json');
      try {
        const raw = await readFile(metaPath, 'utf8');
        const meta = JSON.parse(raw);
        items.push({
          gen_id: meta.gen_id,
          prompt: meta.prompt || '',
          type: meta.type || 'image_gen',
          width: meta.width || 0,
          height: meta.height || 0,
          file_primary: pickRestoredFile(meta, path.join(trashDir, dir)),
        });
      } catch {
        items.push({ gen_id: dir, prompt: '', type: 'unknown', width: 0, height: 0, file_primary: null });
      }
    }

    send(res, 200, { items, count: items.length });
  } catch (err) {
    send(res, 200, { items: [], count: 0 });
  }
}

async function apiEmptyTrash(trashDir, res) {
  try {
    if (existsSync(trashDir)) {
      await rm(trashDir, { recursive: true, force: true });
    }
    send(res, 200, { emptied: true });
  } catch (err) {
    console.error('Empty trash error:', err);
    send(res, 500, { error: 'Failed to empty trash' });
  }
}

async function apiTrashDelete(genId, trashDir, res) {
  const genDir = path.join(trashDir, genId);
  try {
    if (existsSync(genDir)) {
      await rm(genDir, { recursive: true, force: true });
    }
    send(res, 200, { deleted: genId });
  } catch (err) {
    send(res, 500, { error: 'Failed to permanently delete' });
  }
}

function pickRestoredFile(meta, genDir) {
  const files = meta.files || [];
  if (meta.type === 'video_gen') {
    for (const f of ['video.mp4', 'original.mp4']) {
      if (files.includes(f) && existsSync(path.join(genDir, f))) return f;
    }
    return files.find(f => existsSync(path.join(genDir, f))) || files[0] || null;
  }
  for (const f of ['original.png', 'image.png', 'image.webp']) {
    if (files.includes(f) && existsSync(path.join(genDir, f))) return f;
  }
  return files.find(f => existsSync(path.join(genDir, f))) || files[0] || null;
}

function refreshTaskStats(db, taskId) {
  db.prepare('DELETE FROM task_stats WHERE task_id = ?').run(taskId);
  db.prepare(`
    INSERT OR IGNORE INTO task_stats (task_id, variant_count)
    SELECT task_id, COUNT(*) FROM generations
    WHERE task_id = ?
    GROUP BY task_id
    HAVING COUNT(*) > 1
  `).run(taskId);
}

async function regenThumb(genDir, filePrimary, genId, thumbDir, db) {
  try {
    const sharp = (await import('sharp')).default;
    const srcPath = path.join(genDir, filePrimary);
    const thumbPath = path.join(thumbDir, `${genId}.webp`);
    await sharp(srcPath).resize(300, null, { withoutEnlargement: true }).webp({ quality: 75 }).toFile(thumbPath);
    db.prepare('UPDATE generations SET has_thumb = 1 WHERE gen_id = ?').run(genId);
  } catch {}
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function serveFile(res, filePath, ext) {
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

async function serveMedia(req, res, filePath, filename) {
  const ext = path.extname(filename).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const stats = await stat(filePath);
    const fileSize = stats.size;
    const range = req.headers.range;

    if (range && ext === '.mp4') {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : Math.min(start + 5 * 1024 * 1024, fileSize - 1);
      const chunkSize = end - start + 1;

      const { createReadStream } = await import('node:fs');
      const stream = createReadStream(filePath, { start, end });

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mime,
      });
      stream.pipe(res);
    } else {
      const data = await readFile(filePath);
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': fileSize,
        'Accept-Ranges': 'bytes',
      });
      res.end(data);
    }
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}
