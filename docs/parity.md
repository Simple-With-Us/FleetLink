# FleetLink web and iOS parity

Inventory of user-facing behavior on the worker-served site (home, dashboard, instructions, privacy, and public share pages) and in the iOS app (`ios/App`, `ios/Shared`, `ios/Clip`).  Sign-in flows are listed so the gap is visible.  They were not changed here.  Another change owns passkeys and account sign-in.

Status words in the action column:

- **Both** — already worked on the web and in the app before this change.
- **Shipped** — added or wired in this change.
- **Remains** — not done, with the reason.

| Feature | Web | iOS | Action |
| --- | --- | --- | --- |
| Home page to upload files, pick a lifetime, set a password, title, and preview image | Wizard on `/` posts multipart to `/api/upload` | New Share tab uploads the same way, including photos and files | Shipped on iOS.  The website already had it. |
| Write a note and share it as a file | Third wizard tab, "Write a Note", uploads `notes.md` (or another name) through `/api/upload` | Note mode in New Share | Shipped on the web.  iOS already had a text composer and now posts it to `/api/upload`. |
| Short link to another site | Wizard redirect mode posts JSON to `/api/redirect` | Redirect mode posts the same JSON | Shipped on iOS.  The website already had it. |
| Optional description stored with the share | Saved as `og_description` for files and redirects | Title and description fields on New Share | Shipped on both.  Redirects already stored a description.  File uploads now do too. |
| Custom link name | File names are admin-only.  Redirect names work for a signed-in publisher. | Same rules.  The form explains them.  The server still returns 403 when a file name is not allowed. | Both.  iOS now calls the real fields (`slug`, `days`) instead of a private shape. |
| No expiry | Allowed only for an admin token.  Others are clamped. | "No Expiry" sends `days=forever`.  The server still rejects it for other tokens. | Both. |
| Signed-out publishing | `POST /api/upload` and `POST /api/redirect` return 401 before any guest clamp | The app asks for a token in Settings and does not offer a signed-out publish path | Remains.  Guest clamps (10 files, 5 MB each, 10 MB per batch, 1 hour files, 6 hour redirects) stay in the worker.  Signed-out create stays closed. |
| Quota cards on the home page | Cards still describe a guest tier (including 20 MB and 40 files) that does not match the clamps or the 401 | Not shown.  Settings links to the website. | Remains.  Rewriting the cards would change published limits without a product decision. |
| Copy the new link and open the dashboard | Result panel after upload or redirect | Copy Link and View after a successful create | Both. |
| Preview a FleetLink link on the page | Home card pastes a link.  Images zoom.  Notes and other same-site files preview.  `.html` and `.htm` offer download only.  A link that redirects off the site is not framed.  `/?view=` opens the same card. | Viewer tab, plus the shared viewer used by the App Clip | Shipped on the web.  iOS already previewed links and now matches the HTML download rule and the off-site redirect card. |
| Share sheet | Website uses the browser share button when the browser offers one | System share sheet | Shipped on the web.  iOS already had it. |
| Password lock | Password page, `X-Fleet-Password`, or `?password=` | Unlock field sends `X-Fleet-Password` only.  Passwords are not put in the URL. | Shipped on iOS.  The website already had the page. |
| Notes rendered as a page | Markdown is wrapped in HTML unless `?raw=1` | Raw text feeds the in-app note view.  A wrapped page falls back to the web view. | Shipped.  `?raw=1` does not skip the password check or the HTML download rule. |
| Pictures, including SVG | Browser shows the image.  The home preview zooms common image types. | Image view, with SVG in the web view | Both.  SVG in the app web view is new. |
| PDF | Browser or the home preview frame shows it when it stays on FleetLink | PDF view | Shipped on iOS.  The website already opens PDFs in the browser. |
| Code and plain text | Home preview shows same-site text files in a block | Code view | Shipped on the web.  iOS already had it. |
| Folder listing | "Index of /" list, with a size beside each name | Same list, parsed from that page, including the size | Shipped.  Sizes were added on the web and read by the app. |
| HTML and HTM files | Always downloaded (`application/octet-stream` and `Content-Disposition: attachment`) | Download card and Safari.  Not opened inside the app. | Both.  The app used to render these pages.  It no longer does. |
| Open in the browser | Every public link | Safari button on download and redirect cards | Both. |
| Expired and missing links | 404 text "Link Expired" or "Object Not Found" | Expired and not-found screens | Both. |
| App Clip card on shared pages | `apple-itunes-app` meta tag | App Clip target opens the shared viewer and shows Get App | Both.  The clip cannot create or manage shares.  That stays in the full app. |
| Universal links and associated domains | `/.well-known/apple-app-site-association` | Continues the browsing activity into the viewer | Both.  The association file was not edited. |
| Your shares list | `/portal` for a signed-in non-admin uses shares saved in this browser | Portal tab merges shares created on this device with the full list when the token can read it | Shipped.  There is still no server list for a normal account.  The device list mirrors the browser list. |
| Full bucket list | Admin dashboard via `GET /api/portal/data` | Same request when the token is allowed.  Otherwise the device list remains. | Shipped on iOS.  The website already had it. |
| Search | User dashboard and admin dashboard | Portal search | Both. |
| Filters | All, redirects, files, due soon, and locked | All, redirects, files, expiring soon, and locked | Shipped.  Due soon and locked were added on the user dashboard.  Locked was added in the app.  Admin gained Due In 24h and Files. |
| Sort | Admin column sort | Newest, expiring first, name, largest | Shipped on iOS.  Admin column sort already existed. |
| Storage and counts | User dashboard shows count, redirects, files, and total size.  Admin shows the bucket overview. | Portal cards for shares, storage, redirects, and files | Shipped on the user dashboard.  iOS already had the cards and now fills them from the real list. |
| Time left | User dashboard shows time remaining | Each row shows time remaining or No Expiry | Shipped on the web.  iOS already showed it and now treats a permanent share as No Expiry. |
| Open, copy, view | Both dashboards | Copy and View on each row | Both.  View on the web opens `/?view=`. |
| Renew | `POST /api/portal/renew` (also `/api/shares/renew`).  Three renewals max.  Permanent shares stay put. | Same request | Shipped.  Admin rows gained Renew.  The app already had the button and now calls the real path. |
| Delete one share | `POST /api/portal/delete` | Same request | Shipped on iOS.  The website already had it.  A raw `DELETE` of one object stays admin-only. |
| Delete many shares | Admin multi-select | One share at a time | Remains.  The app stays on single delete to keep the screen small.  The endpoint already accepts a list. |
| System files (preview image, association file, shortcut) | Separate admin section with a two-step delete | Hidden from the list | Remains.  Those files are not user shares.  Showing them in the app would make an accidental delete easier. |
| Instructions | `/instructions/` from stored pages, plus the home page command examples and the share-sheet shortcut download | Settings links to instructions, privacy, and the shortcut | Shipped as links.  A second copy of the command docs inside the app would drift. |
| Privacy page | `/privacy` | Settings link | Shipped as a link. |
| Account sign-in (Apple, GitHub, Google, passkey, `/login`, `/api/auth`, `/api/me`) | Login pages and session cookie | Account screen and session cookie | Remains.  Another change owns this.  This work does not edit those screens or handlers. |
| Sign out | `/logout` and `POST /api/auth/logout` | Existing account sign-out | Both.  Untouched. |
| Old token exchange | `GET /api/auth/token` returns 410 | Not used | Both.  Left as 410. |
| Automation token | Bearer or `X-Fleet-Admin` / `X-Fleet-Agent` on the API.  The website form can also send `secret`. | Settings field, sent as `Authorization: Bearer` and as `secret` on create | Both.  The settings wording was already there and was not rewritten. |
| Host switch | `fleetlink.online` and `fleetlink.app` are both served | Settings and New Share pick the host.  Portal and create follow that choice. | Both. |
| Shortcut file | `GET /api/shortcut/download` | Settings link | Shipped as a link. |
| Command-line upload examples | Home page | Not duplicated | Remains.  The instructions link covers them. |
| Social preview card | Crawlers receive a preview card instead of the redirect | The app shows the redirect card to a person, not the crawler card | Both.  Different audiences. |
| Error when a list, renew, or delete fails | Admin and user pages alert | Orange banner on the portal list, and an error on New Share | Shipped on iOS. |
| Crash reporting | Not a page | Existing telemetry in the app and the clip | Remains.  Not a shared product feature. |

## What this change implemented

The app now publishes and manages shares with the live routes: `POST /api/redirect`, `POST /api/upload` (field name `files`, optional preview image), `POST /api/portal/delete`, `POST /api/portal/renew`, and `GET /api/portal/data` when the token is allowed.  Shares created on the device are remembered locally so a normal account still has a list.  The viewer unlocks passwords, refuses to follow a short link into another site, downloads HTML instead of rendering it, opens PDFs, and reads folder sizes.

The website gained a note composer, a preview card (including `/?view=`), descriptions on file uploads, folder sizes, a raw note flag, user-dashboard time remaining, size, due soon, locked, and View, plus admin Renew, View, Due In 24h, and Files.

## What remains, and why

Signed-out publishing stays off.  The clamps remain for any later path that still checks them.  Quota cards were left alone because they disagree with both the clamps and the 401, and changing them is a limit change rather than a parity fix.  Admin multi-delete and system files stay on the website.  Sign-in, passkeys, and `/api/me` stay with the other change.  The association file and App Clip bundle identifiers were not edited.  Nothing here was deployed.
