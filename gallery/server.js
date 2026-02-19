import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
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
      if (pathname.startsWith('/api/generations/')) {
        const id = pathname.split('/')[3];
        return apiGeneration(db, id, res);
      }
      if (pathname.startsWith('/api/tasks/')) {
        const id = pathname.split('/')[3];
        return apiTask(db, id, res);
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
