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

# Export only your favorited generations
sora-exodus --favorites

# Browse your exports in a local gallery
sora-exodus gallery
```

### Options

| Flag | Description | Default |
|---|---|---|
| `--output, -o` | Output directory | `./sora-export` |
| `--delay, -d` | Delay between downloads (ms) | `2500` |
| `--favorites` | Only export favorited generations | `false` |
| `--headless` | Run browser without visible window | `false` |
| `--port, -p` | Gallery server port | `3456` |

## Gallery

After exporting, browse your generations in a local web gallery:

```bash
sora-exodus gallery
```

Opens a searchable grid at `http://localhost:3456` with:
- **Thumbnails** for all images (auto-generated on first run)
- **Full-text prompt search** with ranked results
- **Filters** by type, quality, dimensions, date range, favorites
- **Lightbox** with full-size images/videos, metadata panel, keyboard navigation
- **Video preview** on hover, full playback in lightbox
- **Variant grouping** to see all outputs from the same prompt

First run imports metadata and generates thumbnails (~6 minutes for 11k generations). Subsequent runs start instantly.

```bash
sora-exodus gallery              # Default port 3456
sora-exodus gallery -p 8080      # Custom port
sora-exodus gallery -o ./backup  # Point to different export dir
```

Requires Node.js 22+ (uses built-in SQLite).

## Favorites only

Don't want to export everything? Just your starred picks:

```bash
node bin/cli.js --favorites
```

This collects your full library from the API (takes under a minute), then filters down to only the generations you've favorited in Sora's web interface. Only those get downloaded.

If you have 2,000 generations but only 30 favorites, you'll get 30 images in under a minute.

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
├── gallery-data/              # Created by `sora-exodus gallery`
│   ├── gallery.db             # SQLite database with FTS5 index
│   └── thumbs/                # 300px webp thumbnails
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

- **Node.js 18+** (22+ for gallery feature)
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

## Disclaimer

This tool is intended for personal use to export your own Sora generations. It accesses Sora's backend API using your own authenticated session to download content you created. No official export tool is provided by OpenAI.

Automated access may not be explicitly permitted by OpenAI's Terms of Service. Use this tool at your own discretion and risk. The authors are not responsible for any consequences arising from its use.

Users in the EU/UK may have a right to data portability under GDPR (Article 20).

## License

MIT
