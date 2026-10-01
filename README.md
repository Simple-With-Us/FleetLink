# FleetLink

Temporary, high-performance artifact and build hosting for AI fleet agents and human operators.  Deployed on Cloudflare Workers and backed by Cloudflare R2 storage, FleetLink provides instantaneous web and native iOS App Clip previews for shared files, batch directories, and hosted static sites.

- **Primary Domain:** `https://fleetlink.online` (**FleetLink.online**, default for all sharing)
- **Secondary Domain:** `https://fleetlink.app` (**FleetLink.app**, fallback mirror and legacy routing)
- **CLI Helper:** `/Users/jay/apps/fleet-share`
- **R2 Monitor:** `/Users/jay/apps/r2-usage-monitor.py`
- **License:** Apache License 2.0

## Features

- **Instantaneous In-Browser Previews:** Direct rendering for Markdown (`.md`) with responsive GitHub Flavored Markdown styling, images (PNG, JPG, SVG, WebP, GIF), interactive HTML widgets and dashboards, and monospace source code/logs.
- **Social Sharing Previews (iMessage / Open Graph):** Designate a preview media image (max 5MB) and custom title so links render rich cards when shared in iMessage, Slack, Twitter, WhatsApp, and Discord.
- **Web Directory Browsing:** Multi-file shares automatically generate a clean, browsable directory index linking to each file with file type icons.
- **Zero-Config Static Website Hosting:** Any directory containing an `index.html` is automatically served as a live interactive website with relative asset resolution (CSS, JS, images).
- **In-Browser Upload Wizard:** Authenticated users on **FleetLink.online** can upload files directly through a sleek web form with drag-and-drop, custom TTL, title, preview image, and password protection.
- **Admin Password Auto-Bypass:** Visiting password-protected shares with an active Admin browser session cookie automatically bypasses password prompts!
- **In-Place Updates:** Re-uploading to an existing slug and path updates the file in place immediately and allows updating the expiration TTL.
- **Password Protection:** Optional password authentication protects sensitive artifacts or static sites behind an unlock screen.
- **Native iOS App Clip:** Native SwiftUI App Clip (`online.fleetlink.Clip`) opens automatically on iOS devices via Safari Smart App Banners, Universal Links, Messages, NFC, or QR codes without requiring full app installation.
- **Automatic Expiration:** Links expire automatically based on requested TTL, keeping storage tidy and preventing orphan artifacts.
- **Descriptive Rejection Feedback:** Failed or out-of-bounds requests return descriptive HTTP error messages detailing the exact cause (limits, TTL, auth, or storage errors).

## Domains & Usage Instructions

Whichever domain you send your request to directly is the domain used in your share link — no separate server URL configuration or domain flags needed:

| Domain | Role | Instructions / When to Use |
|---|---|---|
| **FleetLink.online** | **Default & Primary** | **Use for all standard artifact uploads, test reports, and shared links.** It is the default endpoint in `fleet-share` and all agent workflows. |
| **FleetLink.app** | **Secondary Mirror** | Available as a secondary domain mirror and fallback for application redirects or legacy integrations. Specify via `--domain https://fleetlink.app`. |

## Direct `curl` Usage

Target whichever domain you want for the link:

```bash
# 1. Default domain upload (Agent or Admin token)
curl -X PUT "https://fleetlink.online/<batch-or-slug>/<filename>" \
     -T ./artifact.md \
     -H "X-Fleet-Admin: $FLEET_ADMIN_SECRET" \
     -H "Content-Type: text/markdown; charset=utf-8" \
     -H "X-Expire-Days: 3"

# 2. Secondary domain upload
curl -X PUT "https://fleetlink.app/<batch-or-slug>/<filename>" \
     -T ./artifact.md \
     -H "X-Fleet-Admin: $FLEET_ADMIN_SECRET" \
     -H "Content-Type: text/markdown; charset=utf-8" \
     -H "X-Expire-Days: 3"

# 3. Upload with social sharing preview image & custom title
curl -X PUT "https://fleetlink.online/<slug>/<filename>" \
     -T ./report.html \
     -H "X-Fleet-Admin: $FLEET_ADMIN_SECRET" \
     -H "X-Fleet-Title: Release Report" \
     -H "X-Fleet-Preview: cover.png"

# 4. Password-protected upload
curl -X PUT "https://fleetlink.online/<slug>/<filename>" \
     -T ./secret.pdf \
     -H "X-Fleet-Admin: $FLEET_ADMIN_SECRET" \
     -H "X-Fleet-Password: MySecretPassword"

# 5. Permanent hosting (Admin token only)
curl -X PUT "https://fleetlink.online/<slug>/<filename>" \
     -T ./report.html \
     -H "X-Fleet-Auth: $FLEET_ADMIN_SECRET" \
     -H "Content-Type: text/html; charset=utf-8" \
     -H "X-Expire-Days: forever"
```

## CLI Usage (`fleet-share`)

The fleet CLI helper `/Users/jay/apps/fleet-share` simplifies sharing from any machine or agent session:

```bash
# Share a single file (defaults to https://fleetlink.online, 3-day TTL)
fleet-share test-report.md

# Share to secondary fleetlink.app domain
fleet-share --domain https://fleetlink.app test-report.md

# Share an entire directory tree (served as a browsable web directory)
fleet-share ./dist

# Share with designated social media preview image (for iMessage/Slack cards)
fleet-share --preview cover.png ./dist

# Share multiple files into a named batch
fleet-share --slug my-batch doc.md screenshot.png style.css

# Password-protect a share
fleet-share --password "SecretPass123" ./dist

# Update an existing share (overwrites in place)
fleet-share --slug my-batch updated-doc.md

# Share with a custom duration (Admin token)
fleet-share --slug release-v1 --days 14 ./build.zip

# Permanently host an artifact (Admin token only)
fleet-share --forever release-notes.html
```

## Multi-File Batches, Web Directories & Static Websites

- **Web Directory Index:** When multiple files or directories are uploaded under a slug (e.g. `https://fleetlink.online/build-123/`), navigating to the root path automatically displays a clean, responsive Web Directory Index linking to each file.
- **Static Website Hosting:** If an uploaded directory contains an `index.html` at its root or inside a subfolder, FleetLink automatically renders the live interactive HTML page instead of the directory index. Relative asset paths (CSS stylesheets, JavaScript bundles, images) resolve naturally.
- **Updating Existing Shares:** Re-uploading to the same slug and path updates the target file immediately in place and refreshes its TTL.

## Authentication: Two Token Tiers

Every upload requires authentication passed via the `X-Fleet-Auth` header:

1. **Admin Token (`AUTH_SECRET` / `ADMIN_TOKEN`):**
   - Full administrative access for operators.
   - Allows permanent hosting (`X-Expire-Days: forever`) or custom TTL up to 30 days.
   - Allows reserving custom slugs, directory paths, and password protection.

2. **Agent Token (`AGENT_SECRET`):**
   - Scoped token dedicated to autonomous AI fleet seats (Antigravity, Claude, Codex, Grok, MiniMax).
   - Hard TTL cap enforced: maximum 7 days (defaults to 3 days).  Requests for permanent hosting or excessive TTL are automatically rejected with a clear explanation.
   - Designed for fast drops of test summaries, build artifacts, simulator screenshots, and inter-agent coordination handoffs.

## Upload Limits & Explicit Rejection

- **Admin Limits:**
  - **Per-file limit:** 300 MB maximum.
  - **Total batch limit:** 1 GB (1,024 MB) maximum.
  - **File count limit:** 1,000 files per upload.
  - **Retention:** Permanent (`forever`) hosting for uploads &le; 500 MB.
  - **Hard 500MB Rule:** Any upload or batch exceeding 500 MB total is strictly capped at a 7-day maximum TTL for all users.
- **Agent Limits:**
  - **Per-file limit:** 100 MB maximum.
  - **Total batch limit:** 500 MB maximum.
  - **File count limit:** 50 files per share.
  - **Retention:** Hard 7-day maximum TTL (defaults to 3 days).
- **Rejection transparency:** Any request exceeding limits or providing invalid parameters is immediately rejected with a clear explanation:
  - Exceeding file limit returns HTTP 413: `Upload rejected: File "<name>" (<size>MB) exceeds the maximum limit per file.`
  - Exceeding batch size returns HTTP 413: `Upload rejected: Total batch size (<size>MB) exceeds the maximum limit.`
  - Exceeding 500MB TTL returns HTTP 403: `Upload rejected: Batches exceeding 500MB total are restricted to a hard maximum retention of 7 days.`
  - Exceeding Agent TTL returns HTTP 403: `Upload rejected: Agent tokens are restricted to a maximum TTL of 7 days ('forever' is reserved for Admin tokens).`
  - Missing or invalid authentication returns HTTP 401: `Upload rejected: Unauthorized. Provide a valid X-Fleet-Admin header with an Admin or Agent secret.`
- **Terms & Fine Print:** Storage quotas, allowances, and timeframes are best effort and non-binding.  FleetLink reserves the right to prune or delete shares/files at any time without notice for excessive utilization or administrative hygiene.
- **Quota Increases:** Contact `support@fleetlink.online` for custom quotas or enterprise tier hosting.

## Back-End Admin Portal (`/portal` & `/admin`)

FleetLink includes an interactive administrative portal at `https://fleetlink.online/portal` (or `/admin`):

- **Live Bucket Overview:** Scans all R2 storage objects to display total storage volume, file count, and slug inventory.
- **Slug Management:** Lists each active share with its byte size, total files, expiration countdown, permanent retention indicator, and password lock state.
- **Interactive Filtering:** Instant search by slug name, plus quick filters: `All`, `Permanent`, `Expiring Soon`, `Expired`, `Large (> 50MB)`.
- **1-Click Slug Pruning:** Delete unwanted batches or excessive storage hogs with a single click and immediate UI update.
- **API Access:**
  - `GET /api/portal/data`: Returns JSON overview of bucket metrics and all active slugs.
  - `POST /api/portal/delete`: Accepts `{ slug: string }` with Admin authorization to purge all files under that slug.

## Model Context Protocol (MCP) Server

FleetLink provides a native Model Context Protocol (MCP) server for Claude Code, Cursor, Codex, Gemini/Antigravity, and other AI coding agents:

- **Location:** `/Users/jay/apps/fleetlink-mcp/`
- **Launcher:** `/Users/jay/apps/mcp-servers/fleetlink-launch.sh` (sources credentials from `~/.secrets/fleetlink-auth.env`)

### Available Tools

1. `fleetlink_share_file`: Uploads and shares a single file, markdown artifact, or image.  Supports custom slugs, titles, preview cards, passwords, and custom TTL.
2. `fleetlink_share_directory`: Recursively bundles and shares an entire folder or static website (with `index.html`).
3. `fleetlink_list_shares`: Queries the portal API for active slugs, storage utilization, and expiration timelines.
4. `fleetlink_delete_share`: Permanently purges a slug and all underlying files to immediately reclaim storage.

### Client Setup

- **Claude Code:**
  ```bash
  claude mcp add fleetlink -- /Users/jay/apps/mcp-servers/fleetlink-launch.sh
  ```
- **Cursor (`~/.cursor/mcp.json`):**
  ```json
  {
    "mcpServers": {
      "fleetlink": {
        "command": "/Users/jay/apps/mcp-servers/fleetlink-launch.sh"
      }
    }
  }
  ```
- **Claude Desktop (`claude_desktop_config.json`):**
  ```json
  {
    "mcpServers": {
      "fleetlink": {
        "command": "/Users/jay/apps/mcp-servers/fleetlink-launch.sh"
      }
    }
  }
  ```

## iOS App Clip & Main App

Located in `ios/`, the iOS project contains both the standalone App Clip and parent application:

- **App Clip Target:** `FleetLinkClip` (`online.fleetlink.Clip`)
- **Main App Target:** `FleetLink` (`online.fleetlink`)
- **Architecture Note:** Apple requires App Clips to be embedded inside a parent host app (`online.fleetlink`).  Both targets are defined in XcodeGen and built in `ios/build/FleetLink.xcarchive`.
- **Associated Domains:**
  - `appclips:fleetlink.online`
  - `appclips:fleetlink.app`
  - `applinks:fleetlink.online`
  - `applinks:fleetlink.app`
- **Project Generation:** Managed with XcodeGen (`cd ios && xcodegen generate`).  Do not hand-edit `.pbxproj`.

## CI/CD & GitHub Actions

GitHub Actions workflows in `.github/workflows/ci.yml` run automated tests and builds on every push and pull request:
- **Worker Tests:** Validates routing, security boundaries, and TTL enforcement on Ubuntu runners.
- **iOS App & App Clip Builds:** Offloaded to GitHub Actions macOS runners (`macos-14`) using XcodeGen and `xcodebuild`.  When code signing certificates and profiles are provided in GitHub repository secrets (`BUILD_CERTIFICATE_BASE64`, `P12_PASSWORD`), the macOS runner automatically sets up a temporary keychain to sign release builds.
