# sora-exodus

Bulk export your Sora generations (images, videos, and prompts) before OpenAI shuts down the platform.

No official export exists. Chrome extensions are unreliable. This tool uses Sora's own API to download everything — every image, every video, every prompt — to your local machine.

## What it exports

For each generation:
- Source image (`.webp`) and original (`.png` when available)
- Videos (`.mp4`/`.webm`) for video generations
- Full prompt text
- Metadata: timestamps, dimensions, seed, quality setting, generation type

Plus a master `index.json` and `prompts.csv` for easy searching.

## Quick start

```bash
git clone https://github.com/YOUR_USERNAME/sora-exodus.git
cd sora-exodus
npm install
npx playwright install chromium
node bin/cli.js
```

**First run:** A browser window opens. Log into [sora.chatgpt.com](https://sora.chatgpt.com). Once you're on the library page, the script takes over. Your session is saved for future runs.

**Subsequent runs:** No login needed. Just `node bin/cli.js`.

## How it works

1. **Captures your auth token** from the browser session
2. **Paginates through Sora's API** to collect every generation with metadata and direct image URLs
3. **Downloads images/videos** directly from OpenAI's CDN — no page scraping, no DOM parsing
4. **Saves everything** in an organized folder structure with full metadata

Collection takes under a minute, even for thousands of generations. Downloads run at ~2.5 seconds each to avoid rate limiting.

## Usage

```bash
# Full export (collect + download)
sora-exodus

# Just collect generation data (no downloads)
sora-exodus collect

# Download images (after collecting)
sora-exodus export

# Check progress
sora-exodus status
```

### Options

| Flag | Description | Default |
|---|---|---|
| `--output, -o` | Output directory | `./sora-export` |
| `--delay, -d` | Delay between downloads (ms) | `2500` |
| `--headless` | Run browser without visible window | `false` |

## Resume support

Progress is tracked automatically. If the script crashes or you stop it (Ctrl+C), run it again — it picks up where it left off. No work is lost.

## Output structure

```
sora-export/
├── index.json              # Master index of all exported generations
├── gen_ids.json            # Full generation data from API
├── tasks.json              # Raw API task data
├── progress.json           # Resume tracker
├── prompts.csv             # All prompts in spreadsheet format
└── generations/
    ├── gen_01khny1fas.../
    │   ├── metadata.json   # Prompt, timestamps, dimensions, seed
    │   ├── image.webp      # Source image
    │   └── original.png    # Original quality (when available)
    ├── gen_01khk2aaaf.../
    │   ├── metadata.json
    │   └── video.mp4       # Video generation
    └── ...
```

### metadata.json

```json
{
  "gen_id": "gen_01khny1fasfvjra4tb3gzdrrgv",
  "task_id": "task_01khny1ej3e0stx9qe0efrmkce",
  "prompt": "A cinematic shot of...",
  "created_at": "2026-02-17T13:54:47.330977Z",
  "type": "image_gen",
  "width": 1024,
  "height": 1536,
  "quality": "high",
  "seed": 819217102,
  "is_favorite": false,
  "files": ["image.webp", "original.png"],
  "exported_at": "2026-02-18T22:00:00.000Z"
}
```

## Requirements

- **Node.js 18+**
- **Google Chrome** installed
- An account on [sora.chatgpt.com](https://sora.chatgpt.com) with generations to export

## How long does it take?

- **Collection:** Under 1 minute for any number of generations
- **Downloads:** ~2.5 seconds per generation. For reference:
  - 100 generations: ~4 minutes
  - 1,000 generations: ~40 minutes
  - 5,000 generations: ~3.5 hours
  - 10,000+ generations: overnight

## Troubleshooting

**"Could not capture auth token"**
Make sure you're logged into Sora in the browser window that opens. Scroll around on the library page to trigger API calls.

**Script crashes mid-export**
Just run it again. It resumes automatically.

**Image URLs expire**
Sora's image URLs are signed and expire after about a week. If you collected but didn't download in time, run `collect` again to get fresh URLs, then `export`.

**Browser won't launch**
Make sure Chrome is installed. The tool uses Playwright with your installed Chrome, not a bundled browser.

## License

MIT
