#!/usr/bin/env node
/**
 * Remove duplicate webp files where a PNG original exists.
 * Keeps the higher quality PNG, deletes the webp to save space.
 */

import { readdirSync, unlinkSync, statSync, existsSync } from 'fs';
import { join } from 'path';

const EXPORT_DIR = process.argv[2] || 'sora-export';
const GEN_DIR = join(EXPORT_DIR, 'generations');

if (!existsSync(GEN_DIR)) {
  console.error(`  [ERROR] No generations directory found at ${GEN_DIR}`);
  process.exit(1);
}

const folders = readdirSync(GEN_DIR);
let deleted = 0;
let savedBytes = 0;
let skipped = 0;

console.log();
console.log(`  Cleaning up ${folders.length} generation folders...`);
console.log();

for (const folder of folders) {
  const dir = join(GEN_DIR, folder);
  const stat = statSync(dir);
  if (!stat.isDirectory()) continue;

  const webp = join(dir, 'image.webp');
  const png = join(dir, 'original.png');

  if (existsSync(webp) && existsSync(png)) {
    const webpSize = statSync(webp).size;
    unlinkSync(webp);
    deleted++;
    savedBytes += webpSize;

    if (deleted % 500 === 0) {
      const savedMB = (savedBytes / 1024 / 1024).toFixed(1);
      console.log(`  Progress: ${deleted} webps deleted (${savedMB} MB freed)`);
    }
  } else {
    skipped++;
  }
}

const savedMB = (savedBytes / 1024 / 1024).toFixed(1);
const savedGB = (savedBytes / 1024 / 1024 / 1024).toFixed(2);

console.log();
console.log(`  Done!`);
console.log(`    Deleted: ${deleted} webp files`);
console.log(`    Skipped: ${skipped} (no duplicate or webp-only)`);
console.log(`    Space freed: ${savedMB} MB (${savedGB} GB)`);
console.log();
