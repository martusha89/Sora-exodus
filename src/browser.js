import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import { log, sleep } from './utils.js';

const SORA_BASE = 'https://sora.chatgpt.com';

// Dedicated session directory — persists between runs
const SESSION_DIR = join(homedir(), '.sora-exodus-session');

/**
 * Launch browser with a persistent session directory.
 *
 * First run: user logs in manually — session is saved.
 * Subsequent runs: session is restored automatically.
 */
export async function launchBrowser(options = {}) {
  const { headless = false } = options;

  mkdirSync(SESSION_DIR, { recursive: true });

  const isFirstRun = !existsSync(join(SESSION_DIR, 'Default', 'Network'));

  if (isFirstRun) {
    log.info('First run — you\'ll need to log into Sora manually.');
    log.info('Your session will be saved for future runs.');
  } else {
    log.info('Using saved session from previous run.');
  }

  log.info('Launching browser...');

  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    channel: 'chrome',
    headless,
    viewport: { width: 1280, height: 900 },
    timeout: 60000,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  log.success('Browser launched.');
  return context;
}

/**
 * Ensure the user is authenticated with Sora.
 * If not logged in, navigates to Sora and waits for the user to log in manually.
 */
export async function ensureAuth(page) {
  log.info('Checking Sora authentication...');

  await page.goto(`${SORA_BASE}/library`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const url = page.url();
  const isLoggedIn = url.includes('sora.chatgpt.com') && !url.includes('auth') && !url.includes('login');

  if (isLoggedIn) {
    log.success('Authenticated with Sora.');
    return true;
  }

  // Not logged in — wait for user to log in manually
  log.warn('Not logged in. Please log into Sora in the browser window.');
  log.info('Waiting for you to complete login...');
  log.info('(the script will continue automatically once you reach the library)');
  console.log();

  // Poll until we land on the library page
  const maxWait = 5 * 60 * 1000; // 5 minutes
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    await sleep(2000);

    try {
      const currentUrl = page.url();
      if (currentUrl.includes('sora.chatgpt.com/library')) {
        log.success('Login detected! Continuing...');
        return true;
      }
    } catch {
      // page might be navigating
    }
  }

  throw new Error('Login timed out after 5 minutes. Run the script again to retry.');
}

export { SORA_BASE };
