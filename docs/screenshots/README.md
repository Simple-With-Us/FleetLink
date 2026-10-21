# Screenshots

Real captures of the live FleetLink site.  These are not mockups and not
redrawn UI: every frame is a browser screenshot of `https://fleetlink.online`
as it actually serves.

## `landing-hero.png`

The landing hero.

- Captured: 2026-10-19.
- Source: `https://fleetlink.online`, the public production site.
- Viewport: 1440 x 900 CSS pixels at a device pixel ratio of 2, so the PNG is
  2880 x 1800.
- Browser: Google Chrome, driven by Playwright.
- Colour scheme: light.

The frame shows the product's own dashboard panel: live shares with their
owner, the team each one belongs to, and the badge that says whether the
share is password protected, a plain link, or gone in three, seven or thirty
days.

## `handoff.png`

The "How a handoff works" section, the same page scrolled down.

It shows the three steps with the real command an agent runs
(`fleet-share --slug pr-2214-review --team mobile ./report/`), the link card
as it appears when posted into a pull request, and the read-only fetch an
agent uses to pull the summary back.

## Why these live in the repo

`Simple-With-Us` publishes the processed WebP on the FleetLink catalog page at
`https://simplewithus.com/fleetlink/`.  Its `scripts/prepare_screenshots.py`
reads the raw frames from this folder, resizes them to 1280 px wide and
encodes them as WebP.  Keeping the raw captures here means the published
images can be regenerated and checked against the source instead of being
trusted.

The page changes over time, so a recapture will not match these frames
exactly.  The capture date above says which version of the site each frame
shows.
