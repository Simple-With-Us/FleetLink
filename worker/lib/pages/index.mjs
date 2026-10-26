/** Server-rendered pages.  Data-heavy pages are shells that /assets/*.js fills in. */
import { optionalPrincipal } from "../auth.mjs";
import { escapeHtml, html, redirect } from "../http.mjs";
import { appClipMeta, ogTags, page } from "./layout.mjs";
import { agents, home, introVideo } from "./marketing.mjs";

const SCRIPTS = (name) => ["app.js", name];

function origin(ctx) {
  return ctx.url.origin;
}

function login(ctx, principal, settings) {
  if (principal) return null;
  const mode = settings.signup_mode;
  const signedOut = ctx.url.searchParams.get("signed_out") === "1" ? '<p class="notice ok">You are signed out.</p>' : "";
  const inviteField = mode === "open"
    ? `<label for="su-invite">Invite code (optional)</label><input id="su-invite" name="invite" type="text" autocomplete="off" placeholder="ABCD-EFGH-JKLM-NPQR">`
    : `<label for="su-invite">Invite code</label><input id="su-invite" name="invite" type="text" autocomplete="off" required placeholder="ABCD-EFGH-JKLM-NPQR">`;
  const signupNote = mode === "open"
    ? "Anyone can create an account."
    : mode === "invite" ? "FleetLink is invite-only right now.&#160; Ask an admin for a code." : "Sign-up is closed.&#160; An invite code still works.";
  return page(ctx.env, {
    title: "Sign In",
    principal,
    active: "login",
    scripts: SCRIPTS("login.js"),
    body: `<div id="auth">
      <div class="auth-head">
        ${introVideo("fleetlink-monogram", "auth-intro", "FleetLink")}
        <h1>Welcome To FleetLink</h1>
        <p class="muted">Sign in to see your links, API tokens, and teams, or create an account in a few seconds.</p>
        <div id="auth-msg" class="notice error" hidden role="alert"></div>
        ${signedOut}
      </div>
      <div class="auth-grid">
      <section class="card" id="signin">
        <h2>Sign In</h2>
        <p class="muted">Use the passkey you made for FleetLink.&#160; Your device asks for Face ID, Touch ID, or your security key.</p>
        <form id="signin-form">
          <label for="si-email">Email (optional)</label>
          <input id="si-email" name="email" type="email" autocomplete="username webauthn" placeholder="Only needed if your device does not offer the passkey">
          <div class="actions mt"><button type="submit">Sign In With A Passkey</button></div>
        </form>
      </section>
      <section class="card" id="signup">
        <h2>Create An Account</h2>
        <p class="muted">${signupNote}&#160; Your account is protected by a passkey on this device.</p>
        <form id="signup-form">
          <label for="su-name">Display name</label>
          <input id="su-name" name="display_name" type="text" maxlength="64" autocomplete="name" required>
          <label for="su-email">Email (optional)</label>
          <input id="su-email" name="email" type="email" maxlength="254" autocomplete="email">
          ${inviteField}
          <div class="actions mt"><button type="submit">Create A Passkey</button></div>
        </form>
      </section>
      </div>
      <p class="small muted center-text">New to FleetLink?&#160; <a href="/">See what it does</a> or read <a href="/#guide">how it works</a>.</p>
    </div>`
  });
}

function table(id, headers) {
  return `<div class="table-wrap"><table><thead><tr>${headers.map(([label, cls, sortKey]) => `<th${cls ? ` class="${cls}"` : ""}${sortKey ? ` data-sort="${sortKey}"` : ""}>${label}</th>`).join("")}</tr></thead><tbody id="${id}"></tbody></table></div>`;
}

function dashboard(ctx, principal) {
  const shareFields = (kind) => `
    <div class="row">
      <div><label for="${kind}-slug">Name (optional)</label><input id="${kind}-slug" name="slug" type="text" maxlength="64" placeholder="random if blank" autocomplete="off"></div>
      <div><label for="${kind}-days">Expires after</label><select id="${kind}-days" name="days"></select></div>
      <div><label for="${kind}-team">Share with</label><select id="${kind}-team" name="team_id" data-teams></select></div>
      <div><label for="${kind}-access">Team can</label><select id="${kind}-access" name="team_access"><option value="edit">View and edit</option><option value="view">View only</option></select></div>
    </div>
    <div class="row">
      <div><label for="${kind}-title">Title (optional)</label><input id="${kind}-title" name="title" type="text" maxlength="200"></div>
      <div><label for="${kind}-password">Password (optional)</label><input id="${kind}-password" name="password" type="password" autocomplete="new-password"></div>
    </div>`;
  return page(ctx.env, {
    title: "Dashboard",
    principal,
    active: "dashboard",
    scripts: SCRIPTS("dashboard.js"),
    body: `<div id="dashboard" data-admin="${principal.isAdmin ? "1" : "0"}">
      <div class="dash-head">
        <div><p class="eyebrow">Your dashboard</p><h1 id="hello">Dashboard</h1></div>
        <div id="usage" class="usage"><p class="small muted">Loading…</p></div>
      </div>
      <div class="tabs" role="tablist" aria-label="Dashboard sections">
        <button type="button" role="tab" data-tab="shares">Shares</button>
        <button type="button" role="tab" data-tab="new">New Share</button>
        <button type="button" role="tab" data-tab="tokens">API Tokens</button>
        <button type="button" role="tab" data-tab="teams">Teams</button>
        <button type="button" role="tab" data-tab="bots">Bots</button>
        <button type="button" role="tab" data-tab="account">Account</button>
      </div>

      <section id="panel-shares" role="tabpanel">
        <form id="share-search" class="row">
          <div><label for="share-scope">Show</label><select id="share-scope"><option value="mine">My shares</option></select></div>
          <div><label for="share-q">Search</label><input id="share-q" type="search" placeholder="Name, title, or destination"></div>
          <div class="end"><button type="submit" class="secondary">Search</button> <button type="button" id="share-refresh" class="secondary" title="Refresh shares">↻ Refresh</button></div>
        </form>
        <div class="chip-row" id="share-chips">
          <button type="button" class="chip active" data-filter="all">All</button>
          <button type="button" class="chip" data-filter="personal">Personal</button>
          <button type="button" class="chip" data-filter="team">Team</button>
          <button type="button" class="chip" data-filter="files">Files</button>
          <button type="button" class="chip" data-filter="link">Links</button>
          <button type="button" class="chip" data-filter="forever">Forever</button>
          <button type="button" class="chip" data-filter="password">Password</button>
        </div>
        <div id="share-summary" class="share-summary"></div>
        ${table("share-rows", [["Slug", "sortable", "name"], ["Contents", "sortable", "contents"], ["Owner", "hide-sm sortable", "owner"], ["Expires", "sortable", "expires"], ["", ""]])}
        <p id="share-empty" class="empty" hidden>Nothing here yet.&#160; Use New Share to make a link.</p>
        <p><button type="button" id="share-more" class="secondary" hidden>Load More</button></p>

      <div id="panel-analytics" class="analytics">
        <div class="dash-head">
          <div><p class="eyebrow">Traffic</p><h2>Views And Downloads</h2></div>
          <div class="actions">
            <div><label for="analytics-scope">Show</label><select id="analytics-scope"><option value="mine">My shares</option><option value="teams">My teams</option>${principal.isAdmin ? '<option value="all">Everyone (admin)</option>' : ""}</select></div>
            <div><label for="analytics-days">Last</label><select id="analytics-days"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select></div>
            <button type="button" id="analytics-refresh" class="secondary" title="Refresh traffic">↻ Refresh</button>
          </div>
        </div>
        <p class="small muted">FleetLink counts each public view and download it serves, by day (UTC).&#160; Password unlocks, folder listings, short-link opens, and file bytes are included.&#160; A view can take up to a few seconds to appear.</p>
        <div id="analytics-summary" class="grid"><div class="card"><p class="small muted">Loading…</p></div></div>
        <h3>Busiest Shares</h3>
        <div class="table-wrap"><table><thead><tr><th>Share</th><th>Views</th><th>Downloads</th><th>Bytes</th></tr></thead><tbody id="analytics-top"></tbody></table></div>
        <p id="analytics-top-empty" class="empty" hidden>No traffic in this window.</p>
        <h3>Daily</h3>
        <div class="table-wrap"><table><thead><tr><th>Day</th><th>Views</th><th>Downloads</th><th>Bytes</th></tr></thead><tbody id="analytics-series"></tbody></table></div>
        <p id="analytics-series-empty" class="empty" hidden>No traffic in this window.</p>
        ${principal.isAdmin ? `<div class="card" id="cf-analytics">
          <div class="actions split">
            <h2>Cloudflare Site Traffic</h2>
            <div class="actions">
              <div><label for="cf-days">Last</label><select id="cf-days"><option value="1">1 day</option><option value="7" selected>7 days</option><option value="30">30 days</option></select></div>
              <button type="button" id="cf-refresh" class="secondary" title="Refresh Cloudflare traffic">↻ Refresh</button>
            </div>
          </div>
          <div id="cf-body"><p class="small muted">Loading…</p></div>
        </div>` : ""}
      </div>
      </section>

      <section id="panel-new" role="tabpanel" hidden>
        <div class="grid">
          <form id="new-files" class="card">
            <h2>Share Files</h2>
            <label for="files-input">Files</label>
            <input id="files-input" name="files" type="file" multiple required>
            ${shareFields("files")}
            <div class="actions mt"><button type="submit">Upload And Share</button></div>
            <div id="new-files-result"></div>
          </form>
          <form id="new-link" class="card">
            <h2>Make A Short Link</h2>
            <label for="link-url">Destination</label>
            <input id="link-url" name="url" type="url" required placeholder="https://example.com/a/long/address">
            ${shareFields("link")}
            <div class="actions mt"><button type="submit">Make Short Link</button></div>
            <div id="new-link-result"></div>
          </form>
        </div>
      </section>

      <section id="panel-tokens" role="tabpanel" hidden>
        <div class="card">
          <h2>API Tokens</h2>
          <p class="muted">Give each agent, script, or Shortcut its own token.&#160; It acts as you, within the limits you set here, and you can revoke it at any time.</p>
          <p id="token-quota" class="small muted"></p>
          <form id="token-form">
            <div class="row">
              <div><label for="tk-name">Name</label><input id="tk-name" name="name" type="text" maxlength="64" required placeholder="Build agent"></div>
              <div><label for="tk-team">Uploads go to</label><select id="tk-team" name="team_id" data-teams></select></div>
              <div><label for="tk-days">Longest share (days)</label><input id="tk-days" name="max_days" type="number" min="0.01" step="any" placeholder="your limit"></div>
              <div><label for="tk-mb">Largest file (MB)</label><input id="tk-mb" name="max_file_mb" type="number" min="1" step="any" placeholder="your limit"></div>
              <div><label for="tk-exp">Token expires in (days)</label><input id="tk-exp" name="expires_in_days" type="number" min="1" step="1" placeholder="never"></div>
            </div>
            <label class="check"><input type="checkbox" name="allow_links" checked> Can make short links</label>
            <div class="actions mt"><button type="submit">Create Token</button></div>
          </form>
          <div id="token-secret"></div>
        </div>
        ${table("token-rows", [["Token"], ["Limits"], ["Last used", "hide-sm"], ["Expires"], [""]])}
        <p id="token-empty" class="empty" hidden>No tokens yet.</p>
      </section>

      <section id="panel-teams" role="tabpanel" hidden>
        <form id="team-form" class="card">
          <h2>Teams</h2>
          <p class="muted">A team shares a space for links.&#160; Members see the team's shares, and team owners and admins can change or delete them.</p>
          <div class="row"><div><label for="team-name">New team name</label><input id="team-name" name="name" type="text" maxlength="64" required></div>
          <div class="end"><button type="submit">Create Team</button></div></div>
        </form>
        <div id="team-list"></div>
      </section>

      <section id="panel-bots" role="tabpanel" hidden>
        <div class="card">
          <h2>Bots</h2>
          <p class="muted">Bot identities under your account.&#160; Each bot signs in as itself, through the Agent-Sync MCP server or with a token you give it here.&#160; You see and manage everything your bots own, and the fleet's bots work in the Fleet team with you, where they and you can edit and overwrite each other's shares.</p>
          <p id="bot-summary" class="small muted"></p>
          <form id="bot-form" class="row">
            <div><label for="bot-seat">New bot seat</label><input id="bot-seat" name="seat" type="text" maxlength="24" required placeholder="QA-BOT" autocomplete="off"></div>
            <div><label for="bot-name">Display name (optional)</label><input id="bot-name" name="display_name" type="text" maxlength="64"></div>
            <div class="end"><button type="submit">Add Bot</button></div>
          </form>
          <div id="bot-secret"></div>
        </div>
        <div id="bot-defaults"></div>
        ${table("bot-rows", [["Bot"], ["Shares", "hide-sm"], ["Tokens"], ["Status"], [""]])}
        <p id="bot-empty" class="empty" hidden>No bots under your account yet.</p>
      </section>

      <section id="panel-account" role="tabpanel" hidden>
        <form id="profile-form" class="card">
          <h2>Profile &amp; Preferences</h2>
          <div class="row">
            <div><label for="pf-name">Display name</label><input id="pf-name" name="display_name" type="text" maxlength="64" required></div>
            <div><label for="pf-email">Email (optional)</label><input id="pf-email" name="email" type="email" maxlength="254"></div>
            <div><label for="pf-default-team">Default new share destination</label><select id="pf-default-team" name="default_team_id" data-teams></select></div>
          </div>
          <p class="small muted">Choose whether your new uploads land in your personal space or a team by default.</p>
          <div class="actions mt"><button type="submit">Save</button></div>
        </form>
        <div class="card">
          <div class="actions split"><h2>Passkeys</h2><button type="button" id="add-passkey" class="secondary">Add A Passkey</button></div>
          ${table("passkey-rows", [["Name"], ["Added"], ["Last used", "hide-sm"], [""]])}
        </div>
        <div class="card">
          <div class="actions split"><h2>Signed-In Devices</h2><button type="button" id="signout-others" class="secondary">Sign Out Everywhere Else</button></div>
          ${table("session-rows", [["Device"], ["Last active"], ["Signed in", "hide-sm"], [""]])}
        </div>
        <form id="delete-form" class="card">
          <h2>Delete Account</h2>
          <p class="muted">This removes your passkeys, tokens, and sessions now, and your shares within the hour.&#160; It cannot be undone.</p>
          <label for="del-confirm">Type <strong>delete my account</strong> to confirm</label>
          <input id="del-confirm" name="confirm" type="text" autocomplete="off">
          <div class="actions mt"><button type="submit" class="danger">Delete My Account</button></div>
        </form>
      </section>
    </div>`
  });
}

function admin(ctx, principal) {
  return page(ctx.env, {
    title: "Admin",
    principal,
    active: "admin",
    scripts: SCRIPTS("admin.js"),
    body: `<div id="admin" data-user="${escapeHtml(principal.user.id)}">
      <div class="dash-head"><div><p class="eyebrow">FleetLink admin</p><h1>People, Invites, And Settings</h1></div><a class="button secondary" href="/dashboard">Your Dashboard</a></div>
      <div id="stats" class="stats"></div>
      <div class="tabs" role="tablist" aria-label="Admin sections">
        <button type="button" role="tab" data-tab="people">People</button>
        <button type="button" role="tab" data-tab="invites">Invites</button>
        <button type="button" role="tab" data-tab="teams">Teams</button>
        <button type="button" role="tab" data-tab="shares">All Shares</button>
        <button type="button" role="tab" data-tab="settings">Settings</button>
        <button type="button" role="tab" data-tab="audit">Audit Log</button>
      </div>
      <section id="panel-people" role="tabpanel">
        <form id="user-search" class="row"><div><label for="user-q">Find a person</label><input id="user-q" type="search" placeholder="Name, email, or id"></div><div class="end"><button type="submit" class="secondary">Search</button></div></form>
        ${table("user-rows", [["Person"], ["Role"], ["Storage"], ["Credentials", "hide-sm"], ["Last seen", "hide-sm"], [""]])}
      </section>
      <section id="panel-invites" role="tabpanel" hidden>
        <form id="invite-form" class="card">
          <h2>New Invite</h2>
          <div class="row">
            <div><label for="inv-role">Role</label><select id="inv-role" name="role"><option value="user">Person</option><option value="admin">Admin</option></select></div>
            <div><label for="inv-uses">Uses</label><input id="inv-uses" name="max_uses" type="number" min="1" max="100" value="1"></div>
            <div><label for="inv-days">Expires in (days)</label><input id="inv-days" name="expires_in_days" type="number" min="1" max="90" value="14"></div>
            <div><label for="inv-note">Note (optional)</label><input id="inv-note" name="note" type="text" maxlength="200" placeholder="Who it is for"></div>
          </div>
          <div class="actions mt"><button type="submit">Create Invite</button></div>
          <div id="invite-secret"></div>
        </form>
        ${table("invite-rows", [["Code"], ["State"], ["Used"], ["Expires", "hide-sm"], [""]])}
        <p id="invite-empty" class="empty" hidden>No invites yet.</p>
      </section>
      <section id="panel-teams" role="tabpanel" hidden>
        <div class="card"><h2>Fleet Bots</h2><p id="fleet-owner" class="small muted">Loading…</p><div id="fleet-actions" class="actions"></div></div>
        <p class="small muted">Every team.&#160; Fleet is where the fleet owner and the AI seats share work; join a team to see and edit its shares from your dashboard.</p>
        ${table("team-rows", [["Team"], ["Members"], ["Live shares"], [""]])}
        <p id="team-empty" class="empty" hidden>No teams yet.</p>
      </section>
      <section id="panel-shares" role="tabpanel" hidden>
        <form id="share-search" class="row"><div><label for="share-q">Find a share</label><input id="share-q" type="search" placeholder="Name or title"></div><div class="end"><button type="submit" class="secondary">Search</button></div></form>
        ${table("share-rows", [["Slug"], ["Owner"], ["Contents"], ["Expires"], [""]])}
        <p id="share-empty" class="empty" hidden>No live shares.</p>
      </section>
      <section id="panel-settings" role="tabpanel" hidden>
        <form id="settings-form" class="card">
          <h2>Settings</h2>
          <div id="settings-fields"></div>
          <div class="actions mt"><button type="submit">Save Settings</button><button type="button" id="run-sweep" class="secondary">Run Cleanup Now</button></div>
        </form>
      </section>
      <section id="panel-audit" role="tabpanel" hidden>
        ${table("audit-rows", [["When"], ["Who"], ["Action"], ["Detail", "hide-sm"]])}
      </section>
    </div>`
  });
}


function privacy(ctx, principal) {
  return page(ctx.env, {
    title: "Privacy",
    principal,
    head: ogTags({ title: "Privacy Policy — FleetLink", description: "What FleetLink stores, how long a link stays up, and how to ask a question.", url: `${origin(ctx)}/privacy`, image: `${origin(ctx)}/preview.png` }),
    body: `<article class="card">
      <h1>Privacy Policy</h1>
      <p class="small muted">Effective October 15, 2026.&#160; Covers fleetlink.online, fleetlink.app, the FleetLink iPhone app and App Clip, and the fleet-share CLI.&#160; Operator: Simple With Us.</p>
      <h2>What This Covers</h2>
      <p>FleetLink holds a file or a web address for a set time, then removes it.&#160; Opening a link does not need an account.&#160; Making one does.&#160; We do not sell what you upload, and we do not use it for advertising.</p>
      <h2>Your Account</h2>
      <ul>
        <li><strong>Passkeys.</strong>&#160; FleetLink stores the public half of your passkey.&#160; The private half never leaves your device.</li>
        <li><strong>Profile.</strong>&#160; Your display name, and your email if you add one.</li>
        <li><strong>Sessions and tokens.</strong>&#160; Stored as one-way hashes, with a short device label and when each was last used.</li>
        <li><strong>Security log.</strong>&#160; Sign-ups, token and invite changes, and admin actions are kept for 90 days.</li>
      </ul>
      <h2>What You Share</h2>
      <ul>
        <li><strong>Files.</strong>&#160; Kept only until the link expires or you delete it.&#160; HTML files are offered as downloads, not shown as pages.</li>
        <li><strong>Short links.</strong>&#160; The address the link opens.</li>
        <li><strong>Passwords on links.</strong>&#160; Stored as a salted one-way hash.</li>
      </ul>
      <h2>Who Can See What</h2>
      <p>Anyone with a link can open it, unless it has a password.&#160; Only you, the admins of a team the link is in, and FleetLink admins can see your list of links or change them.</p>
      <h2>Deleting</h2>
      <p>Delete a link from your dashboard and it is removed then.&#160; Delete your account from the Account tab and your passkeys, tokens, and sessions go at once, and your links within the hour.</p>
      <h2>iPhone App</h2>
      <p>The app and App Clip do not ask for contacts or location, and read photos only when you pick one to share.&#160; A release build may send a crash report with your name, email, and file contents removed.</p>
      <h2>Questions</h2>
      <p>Write to <a href="mailto:support@fleetlink.online">support@fleetlink.online</a>.</p>
    </article>`
  });
}

function forbiddenPage(ctx, principal) {
  return html(page(ctx.env, { title: "Admins Only", principal, body: '<section class="narrow card"><h1>Admins Only</h1><p>This page is for FleetLink admins.</p><p><a class="button" href="/dashboard">Back To Your Dashboard</a></p></section>' }), 403);
}

export function pageRoutes(router) {
  router.on("GET", "/", async (ctx) => html(home(ctx, await optionalPrincipal(ctx.request, ctx.env))));
  router.on("GET", "/agents", async (ctx) => html(agents(ctx, await optionalPrincipal(ctx.request, ctx.env))));
  router.on("GET", "/features", async () => redirect("/#features", 301));
  router.on("GET", "/intro", async () => redirect("/", 301));
  router.on("GET", "/help", async () => redirect("/#guide", 301));
  router.on("GET", "/login", async (ctx) => {
    const principal = await optionalPrincipal(ctx.request, ctx.env);
    if (principal) return redirect("/dashboard");
    return html(login(ctx, null, await ctx.settings()));
  });
  for (const alias of ["/signin", "/signup", "/register"]) {
    router.on("GET", alias, async (ctx) => redirect(`/login${ctx.url.search}${alias === "/signin" ? "" : "#signup"}`));
  }
  router.on("GET", "/dashboard", async (ctx) => {
    const principal = await optionalPrincipal(ctx.request, ctx.env);
    if (!principal) return redirect("/login?next=/dashboard");
    return html(dashboard(ctx, principal));
  });
  router.on("GET", "/admin", async (ctx) => {
    const principal = await optionalPrincipal(ctx.request, ctx.env);
    if (!principal) return redirect("/login?next=/admin");
    if (!principal.isAdmin) return forbiddenPage(ctx, principal);
    return html(admin(ctx, principal));
  });
  router.on("GET", "/portal", async () => redirect("/dashboard", 301));
  router.on("GET", "/instructions", async () => redirect("/#guide", 301));
  router.on("GET", "/privacy", async (ctx) => html(privacy(ctx, await optionalPrincipal(ctx.request, ctx.env))));
  router.on("GET", "/privacy-policy", async () => redirect("/privacy", 301));
}
