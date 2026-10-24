/**
 * The public site: the landing page and the For Agents guide.  Everything here
 * is static markup built from the same components the dashboard uses.
 */
import { escapeHtml } from "../http.mjs";
import { appClipMeta, ogTags, page } from "./layout.mjs";

const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  web: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/>'),
  cli: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 15h5"/>'),
  agent: svg('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  phone: svg('<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>'),
  box: svg('<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>'),
  doc: svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>'),
  image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  team: svg('<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.2A5 5 0 0 1 21 19"/>'),
  key: svg('<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  shield: svg('<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  chat: svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z"/>'),
  admin: svg('<path d="M4 21v-4M4 13V3M12 21v-8M12 9V3M20 21v-6M20 11V3M2 17h4M10 9h4M18 15h4"/>')
};

/** A code sample, escaped for HTML. */
function code(text) {
  return `<pre><code>${escapeHtml(text)}</code></pre>`;
}

/** A logo animation that plays once and rests on its last frame.  An animated
 * image, not a <video>:  Safari's video-autoplay setting cannot block it.
 * Animated WebP (loop count 1) with a GIF fallback; the .jpg is the still for
 * prefers-reduced-motion. */
export function introVideo(name, cls, label) {
  return `<picture class="${cls}" data-intro data-still="/assets/media/${name}.jpg"><source type="image/webp" srcset="/assets/media/${name}.webp"><img src="/assets/media/${name}.gif" alt="${escapeHtml(label)}"></picture>`;
}

/** A static picture of the dashboard, built from the dashboard's own components. */
function dashboardPreview(name) {
  const row = (slug, detail, pills, expires) => `<div class="preview-row"><div><span class="mono">${slug}</span><small>${detail}</small></div><div>${pills}<span class="pill gray">${expires}</span></div></div>`;
  return `<div class="preview" aria-hidden="true">
    <div class="preview-bar"><i></i><i></i><i></i><span>fleetlink.online/dashboard</span></div>
    <div class="preview-body">
      <h3>Hello, ${escapeHtml(name)}</h3>
      <p class="small muted">5 live shares, 41 MB of 2.0 GB used.</p>
      <div class="meter"><span class="meter-sample"></span></div>
      <div class="preview-tabs"><b>Shares</b><span>New Share</span><span>API Tokens</span><span>Teams</span></div>
      ${row("pr-2214-review", "build-agent · test report + 14 screenshots", '<span class="pill">Mobile team</span>', "in 3 days")}
      ${row("spec-sync-v3", "Spec draft · rendered Markdown", '<span class="pill amber">Password</span>', "in 7 days")}
      ${row("release-4127", "release-agent · ios-build.zip · 36 MB", '<span class="pill">Mobile team</span>', "in 7 days")}
      ${row("standup", "→ linear.app/…/cycle-42", '<span class="pill gray">Link</span>', "in 30 days")}
    </div>
  </div>`;
}

/** The handoff, drawn as three cards: an agent publishes, a link is posted, a person reviews. */
function handoffFlow() {
  return `<div class="flow" aria-label="How a handoff works">
    <div class="flow-step">
      <span class="step-num">1</span>
      <h3>An agent publishes</h3>
      <p>A build agent finishes and shares its output with its own token.</p>
      <div class="term"><span class="term-bar"><i></i><i></i><i></i></span><code><b>$</b> fleet-share --slug pr-2214-review \\
    --team mobile ./report/
<span class="ok">Shared 15 files as fleetlink.online/pr-2214-review</span>
<span class="dim">Expires in 3 days</span></code></div>
    </div>
    <div class="flow-step">
      <span class="step-num">2</span>
      <h3>The link goes where the work is</h3>
      <p>The agent posts it in the pull request, the chat thread, or the ticket.</p>
      <div class="chat-card"><div class="chat-head"><span class="avatar">B</span><b>build-agent</b><span class="dim">just now</span></div>
        <p>Tests pass on PR #2214.&#160; Report and screenshots:</p>
        <div class="link-card"><span class="link-icon">${ICONS.link}</span><div><b>PR 2214 review</b><small>fleetlink.online/pr-2214-review · 15 files · 3 days</small></div></div>
      </div>
    </div>
    <div class="flow-step">
      <span class="step-num">3</span>
      <h3>People and agents pick it up</h3>
      <p>A teammate opens the report in the browser or the app; another agent reads it raw.</p>
      <div class="term"><span class="term-bar"><i></i><i></i><i></i></span><code><b>$</b> curl fleetlink.online/pr-2214-review/summary.md<span class="hl">?raw=1</span>
# PR 2214: 312 passed, 0 failed
<span class="dim">…</span></code></div>
    </div>
  </div>`;
}

function card(icon, title, body, extra = "") {
  return `<div class="card tile"><span class="icon">${ICONS[icon]}</span><h3>${title}</h3><p>${body}</p>${extra}</div>`;
}


/** The How It Works guide, living on the home page as the #guide section. */
function guideSection(origin) {
  return `<section class="section" id="guide"><article class="card">
      <h2>How FleetLink Works</h2>
      <p>FleetLink gives you a link to a file, a folder, or another web address.&#160; Every link belongs to the account that made it and expires on its own.</p>

      <h3>Accounts</h3>
      <p>Create an account on the <a href="/login">sign-in page</a> with a passkey.&#160; There is no password.&#160; Add a second passkey from your dashboard so you can sign in from another device.&#160; Your dashboard lists your links, your API tokens, your teams, and the devices you are signed in on.</p>

      <h3>Sharing On The Website</h3>
      <ol>
        <li>Open the <a href="/dashboard#new">dashboard</a> and choose New Share.</li>
        <li>Pick files, or paste a web address for a short link.</li>
        <li>Choose how long it stays up.&#160; Add a name, a title, a password, or a team if you like.</li>
        <li>Copy the link.</li>
      </ol>

      <h3>How Long A Link Lasts</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Who</th><th>Files</th><th>Short links</th></tr></thead>
        <tbody>
          <tr><td>Signed in</td><td>Up to 7 days (3 by default).&#160; 100 MB per file, 500 MB and 500 files per share.</td><td>Up to 180 days (30 by default).</td></tr>
          <tr><td>Admin</td><td>Any length, or never.&#160; 300 MB per file, 1 GB per share.&#160; A share that never expires holds up to 500 MB.</td><td>Any length, or never.</td></tr>
        </tbody>
      </table></div>
      <p>Each account has a storage quota across its live links.&#160; A link can be renewed three times.&#160; A password is optional; without one, anyone with the link can open it.</p>

      <h3>Agents, Scripts, And The CLI</h3>
      <p>Create an API token on the <a href="/dashboard#tokens">dashboard</a>.&#160; The token acts as you, can be limited (largest file, longest share, no short links, one team), and can be revoked at any time.</p>
      <pre>export FLEETLINK_TOKEN=fla_…
fleet-share notes.md
fleet-share --days 7 ./report/
fleet-share link https://example.com/long/address
fleet-share list</pre>
      <p>Or use <code>curl</code>:</p>
      <pre>curl -X PUT "${origin}/notes/notes.md" \\
  -T ./notes.md \\
  -H "Authorization: Bearer $FLEETLINK_TOKEN" \\
  -H "Content-Type: text/markdown; charset=utf-8" \\
  -H "X-Expire-Days: 3"</pre>
      <p>Agents that speak MCP can connect to <code>${origin}/mcp</code> with the same token.</p>

      <h3>iPhone</h3>
      <p>The FleetLink app signs in with your passkey, lists your links, and makes new ones.&#160; To share from the Share sheet, create an API token, <a href="/api/shortcut/download">download the Shortcut</a>, and paste the token when Shortcuts asks.</p>

      <h3>Teams</h3>
      <p>A team shares a space for links.&#160; Everyone in the team sees its links.&#160; Team owners and admins can change or delete any of them; members change their own.&#160; A token can be tied to one team so an agent's uploads land there.</p>

      <h3>What People See</h3>
      <ul>
        <li>A Markdown file opens as a formatted page.</li>
        <li>Several files under one link open as a list.</li>
        <li>HTML files download instead of opening in the browser.</li>
        <li>When the time is up, the link stops working.</li>
      </ul>
    </article></section>`;
}

export function home(ctx, principal) {
  const origin = ctx.url.origin;
  const signedIn = Boolean(principal);
  const name = principal?.user?.display_name || "Ada";
  const cta = signedIn
    ? `<a class="button large" href="/dashboard">Open Your Dashboard</a><a class="button large secondary" href="/agents">Connect An Agent</a>`
    : `<a class="button large" href="/login#signup">Create Your Account</a><a class="button large secondary" href="/agents">Connect An Agent</a>`;
  const fine = signedIn
    ? `Signed in as ${escapeHtml(name)}.&#160; Your links, tokens, and teams are on the <a href="/dashboard">dashboard</a>.`
    : `Already have an account?&#160; <a href="/login">Sign in</a> with your passkey.`;
  const deleted = ctx.url.searchParams.get("deleted") === "1"
    ? '<div class="wrap"><p class="notice ok">Your account was deleted.&#160; Its shares are removed within the hour.</p></div>'
    : "";
  const closing = signedIn
    ? `<div><h2>Pick up where you left off.</h2><p>Your shares, API tokens, and teams are one click away.</p></div><div class="actions"><a class="button large gold" href="/dashboard">Open Dashboard</a><a class="button large secondary" href="/agents">Connect An Agent</a></div>`
    : `<div><h2>Give your fleet a place to hand off work.</h2><p>Create an account with a passkey, make a token for each agent, and share your first link in a minute.</p></div><div class="actions"><a class="button large gold" href="/login#signup">Create Your Account</a><a class="button large secondary" href="/login">Sign In</a></div>`;
  return page(ctx.env, {
    title: "Handoffs For People And Agents",
    principal,
    active: "home",
    fullBleed: true,
    heroBrand: !principal,
    scripts: ["app.js"],
    head: ogTags({ title: "FleetLink", description: "Where people and AI agents hand off work: files, folders, notes, and short links with an owner and an expiry.", url: `${origin}/`, image: `${origin}/preview.png` }) + appClipMeta(ctx.env),
    body: `${deleted}<section class="hero">
      <div class="bar">
        <div>
          ${introVideo("fleetlink-wordmark", "hero-intro", "FleetLink")}
          <p class="eyebrow">For people and AI agent fleets</p>
          <h1>Where your agents and your team <span class="glow">hand off work.</span></h1>
          <p class="lead">Builds, test reports, screenshots, specs, and work in progress: any agent or person shares it in one command and gets a link that is owned, organized, and gone when it should be.</p>
          <div class="actions">${cta}</div>
          <p class="fine">${fine}</p>
        </div>
        ${dashboardPreview(name)}
      </div>
    </section>
    <div class="strip"><div class="bar">
      <span><b>CLI</b> fleet-share</span><span><b>MCP</b> /mcp</span><span><b>API</b> JSON + raw PUT</span><span><b>Skills</b> Claude · Cursor · Codex · Grok</span><span><b>iPhone</b> app + App Clip</span>
    </div></div>
    <div class="wrap landing">
      <section class="section" id="handoffs">
        <div class="section-head"><p class="eyebrow">How a handoff works</p><h2>One link from the agent that made it to everyone who needs it.</h2><p class="muted">Agents stop pasting walls of output into chat.&#160; They publish the artifact, post the link, and move on.&#160; The link knows who owns it, which team can see it, and when it goes away.</p></div>
        ${handoffFlow()}
      </section>

      <section class="section" id="agents">
        <div class="split-head">
          <div class="section-head"><p class="eyebrow">Built for agent fleets</p><h2>Every agent gets its own key, its own limits, and a shared place to put its work.</h2></div>
          <a class="button secondary" href="/agents">Read the agent guide →</a>
        </div>
        <div class="grid-3">
          ${card("key", "A Token Per Agent", "Give each agent an <code>fla_</code> token that acts as you, with its own cap on file size and lifetime.&#160; Revoke one without touching the rest.")}
          ${card("agent", "MCP Server", "Connect Claude Code, Cursor, Codex, or Grok to <code>fleetlink.online/mcp</code>.&#160; Seven tools create, list, renew, and delete shares.")}
          ${card("cli", "One-Line CLI", "<code>fleet-share ./out/</code> uploads a file or a whole folder as one link and prints every file's URL.")}
          ${card("team", "Team-Bound Output", "Tie a token to a team and every upload lands in the team space, where the people who need it can see it.")}
          ${card("doc", "Readable By Agents", "Add <code>?raw=1</code> for the source of any note, or ask for JSON to get a folder's file list.&#160; Agents read what other agents wrote.")}
          ${card("box", "Install The Skill", "<code>fleet-share skill install</code> teaches Claude, Cursor, Codex, and Grok how to use FleetLink, pinned and checksum-verified.")}
        </div>
      </section>

      <section class="section" id="features">
        <div class="section-head"><p class="eyebrow">Artifacts and work in progress</p><h2>Share anything a project produces.</h2><p class="muted">Everything gets a clean viewer, so a link is useful the moment it lands.</p></div>
        <div class="grid-3">
          ${card("box", "Build Artifacts", "Zips, binaries, and logs up to 100 MB a file and 500 MB a share.&#160; Large folders upload file by file.")}
          ${card("image", "Reports And Screenshots", "Test reports, coverage, and screenshot sets open as a folder of previews.")}
          ${card("doc", "Notes And Specs", "Markdown renders as a clean page with linked headings: perfect for specs, plans, and handoff notes.")}
          ${card("folder", "Whole Folders", "Share a directory as one link with a browsable listing, or open any file inside it directly.")}
          ${card("link", "Short Links", "Turn a long PR, dashboard, or ticket URL into a short link that lasts up to 180 days.")}
          ${card("lock", "Private Handoffs", "Add a password to any share.&#160; Passwords are stored as salted hashes and never shown again.")}
        </div>
        <p class="small muted center-text">Read <a href="/instructions">how FleetLink works</a> and the <a href="/agents">guide for agents</a>.</p>
      </section>

      ${guideSection(origin)}

      <section class="section" id="teams">
        <div class="two-col">
          <div>
            <p class="eyebrow">Teams and accounts</p>
            <h2>Many people, many agents, no stepping on each other.</h2>
            <p class="muted">Every link has an owner.&#160; Nobody else can see your list, change your links, or claim your names, unless you share a team.</p>
            <ul class="checks">
              <li><b>Personal until you share it.</b>&#160; Move any share to a team's side with view or edit access, and back again.&#160; You stay the owner.</li>
              <li><b>Team spaces.</b>&#160; Members see every team link and, with edit access, add files to work in progress; owners and admins manage them.</li>
              <li><b>Passkey accounts.</b>&#160; Face ID, Touch ID, or a security key.&#160; No passwords to leak.</li>
              <li><b>Sessions you control.</b>&#160; See every signed-in device and sign out the ones you do not recognize.</li>
              <li><b>Admin console.</b>&#160; Invites, sign-up policy, per-person quotas, disabling accounts, and an audit log.</li>
            </ul>
          </div>
          <div class="card team-card" aria-hidden="true">
            <div class="actions split"><h3>Mobile team</h3><span class="pill gray">12 live shares</span></div>
            <div class="member"><span class="avatar">A</span><div><b>Ada</b><small>Owner</small></div></div>
            <div class="member"><span class="avatar">G</span><div><b>Grace</b><small>Admin</small></div></div>
            <div class="member"><span class="avatar bot">B</span><div><b>build-agent</b><small>Token · uploads land here · 7-day cap</small></div></div>
            <div class="member"><span class="avatar bot">R</span><div><b>release-agent</b><small>Token · 300 MB files · no short links</small></div></div>
          </div>
        </div>
      </section>

      <section class="section" id="everywhere">
        <div class="section-head"><p class="eyebrow">Wherever you are</p><h2>Make and open links from any surface.</h2></div>
        <div class="grid">
          ${card("web", "The Dashboard", "Upload, make short links, renew, rename, and delete.&#160; Manage tokens, teams, passkeys, and sessions.", `<p><a href="${signedIn ? "/dashboard" : "/login#signup"}">${signedIn ? "Open the dashboard" : "Create an account"} →</a></p>`)}
          ${card("cli", "The Terminal", "Sign in once with <code>fleet-share login</code>, then share, list, renew, and delete from any shell.", `<p><a href="/agents#cli">CLI guide →</a></p>`)}
          ${card("chat", "Chat And Tickets", "Links unfurl with a title and preview image in Slack, Zulip, and Messages.", "")}
          ${card("phone", "iPhone", "The FleetLink app lists your links and makes new ones; the App Clip opens a link without installing anything.", `<p><a href="/#guide">Set it up →</a></p>`)}
        </div>
      </section>

      <section class="section" id="trust">
        <div class="section-head"><p class="eyebrow">Safe by default</p><h2>Built so a shared file cannot hurt the person who opens it.</h2></div>
        <div class="grid-3">
          ${card("shield", "Sandboxed Files", "Every shared file opens in a browser sandbox, and HTML always downloads, so a link cannot act as you.")}
          ${card("clock", "Gone On Time", "Files expire in up to 7 days and short links in up to 180, then they are deleted.&#160; Renew when you need longer.")}
          ${card("key", "Hashed Credentials", "Sessions, tokens, and invite codes are stored only as peppered hashes.&#160; A database copy is not a key ring.")}
        </div>
      </section>

      <section class="section" id="limits">
        <div class="section-head"><p class="eyebrow">Limits</p><h2>Generous for work, tidy by default.</h2></div>
        <div class="table-wrap"><table>
          <thead><tr><th></th><th>People and their agents</th><th>Admins</th></tr></thead>
          <tbody>
            <tr><td><b>File size</b></td><td>100 MB</td><td>300 MB</td></tr>
            <tr><td><b>Per share</b></td><td>500 MB, 500 files</td><td>1 GB, 2,000 files</td></tr>
            <tr><td><b>File lifetime</b></td><td>Up to 7 days (3 by default)</td><td>Any, or never (up to 500 MB)</td></tr>
            <tr><td><b>Short links</b></td><td>Up to 180 days (30 by default)</td><td>Any, or never</td></tr>
            <tr><td><b>Storage</b></td><td>2 GB across live shares</td><td>Unlimited</td></tr>
            <tr><td><b>Renewals</b></td><td>3 per share</td><td>Unlimited</td></tr>
          </tbody>
        </table></div>
      </section>

      <section class="section" id="faq">
        <div class="section-head"><p class="eyebrow">Questions</p><h2>Good to know.</h2></div>
        <div class="faq">
          <details><summary>Who can open a link?</summary><p>Anyone who has it, unless it has a password.&#160; Only you, your team's owners and admins, and FleetLink admins can see your list of links or change them.</p></details>
          <details><summary>How do agents sign in?</summary><p>They do not need to.&#160; Create an API token on the dashboard and give it to the agent as <code>FLEETLINK_TOKEN</code>.&#160; It acts as you, inside the limits you set, and you can revoke it any time.</p></details>
          <details><summary>What happens when a link expires?</summary><p>It stops working right away and its files are deleted within 15 minutes.&#160; You can renew a link before then, up to three times.</p></details>
          <details><summary>Can agents read what other agents shared?</summary><p>Yes.&#160; Add <code>?raw=1</code> to a note for its source, or send <code>Accept: application/json</code> to a folder link for its file list.</p></details>
          <details><summary>Why does an HTML file download instead of opening?</summary><p>So a shared page can never run as fleetlink.online with your sign-in.&#160; Every other file opens in a sandbox for the same reason.</p></details>
          <details><summary>Do I need an invite?</summary><p>Not right now: anyone can create an account.&#160; Admins can switch FleetLink to invite-only at any time.</p></details>
        </div>
      </section>

      <section class="cta">${closing}</section>
    </div>`
  });
}

export function agents(ctx, principal) {
  const origin = escapeHtml(ctx.url.origin);
  const tokenStep = principal
    ? `<a class="button" href="/dashboard#tokens">Create A Token</a>`
    : `<a class="button" href="/login#signup">Create An Account</a><a class="button secondary" href="/login?next=/dashboard%23tokens">Sign In</a>`;
  return page(ctx.env, {
    title: "FleetLink For Agents",
    principal,
    active: "agents",
    head: ogTags({ title: "FleetLink For Agents", description: "Give every agent a token, a CLI, and an MCP server for sharing artifacts and work in progress.", url: `${ctx.url.origin}/agents`, image: `${ctx.url.origin}/preview.png` }),
    body: `<div class="dash-head"><div><p class="eyebrow">For agents</p><h1>Connect an agent in three steps.</h1><p class="muted lead-sm">Agents publish builds, reports, notes, and work in progress with their own token, then post the link wherever the team is working.</p></div></div>
    <div class="steps">
      <div class="card step"><span class="step-num">1</span><h3>Create a token</h3><p>On the dashboard, open API Tokens.&#160; Name it after the agent, cap its file size or lifetime if you like, and tie it to a team so its output lands there.</p><div class="actions">${tokenStep}</div></div>
      <div class="card step"><span class="step-num">2</span><h3>Give it to the agent</h3><p>Set it in the agent's environment.&#160; Never paste it into a prompt or a file you commit.</p>${code('export FLEETLINK_TOKEN=fla_…')}</div>
      <div class="card step"><span class="step-num">3</span><h3>Share</h3><p>Use the CLI, MCP, or plain HTTP.&#160; Every link the agent makes shows up on your dashboard.</p>${code('fleet-share ./report/')}</div>
    </div>

    <section class="section" id="cli">
      <h2>The CLI</h2>
      <p class="muted"><code>fleet-share</code> needs Python 3 and nothing else.&#160; It reads <code>FLEETLINK_TOKEN</code>, or a token saved with <code>fleet-share login</code>.</p>
      <div class="two-col">
        ${code(`fleet-share notes.md ./screenshots/        # one share, every file
fleet-share --slug pr-2214 --team mobile ./out/
fleet-share --days 7 --password "$PW" build.zip
fleet-share link https://github.com/org/repo/pull/2214`)}
        ${code(`fleet-share list --teams        # shares in my teams
fleet-share info pr-2214         # files and links
fleet-share share pr-2214 --team mobile   # team can view and edit; you keep it
fleet-share upload-url pr-2214 big.zip    # one-time curl -T URL
fleet-share renew pr-2214 --days 3
fleet-share delete pr-2214 -y
fleet-share whoami               # account, usage, limits`)}
      </div>
    </section>

    <section class="section" id="mcp">
      <h2>MCP</h2>
      <p class="muted">Streamable HTTP at <code>${origin}/mcp</code> with the token as a bearer header.&#160; Tools create shares and links, list and read them, <code>fleetlink_share_to_team</code> and <code>fleetlink_make_personal</code> to move work between your personal side and a team's, <code>fleetlink_add_file</code> and <code>fleetlink_read_file</code> to collaborate on a teammate's work in progress, and <code>fleetlink_upload_url</code> for a one-time <code>curl -T</code> upload of anything too big for a tool call.&#160; Fleet cloud seats get the same tools on the Agent-Sync MCP server, with no token of their own.</p>
      <div class="two-col">
        <div class="card"><h3>Claude Code</h3>${code(`claude mcp add --transport http fleetlink \\
  ${ctx.url.origin}/mcp \\
  --header "Authorization: Bearer $FLEETLINK_TOKEN"`)}</div>
        <div class="card"><h3>Codex</h3>${code(`# ~/.codex/config.toml
[mcp_servers.fleetlink]
url = "${ctx.url.origin}/mcp"
bearer_token_env_var = "FLEETLINK_TOKEN"`)}</div>
        <div class="card"><h3>Cursor</h3>${code(`// ~/.cursor/mcp.json
{ "mcpServers": { "fleetlink": {
  "url": "${ctx.url.origin}/mcp",
  "headers": { "Authorization": "Bearer <token>" } } } }`)}</div>
        <div class="card"><h3>Grok</h3>${code(`# ~/.grok/config.toml
[mcp_servers.fleetlink]
url = "${ctx.url.origin}/mcp"
headers = { "Authorization" = "Bearer \${FLEETLINK_TOKEN}" }`)}</div>
      </div>
    </section>

    <section class="section" id="skill">
      <h2>The agent skill</h2>
      <p class="muted">Installs FleetLink's instructions into Claude, Cursor, Codex, Grok, and <code>~/.agents</code>, so an agent knows when and how to share.&#160; Outside a checkout the download is pinned to a commit and checked against SHA-256 hashes before anything runs.</p>
      ${code("fleet-share skill install\nfleet-share skill install --check")}
    </section>

    <section class="section" id="http">
      <h2>Plain HTTP</h2>
      <p class="muted">Anything that can make a request can share.&#160; Settings for a new share travel in headers.</p>
      <div class="two-col">
        ${code(`curl -X PUT ${ctx.url.origin}/pr-2214/report.md \\
  -T report.md \\
  -H "Authorization: Bearer $FLEETLINK_TOKEN" \\
  -H "Content-Type: text/markdown; charset=utf-8" \\
  -H "X-Expire-Days: 3" -H "X-Fleet-Team: <team id>"`)}
        ${code(`# read what another agent shared
curl ${ctx.url.origin}/pr-2214/report.md?raw=1
curl -H "Accept: application/json" ${ctx.url.origin}/pr-2214

# your shares, as JSON
curl -H "Authorization: Bearer $FLEETLINK_TOKEN" \\
  "${ctx.url.origin}/api/shares?scope=teams"`)}
      </div>
    </section>

    <section class="section" id="etiquette">
      <h2>Good habits for agents</h2>
      <div class="grid-3">
        ${card("clock", "Pick a lifetime", "Default to the shortest that works.&#160; Work in progress rarely needs more than 3 days.")}
        ${card("team", "Use a team token", "Bind each agent's token to the team that should see its output, so nobody has to forward links.")}
        ${card("chat", "Post the link, not the payload", "Share the report and put one line and the link in the PR or thread.")}
        ${card("doc", "Read raw", "Fetch notes with <code>?raw=1</code> and folders as JSON instead of scraping the page.")}
        ${card("lock", "Password the sensitive", "Add a password for anything outside the team's eyes, and send it separately.")}
        ${card("key", "One token per agent", "Never share a token between agents.&#160; Revoke it when the agent is retired.")}
      </div>
    </section>`
  });
}
