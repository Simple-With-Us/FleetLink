# FleetLink design review

Reviewed on 14 October 2026.  Surfaces: the public website (home), the signed-in link list and the account-owner list, the instructions and privacy pages, and the iOS app plus App Clip in `ios/`.

Five reviews follow, then one agreed list.  Status is `done` when the change is in this branch, and `deferred` when it was agreed but left for a later change.  Sign-in itself is not redesigned here.  Another change is replacing the current sign-in with passkeys.  Labels and error sentences on the existing forms were updated.  The form fields, the requests they send, and the session cookie were not.

Security behavior is unchanged.  A request for the old token URL still returns 410.  An HTML upload is still sent as a download.  The limits for a share without an account are still the limits in the worker.  This review does not turn guest sharing back on, and it does not publish a secrets file.

## Visual designer

The home page used to open as a wall of feature claims, a terminal sample, and a form that assumed the reader already knew the product.  The first screen now has one job: share a file, or make a short link.  The form sits in a green panel, the iPhone shortcut sits in a purple panel, and four short feature cards sit under that.  A final card states how long a link stays up.  That order matches the task.

Problems that were still visible:

- The same chrome (type, blue, 44 pixel targets, focus ring) was copied into each page instead of one stylesheet.  The pages now agree, but a future edit can drift.
- Purple shortcut buttons were light enough that white text failed a contrast check.  They are now a darker purple.
- Folder pages and the password page used a looser layout than the home page, and the missing-link page was a plain sentence with no page structure.
- Empty lists said nothing, or said it in gray that disappeared on white.
- The account-owner table used emoji as the button label.  The words Open, Copy, and Delete are enough, and they line up.
- Fixed-size icons in the iOS viewer did not sit on the same type scale as the surrounding text.

A full rebrand, a shared layout file, and a card layout for the account-owner table on a narrow phone are out of scope for this pass.

## Information architecture and onboarding

A new person could not tell what to do first, or which numbers to trust.

- The old home page offered an upload before it said that sharing requires a sign-in.  The form now says sign-in is required, and the submit action checks for a session or a typed sign-in code.
- Older marketing numbers (larger files, longer times, a live HTML site) did not match the worker.  The home page, the instructions, the link list, and the privacy page now use the same numbers: signed-in files up to 7 days, signed-in short links up to 6 months, and the smaller cap if a share is ever accepted without an account.
- "Your links" is the list saved in this browser.  The account-owner list is a separate sign-in and is labeled that way.  The empty list tells you to share something, and a search with no hits tells you nothing matches.
- Instructions are a page the worker serves, with a short contents list: website, iPhone, duration, computer, and what people see.  The helper download stays available.  The secrets file is not offered as a download.
- The iOS tabs were named for the implementation (portal, make slug, artifact viewer).  They are now Links, New link, View, and Settings.  Settings no longer explains storage internals.  It names the two websites the app opens, and it keeps a separate field for a sign-in code used by a shortcut or a script.

What is still awkward: there is no public signup.  The site can only tell someone to use a sign-in code they already have.  Building accounts is a product change, not a copy change.

## Accessibility (WCAG 2.2 AA)

Checked against WCAG 2.2 AA as a review, not a formal audit.

What was failing:

- No skip link, and several controls were below 44 by 44 pixels.
- Focus was easy to lose.  The file picker was `display: none`, so a keyboard could not reach it.
- The password page had an unlabeled field.  Sortable columns on the account-owner table were mouse-only.  Dialogs were not marked as dialogs.
- Gray text on white (`#94a3b8` and similar) was below the contrast floor.  Body text and empty states now use darker gray or near-black.
- Icon-only actions in the iOS list had no names.  Filter chips did not expose the selected state.
- Markdown pages had a contents list whose links went nowhere, because headings had no ids.
- Folder pages and status pages were missing a language and a main region.

What this branch does: skip links, a visible focus ring, 44 pixel targets on the main controls, a clipped-but-focusable file input, labels on the password field and the sign-in fields, keyboard sorting with `aria-sort` while the cell stays a column header, dialog roles on the sign-in and delete panels, and heading ids on rendered Markdown (marked 15.0.12, GitHub-style slugs, duplicates suffixed `-1`, `-2`).  Folder links use a `file-link` class so the iOS app can still find them, including the older emoji listing.

Still deferred: a recorded audit with a screen reader on every page, and a rebuild of the wide account-owner table for a 320 pixel screen.  The table scrolls.  It is not yet a stacked list.

## Apple HIG and iOS

The app read like an internal tool dropped into a tab bar.

- Tab names and the New link screen now use the words a person uses: short link, file, how long it stays up, password optional.
- Empty, loading, missing, and expired states are full sentences.  Decorative icons are hidden from VoiceOver when the text already says the same thing.  Pictures have a name and a zoom hint.
- Time remaining is words ("3 days", "Until you delete it"), not a compact code.  An expiring row uses orange, which holds up on a light background better than yellow.
- Type uses text styles (body, caption, large title) so Dynamic Type can scale it.  The two leftover fixed point sizes in the viewer were illustration icons.  They now use the large title style.
- The App Clip still opens the same viewer.  Its footer says you can share a file from the iPhone, and the toolbar buttons have names.
- Sign in with Apple, GitHub, and Google are unchanged as flows.  The sentences they show on failure are now ordinary sentences.  The automation sign-in code stays in Settings and is labeled as separate from those buttons.

Deferred: a pass in Simulator at the largest Dynamic Type size, because this environment has no Swift toolchain.  Also deferred: any new sign-in method.

## Technical writer

The product was speaking two languages.  The page said "share a file."  The error, the shortcut, and the privacy page said slug, TTL, token, artifact, and storage-vendor names.

Rules used for the rewrite:

- Say link name, short link, sign-in code, account owner, and how long it stays up.
- Do not name the storage vendor, the crash reporter, or an internal role in a sentence a person reads.
- A sample request may keep the real header name, with a plain sentence before it.  The instructions do that for a computer upload.
- API responses are unchanged.  The website and the app rewrite a few known words at the moment they are shown.
- Privacy no longer claims that sharing needs no account, and it no longer claims there is no diagnostic data.  A release build may send a crash report with name, email, and file contents removed.  HTML is described as a download, not as a live site.
- The iPhone shortcut asks for a sign-in code and a link name.  It does not ask for a secret token or a custom slug.

Deferred: a second pass by someone who has not seen the worker, and a glossary.  The instructions page is the glossary for now.

## Agreed changes

| Priority | Change | Status |
| --- | --- | --- |
| P1 | Home page leads with share, then the iPhone shortcut, then what a link can do.  One primary action. | Done |
| P1 | Say that sharing on the website requires a sign-in.  Do not offer a guest upload.  State the real cap if a share is ever accepted without an account. | Done |
| P1 | Use the same duration and size numbers on the home page, instructions, link list, and privacy page.  Do not advertise a live HTML site. | Done |
| P1 | Replace slug, token, artifact, TTL, and storage-vendor wording in product copy, shortcut prompts, and on-screen errors.  Leave API error strings and header names alone. | Done |
| P1 | Serve instructions from the worker, with a contents list.  Do not offer the secrets file as a download. | Done |
| P1 | Empty lists, a search with no hits, a missing link, and an expired link each get a plain sentence and a next step. | Done |
| P1 | iOS tabs: Links, New link, View, Settings.  New link says short link or text file.  Settings drops the architecture notes and keeps the automation sign-in code. | Done |
| P2 | Skip link, focus ring, 44 pixel targets, and darker text on the website pages.  File input can take keyboard focus. | Done |
| P2 | Label the password page, the sign-in fields, and the account-owner search.  Mark dialogs.  Let sortable columns work from the keyboard and expose sort direction. | Done |
| P2 | Give Markdown headings stable ids so a contents link can scroll to the heading. | Done |
| P2 | iOS: VoiceOver names on icon buttons, selected filter chips, Dynamic Type text styles, orange for "expiring soon," and spoken time remaining.  The folder parser accepts the new file list and the older emoji list.  Expired pages are recognized by the new wording and the old wording. | Done |
| P2 | Privacy page in plain language, including the crash-report sentence and the rule that HTML downloads. | Done |
| P2 | Sign-in screens keep their current fields and requests.  Only the labels, the hint, and the failure sentences change. | Done |
| P3 | One shared stylesheet and page chrome, so the next edit cannot drift. | Deferred |
| P3 | Account-owner table as a stacked list on a narrow screen. | Deferred |
| P3 | A recorded VoiceOver and keyboard pass on a deployed preview, and an iOS Dynamic Type pass in Simulator. | Deferred |
| P3 | Public account signup.  The product does not have it. | Deferred |
| P3 | Passkey sign-in.  Another change owns that flow. | Deferred |
| P3 | Showing uploaded HTML as a page in the browser.  HTML stays a download. | Deferred |
| P3 | Changing the guest limits, or turning guest uploads back on. | Deferred |
| P3 | A visual rebrand, or splitting the worker bundle back into separate source files. | Deferred |

## What was checked

`node --check worker/fleetlink-api.mjs` succeeds.  The repository has no unit-test suite.  Swift was not compiled here.  No Swift toolchain is installed in this environment.  Nothing was deployed.
