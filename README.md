# sponsors

[![CI](https://img.shields.io/github/actions/workflow/status/kohltastrophe/sponsors/release.yml?style=for-the-badge)](https://github.com/kohltastrophe/sponsors/actions/workflows/release.yml) [![License](https://img.shields.io/github/license/kohltastrophe/sponsors?style=for-the-badge)](LICENSE.md) [![GitHub Release](https://img.shields.io/github/v/release/kohltastrophe/sponsors?style=for-the-badge)](https://github.com/kohltastrophe/sponsors/releases)

Zero-dependency `node24` GitHub Action and CLI that generates a light/dark-aware `sponsors.svg` wall and platform CTA cards (`sponsor-github.svg`, `sponsor-kofi.svg`) from GitHub Sponsors, Ko-fi, and OpenCollective. It publishes generated SVGs and rolling Ko-fi state to an orphan `badges` branch so `main` stays free of bot commits.

- **Zero setup boilerplate:** Runs natively on GitHub's `node24` runtime with no `setup-node` step, reads handles from `.github/FUNDING.yml` or the repository owner, and ingests `repository_dispatch` `client_payload.kofi` events from `$GITHUB_EVENT_PATH`.
- **Tiered layout & presets:** Recurring sponsors at `$25+/mo` appear in the **Featured sponsors** tier (64px avatars), or you can define custom tiers using `xs`, `sm`, `base`, `md`, `lg`, and `xl` presets.
- **Cross-platform deduplication:** Supporters who sponsor on multiple platforms merge by profile identity, summing active recurring monthly amounts before fetching avatars in parallel.
- **Profile & avatar linking:** Ko-fi supporters can tag `@username`, `gh:username`, `github.com/username`, `roblox:username`, or `roblox.com/users/<id>` in their name or message to link their profile and avatar automatically, with SHA-256 Gravatar and code-point initials fallbacks.
- **Shared orphan branch safety:** Rolling Ko-fi state (`sponsors.json`, 35-day active window) and SVGs commit to `badges` via Git plumbing without touching `HEAD`, preserving sibling files like `coverage.json` and skipping pushes when nothing changed.

## Quick Start

### 1. Add `.github/FUNDING.yml` and Embed in `README.md`

Set your handles in `.github/FUNDING.yml`:

```yaml
github: your-github-username
ko_fi: your-kofi-username
```

Embed the SVGs from your `badges` branch in `README.md`:

```html
<p align="center">
  <a href="https://github.com/sponsors/your-github-username"><img src="https://raw.githubusercontent.com/your-github-username/your-github-username/badges/sponsor-github.svg" alt="GitHub Sponsors" /></a>&nbsp;&nbsp;<a href="https://ko-fi.com/your-kofi-username"><img src="https://raw.githubusercontent.com/your-github-username/your-github-username/badges/sponsor-kofi.svg" alt="Ko-fi" /></a>
  <a href="https://github.com/sponsors/your-github-username"><img src="https://raw.githubusercontent.com/your-github-username/your-github-username/badges/sponsors.svg" alt="Sponsors" /></a>
</p>
```

### 2. Add `.github/workflows/sponsors.yml`

```yaml
name: Sponsors

on:
  schedule:
    - cron: "0 */6 * * *"
  workflow_dispatch:
    inputs:
      dry_run:
        description: Render SVGs and preview state without pushing to badges
        type: boolean
        default: false
  repository_dispatch:
    types: [sponsors-updated, kofi-webhook]
  push:
    branches: [main]
    paths:
      - ".github/FUNDING.yml"
      - ".github/workflows/sponsors.yml"

permissions:
  contents: write

concurrency:
  group: sponsors
  cancel-in-progress: false

jobs:
  sponsors:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: kohltastrophe/sponsors@v1
        with:
          token: ${{ secrets.SPONSORS_TOKEN }}
```

When `SPONSORS_TOKEN` is unset, the action falls back to `github.token` (`push-token`) to render your public GitHub Sponsors list and push to `badges`. To read exact GitHub Sponsors tier dollar amounts (which GitHub redacts on `GITHUB_TOKEN`), add a read-only classic Personal Access Token with only the `read:user` scope (plus `read:org` for organization sponsors) as `SPONSORS_TOKEN`; `github.token` continues to handle `badges` branch pushes.

## Action Reference

### Inputs

| Input | Default | Description |
| :--- | :--- | :--- |
| `token` | `${{ github.token }}` | GitHub token for reading GitHub Sponsors tiers (`read:user` / `read:org`). Falls back to `push-token` when empty. |
| `push-token` | `${{ github.token }}` | GitHub token for pushing the orphan `branch` to `origin`. |
| `login` | `""` | GitHub user or organization login override (defaults to `.github/FUNDING.yml` or repo owner). |
| `kofi` | `""` | Ko-fi handle or URL override (defaults to `.github/FUNDING.yml`). |
| `opencollective` | `""` | OpenCollective slug override (defaults to `.github/FUNDING.yml`). |
| `config` | `.github/sponsors.json` | Optional JSON file with tier presets, overrides, exclusions, and manual sponsors. |
| `output` | `""` | Output SVG path for the sponsors wall (defaults to `$RUNNER_TEMP/sponsors/sponsors.svg`). |
| `branch` | `badges` | Orphan Git branch to publish generated SVGs and rolling state onto (`""` skips branch publish). |
| `push` | `"true"` | Force-push the updated orphan branch to `origin` when its tree changes. |
| `dry-run` | `""` | Render SVGs and preview state without updating branches or pushing. Auto-reads `workflow_dispatch` `inputs.dry_run` when omitted. |
| `featured-threshold` | `"25"` | Monthly dollar threshold for the Featured sponsors tier. |
| `active-window-days` | `"35"` | Rolling active window in days for Ko-fi records. |
| `exclude` | `""` | Comma-separated logins to exclude from the sponsors wall. |
| `include-past` | `"false"` | Include past/inactive GitHub sponsors. |
| `kofi-payload` | `""` | JSON string of a Ko-fi webhook payload to ingest (auto-reads `client_payload.kofi` from `$GITHUB_EVENT_PATH`). |
| `working-directory` | `.` | Repository root directory. |

### Outputs

| Output | Description |
| :--- | :--- |
| `sponsors_count` | Total number of public sponsors rendered. |
| `has_recurring` | `"true"` when active recurring or GitHub sponsors exist. |
| `dry_run` | `"true"` when running in dry-run mode. |
| `svg_path` | Path to the generated `sponsors.svg` file. |
| `cards` | Comma-separated paths to the generated `sponsor-<platform>.svg` CTA cards. |

## Webhook Relay Worker (Optional)

Deploy `worker.mjs` to Cloudflare Workers to refresh your badges when someone sponsors you on Ko-fi or GitHub Sponsors:

```bash
npx wrangler deploy
npx wrangler secret put SPONSORS_TOKEN
npx wrangler secret put KOFI_VERIFICATION_TOKEN
npx wrangler secret put GITHUB_WEBHOOK_SECRET
```

- `SPONSORS_TOKEN`: Fine-grained GitHub PAT with **Contents: Read and write** permission on your target repository (triggers `repository_dispatch`).
- `KOFI_VERIFICATION_TOKEN`: Verification token from [ko-fi.com/manage/webhooks](https://ko-fi.com/manage/webhooks).
- `GITHUB_WEBHOOK_SECRET`: Webhook secret configured at `https://github.com/sponsors/<your-username>/dashboard/webhooks` (Content type: `application/json`).

The Worker resolves the target repository from the URL path (`POST https://<worker>.workers.dev/<owner>/<repo>`), the `GITHUB_REPO` variable, the GitHub Sponsors `sponsorable.login` field, or the authenticated token owner (`<login>/<login>`).

## Optional Configuration (`.github/sponsors.json`)

Create `.github/sponsors.json` only when you want custom tier presets, per-sponsor overrides, exclusions, or manual entries:

```json
{
  "featured_threshold": 25,
  "active_window_days": 35,
  "exclude": ["some-bot"],
  "overrides": {
    "octocat": {
      "name": "The Octocat",
      "url": "https://github.blog"
    }
  },
  "tiers": [
    { "title": "Gold sponsors", "monthlyDollars": 100, "preset": "xl" },
    { "title": "Featured sponsors", "monthlyDollars": 25, "preset": "lg" },
    { "title": "Sponsors", "monthlyDollars": 0, "preset": "base" },
    { "title": "Past sponsors", "monthlyDollars": -1, "preset": "xs" }
  ],
  "sponsors": []
}
```

## CLI Usage

```bash
sponsors --demo --output /tmp/sponsors.svg          # Render offline demo wall and CTA cards
sponsors --branch badges --push                     # Fetch live sponsors and publish to badges
sponsors --branch badges --dry-run                  # Preview output without updating refs or pushing
npm test                                            # Run unit, git branch, CLI, and worker test suites
```

## Sponsors

`sponsors` is free and MIT-licensed. If `sponsors` is useful to you or your team, you can support its development through [GitHub Sponsors](https://github.com/sponsors/kohltastrophe) or [Ko-fi](https://ko-fi.com/kohltastrophe).

<p align="center">
  <a href="https://github.com/sponsors/kohltastrophe"><img src="https://raw.githubusercontent.com/kohltastrophe/kohltastrophe/badges/sponsor-github.svg" alt="GitHub Sponsors" /></a>&nbsp;&nbsp;<a href="https://ko-fi.com/kohltastrophe"><img src="https://raw.githubusercontent.com/kohltastrophe/kohltastrophe/badges/sponsor-kofi.svg" alt="Ko-fi" /></a>
  <a href="https://github.com/sponsors/kohltastrophe"><img src="https://raw.githubusercontent.com/kohltastrophe/kohltastrophe/badges/sponsors.svg" alt="Sponsors" /></a>
</p>
