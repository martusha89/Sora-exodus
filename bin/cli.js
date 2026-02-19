#!/usr/bin/env node

import { resolve } from 'path';
import { existsSync, readFileSync } from 'fs';

const VERSION = '1.1.0';

const HELP = `
  sora-exodus v${VERSION}
  Bulk export your Sora generations before OpenAI kills the platform.

  USAGE
    sora-exodus [command] [options]

  COMMANDS
    run         Full run: collect + export (default)
    collect     Collect all generation data via Sora API
    export      Download images/videos for collected generations
    status      Show export progress
    gallery     Browse your exported generations in a local web gallery

  OPTIONS
    --output, -o <dir>     Output directory (default: ./sora-export)
    --delay, -d <ms>       Delay between downloads in ms (default: 2500)
    --headless             Run browser without visible window
    --help, -h             Show this help
    --version, -v          Show version

  EXAMPLES
    npx sora-exodus                    # Full export with defaults
    npx sora-exodus collect            # Just collect generation data
    npx sora-exodus export             # Download (after collecting)
    npx sora-exodus status             # Check progress
    npx sora-exodus -o ./my-backup     # Custom output directory
    npx sora-exodus gallery            # Browse exports in local gallery
    npx sora-exodus gallery -p 8080    # Gallery on custom port

  FIRST RUN
    A browser window will open. Log into sora.chatgpt.com if prompted.
    Your session is saved for future runs.
`;

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    command: 'run',
    output: 'sora-export',
    delay: 2500,
    headless: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case 'collect':
      case 'export':
      case 'run':
      case 'status':
      case 'gallery':
        options.command = arg;
        break;
      case '--port':
      case '-p':
        options.port = parseInt(args[++i], 10);
        break;
      case '--output':
      case '-o':
        options.output = args[++i];
        break;
      case '--delay':
      case '-d':
        options.delay = parseInt(args[++i], 10);
        break;
      case '--headless':
        options.headless = true;
        break;
      case '--help':
      case '-h':
        console.log(HELP);
        process.exit(0);
      case '--version':
      case '-v':
        console.log(VERSION);
        process.exit(0);
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`);
          console.log(HELP);
          process.exit(1);
        }
    }
  }

  options.output = resolve(options.output);
  return options;
}

function showStatus(outputDir) {
  const genIdsPath = resolve(outputDir, 'gen_ids.json');
  const progressPath = resolve(outputDir, 'progress.json');

  if (!existsSync(genIdsPath)) {
    console.log('  No data yet. Run `sora-exodus collect` first.');
    return;
  }

  const collected = JSON.parse(readFileSync(genIdsPath, 'utf-8'));
  console.log(`  Tasks collected: ${collected.task_count}`);
  console.log(`  Generations found: ${collected.generation_count}`);
  console.log(`  Collected at: ${collected.collected_at}`);

  if (existsSync(progressPath)) {
    const data = JSON.parse(readFileSync(progressPath, 'utf-8'));
    const total = data.total_ids || 0;
    const completed = (data.completed || []).length;
    const failed = Object.keys(data.failed || {}).length;
    const remaining = total - completed - failed;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    console.log();
    console.log('  Export progress:');
    console.log(`    Total:     ${total}`);
    console.log(`    Exported:  ${completed} (${pct}%)`);
    console.log(`    Failed:    ${failed}`);
    console.log(`    Remaining: ${remaining}`);

    if (data.last_run) {
      console.log(`    Last run:  ${data.last_run}`);
    }
  } else {
    console.log('  No exports started yet.');
  }
}

async function launchGallery(options) {
  const { join, dirname } = await import('path');
  const { fileURLToPath } = await import('url');
  const { existsSync } = await import('fs');
  const { mkdir } = await import('fs/promises');

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const generationsDir = join(options.output, 'generations');

  if (!existsSync(generationsDir)) {
    console.error(`  No generations found at: ${generationsDir}`);
    console.error('  Run `sora-exodus export` first to download your generations.');
    process.exit(1);
  }

  const port = options.port || 3456;
  const dataDir = join(options.output, 'gallery-data');
  const dbPath = join(dataDir, 'gallery.db');
  const thumbDir = join(dataDir, 'thumbs');
  const htmlPath = join(__dirname, '..', 'gallery', 'index.html');

  await mkdir(thumbDir, { recursive: true });

  const { runImport } = await import('../gallery/import.js');
  const { startServer } = await import('../gallery/server.js');

  if (!existsSync(dbPath)) {
    await runImport(dbPath, thumbDir, generationsDir);
  } else {
    console.log('  Gallery database found. Skipping import.');
    console.log('  (Delete gallery-data/ to force reimport)\n');
  }

  startServer(port, dbPath, thumbDir, generationsDir, htmlPath);
}

async function main() {
  const options = parseArgs(process.argv);

  console.log();
  console.log(`  sora-exodus v${VERSION}`);
  console.log('  ========================');
  console.log();

  if (options.command === 'status') {
    showStatus(options.output);
    return;
  }

  if (options.command === 'gallery') {
    await launchGallery(options);
    return;
  }

  const { launchBrowser, ensureAuth } = await import('../src/browser.js');
  const { captureAuthToken, collectAll } = await import('../src/collect.js');
  const { exportGenerations } = await import('../src/export.js');
  const { log, ensureDir } = await import('../src/utils.js');

  ensureDir(options.output);

  let context;

  try {
    context = await launchBrowser({ headless: options.headless });

    const page = context.pages()[0] || await context.newPage();
    await ensureAuth(page);

    console.log();

    // Capture auth token for API access
    const authToken = await captureAuthToken(page);
    console.log();

    if (options.command === 'collect' || options.command === 'run') {
      log.info('=== Phase 1: Collecting Generations via API ===');
      console.log();
      await collectAll(page, options.output, authToken);
      console.log();
    }

    if (options.command === 'export' || options.command === 'run') {
      log.info('=== Phase 2: Downloading Images & Videos ===');
      console.log();
      await exportGenerations(page, options.output, { delay: options.delay });
      console.log();
    }
  } catch (err) {
    console.error(`\n  [ERROR] ${err.message}`);
    process.exit(1);
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

main();
