import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runImport } from './import.js';
import { startServer } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = 3456;
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'gallery.db');
const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
const GENERATIONS_DIR = path.resolve(__dirname, '..', 'sora-export', 'generations');
const HTML_PATH = path.join(__dirname, 'index.html');

const importOnly = process.argv.includes('--import-only');

async function main() {
  console.log('\n  ╔════════════════════════════╗');
  console.log('  ║      Sora Gallery           ║');
  console.log('  ╚════════════════════════════╝\n');

  if (!existsSync(GENERATIONS_DIR)) {
    console.error(`  ERROR: Generations directory not found:\n  ${GENERATIONS_DIR}\n`);
    console.error('  Make sure sora-export/generations/ exists relative to gallery/');
    process.exit(1);
  }

  // Import if database doesn't exist or --import-only flag
  const needsImport = !existsSync(DB_PATH) || importOnly;

  if (needsImport) {
    await runImport(DB_PATH, THUMB_DIR, GENERATIONS_DIR);
    if (importOnly) {
      console.log('  Import complete. Exiting.\n');
      process.exit(0);
    }
  } else {
    console.log('  Database found. Skipping import.');
    console.log('  (Run with --import-only to re-import)\n');
  }

  startServer(PORT, DB_PATH, THUMB_DIR, GENERATIONS_DIR, HTML_PATH);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
