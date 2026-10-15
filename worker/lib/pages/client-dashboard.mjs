/** The signed-in dashboard, served at /assets/dashboard.js. */
export const DASHBOARD_JS = String.raw`
(function () {
  "use strict";
  var FL = window.FL, h = FL.h;
  var state = { me: null, teams: [], next: null };
  var root = document.getElementById("dashboard");
  if (!root) return;
  var isAdmin = root.dataset.admin === "1";

  function teamOptions(select, includeNone, noneLabel) {
    var keep = select.value;
    select.replaceChildren();
    if (includeNone) select.append(h("option", { value: "", text: noneLabel || "Just me (personal)" }));
    state.teams.forEach(function (t) { select.append(h("option", { value: t.id, text: t.name })); });
    if (keep) select.value = keep;
  }

  function daysOptions(select, kind) {
    var list = kind === "link" ? [["1", "1 day"], ["7", "7 days"], ["30", "30 days"], ["90", "90 days"], ["180", "180 days"]] : [["1", "1 day"], ["3", "3 days"], ["7", "7 days"]];
    if (isAdmin) list = list.concat(kind === "link" ? [["365", "1 year"], ["forever", "Never expires"]] : [["30", "30 days"], ["365", "1 year"], ["forever", "Never expires"]]);
    select.replaceChildren();
    list.forEach(function (o) { select.append(h("option", { value: o[0], text: o[1] })); });
    select.value = kind === "link" ? "30" : "3";
  }

  async function loadMe() {
    state.me = await FL.api("GET", "/api/me");
    var usage = state.me.usage, quota = state.me.quotas.storage_bytes;
    var box = document.getElementById("usage");
    var pct = quota ? Math.min(100, Math.round((usage.bytes / quota) * 100)) : 0;
    box.replaceChildren(
      h("p", { class: "small muted" }, usage.shares + " live share" + (usage.shares === 1 ? "" : "s") + ", " + FL.bytes(usage.bytes) + (quota ? " of " + FL.bytes(quota) + " used." : " used.  No storage limit.")),
      quota ? h("div", { class: "meter", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct) }, h("span", { style: "width:" + pct + "%" })) : null
    );
    document.getElementById("hello").textContent = "Hello, " + state.me.user.display_name;
  }

  async function loadTeams() {
    state.teams = (await FL.api("GET", "/api/teams")).teams;
    var scope = document.getElementById("share-scope");
    var keep = scope.value;
    scope.replaceChildren(h("option", { value: "mine", text: "My shares" }));
    if (state.teams.length) scope.append(h("option", { value: "teams", text: "All my teams" }));
    if (state.me && state.me.bots && state.me.bots.count) scope.append(h("option", { value: "bots", text: "My bots' shares" }));
    state.teams.forEach(function (t) { scope.append(h("option", { value: "team:" + t.id, text: "Team: " + t.name })); });
    if (isAdmin) scope.append(h("option", { value: "all", text: "Everyone (admin)" }));
    if (keep) scope.value = keep;
    document.querySelectorAll("select[data-teams]").forEach(function (s) { teamOptions(s, true); });
    document.querySelectorAll("select[data-teams-required]").forEach(function (s) { teamOptions(s, true, "No team"); });
  }

  // Shares
  function shareRow(share) {
    var expires = share.expires_at ? h("span", { title: FL.when(share.expires_at) }, FL.relative(share.expires_at)) : h("span", { class: "pill green", text: "Never" });
    var kind = share.kind === "link" ? h("span", { class: "pill", text: "Link" }) : h("span", { class: "pill gray", text: share.file_count + " file" + (share.file_count === 1 ? "" : "s") + " · " + FL.bytes(share.total_bytes) });
    var tags = [kind];
    if (share.has_password) tags.push(h("span", { class: "pill amber", text: "Password" }));
    if (share.team) tags.push(h("span", { class: "pill", title: share.team.access === "edit" ? "Team members can view and edit" : "Team members can view", text: (share.team.name || "Team") + (share.team.access === "edit" ? " · edit" : " · view") }));
    else tags.push(h("span", { class: "pill gray", text: "Personal" }));
    var actions = h("div", { class: "actions" },
      h("button", { type: "button", class: "small secondary", text: "Copy", onclick: function () { FL.copy(share.url); } }),
      h("a", { class: "button small secondary", href: share.url, target: "_blank", rel: "noopener", text: "Open" }));
    var sharing = sharingControl(share);
    if (sharing) actions.append(sharing);
    if (share.can_edit && share.expires_at) actions.append(h("button", { type: "button", class: "small secondary", text: "Renew", onclick: function () { renew(share); } }));
    if (share.can_manage) actions.append(h("button", { type: "button", class: "small danger", text: "Delete", onclick: function () { remove(share); } }));
    return h("tr", null,
      h("td", null, h("a", { href: share.url, target: "_blank", rel: "noopener", class: "mono", text: share.slug }), share.title ? h("div", { class: "small muted", text: share.title }) : null, share.kind === "link" ? h("div", { class: "small muted", text: "→ " + share.target_url }) : null),
      h("td", null, tags),
      h("td", { class: "hide-sm" }, share.owner && share.owner.display_name ? share.owner.display_name : ""),
      h("td", null, expires),
      h("td", null, actions));
  }

  // Who sees a share.  The owner moves it between the personal side and a
  // team; a team owner or admin changes only the team's access level.  The
  // owner never changes.
  function sharingControl(share) {
    var me = state.me && state.me.user;
    var isOwner = me && (share.owner && share.owner.id === me.id || me.role === "admin");
    var current = share.team ? share.team.id + "|" + share.team.access : "";
    var options = [];
    if (isOwner) {
      options.push(h("option", { value: "", text: "Personal", selected: !share.team }));
      var teams = state.teams.slice();
      if (share.team && !teams.some(function (t) { return t.id === share.team.id; })) teams.push({ id: share.team.id, name: share.team.name || "Team" });
      teams.forEach(function (t) {
        ["edit", "view"].forEach(function (level) {
          var value = t.id + "|" + level;
          options.push(h("option", { value: value, text: t.name + (level === "edit" ? " · can edit" : " · view only"), selected: value === current }));
        });
      });
      if (options.length === 1) return null;
    } else if (share.can_manage && share.team) {
      ["edit", "view"].forEach(function (level) {
        var value = share.team.id + "|" + level;
        options.push(h("option", { value: value, text: (share.team.name || "Team") + (level === "edit" ? " · can edit" : " · view only"), selected: value === current }));
      });
    } else {
      return null;
    }
    return h("select", { class: "small sharing", "aria-label": "Who can see " + share.slug, onchange: async function (e) {
      var parts = e.target.value.split("|");
      var body = parts[0] ? { team_id: parts[0], team_access: parts[1] } : { team_id: null };
      if (!isOwner) body = { team_access: parts[1] };
      try {
        await FL.api("PATCH", "/api/shares/" + encodeURIComponent(share.slug), body);
        FL.toast(parts[0] ? "Shared with the team (" + (parts[1] === "edit" ? "can edit" : "view only") + ").\u00a0 You still own it." : "Personal again.\u00a0 Only you can see it.");
        loadShares(false);
      } catch (err) { FL.fail(err); loadShares(false); }
    } }, options);
  }

  async function loadShares(append) {
    var scope = document.getElementById("share-scope").value || "mine";
    var q = document.getElementById("share-q").value.trim();
    var params = new URLSearchParams();
    if (scope.indexOf("team:") === 0) { params.set("scope", "team"); params.set("team_id", scope.slice(5)); }
    else params.set("scope", scope);
    if (q) params.set("q", q);
    if (append && state.next) params.set("before", state.next);
    var data = await FL.api("GET", "/api/shares?" + params.toString());
    var body = document.getElementById("share-rows");
    if (!append) body.replaceChildren();
    data.shares.forEach(function (s) { body.append(shareRow(s)); });
    state.next = data.next;
    document.getElementById("share-more").hidden = !data.next;
    document.getElementById("share-empty").hidden = body.children.length > 0;
  }

  async function renew(share) {
    try {
      var data = await FL.api("POST", "/api/shares/" + encodeURIComponent(share.slug) + "/renew", {});
      FL.toast("Renewed until " + FL.when(data.share.expires_at) + ".");
      loadShares(false);
    } catch (err) { FL.fail(err); }
  }

  async function remove(share) {
    if (!FL.confirm("Delete " + share.slug + " and all of its files?  The link stops working right away.")) return;
    try {
      await FL.api("DELETE", "/api/shares/" + encodeURIComponent(share.slug));
      FL.toast("Deleted " + share.slug + ".");
      loadShares(false);
      loadMe();
    } catch (err) { FL.fail(err); }
  }

  // New share
  function result(box, share, extra) {
    box.replaceChildren(h("div", { class: "notice ok" },
      h("strong", { text: "Ready.  " }), h("a", { href: share.url, target: "_blank", rel: "noopener", class: "mono", text: share.url }), " ",
      h("button", { type: "button", class: "small secondary", text: "Copy", onclick: function () { FL.copy(share.url); } }),
      extra ? h("div", { class: "small", text: extra }) : null));
  }

  function shareFields(form) {
    var f = FL.form(form);
    var body = { days: f.days };
    if (f.slug && f.slug.trim()) body.slug = f.slug.trim();
    if (f.password) body.password = f.password;
    if (f.title && f.title.trim()) body.title = f.title.trim();
    if (f.team_id) { body.team_id = f.team_id; body.team_access = f.team_access || "edit"; }
    return body;
  }

  async function uploadFiles(e) {
    e.preventDefault();
    var form = e.currentTarget, button = form.querySelector("button[type=submit]");
    var box = document.getElementById("new-files-result");
    var files = Array.prototype.slice.call(form.files.files);
    if (!files.length) { FL.toast("Choose at least one file.", "error"); return; }
    FL.busy(button, true);
    var share = null;
    try {
      share = (await FL.api("POST", "/api/shares", shareFields(form))).share;
      for (var i = 0; i < files.length; i++) {
        var file = files[i];
        var path = (file.webkitRelativePath || file.name).split("/").map(encodeURIComponent).join("/");
        box.replaceChildren(h("p", { class: "small muted", text: "Uploading " + (i + 1) + " of " + files.length + ": " + file.name }));
        var res = await fetch("/api/shares/" + encodeURIComponent(share.slug) + "/files/" + path, {
          method: "PUT", credentials: "same-origin", body: file,
          headers: { "Content-Type": file.type || "application/octet-stream", Accept: "application/json" }
        });
        if (!res.ok) {
          var err = await res.json().catch(function () { return {}; });
          throw new Error((err.error || "Upload failed.") + "  (" + file.name + ")");
        }
      }
      var detail = (await FL.api("GET", "/api/shares/" + encodeURIComponent(share.slug))).share;
      result(box, detail, detail.expires_at ? "Expires " + FL.when(detail.expires_at) + "." : "Never expires.");
      form.reset();
      daysOptions(form.days, "files");
      loadShares(false);
      loadMe();
    } catch (err) {
      if (share) await FL.api("DELETE", "/api/shares/" + encodeURIComponent(share.slug)).catch(function () {});
      box.replaceChildren();
      FL.fail(err);
    } finally {
      FL.busy(button, false);
    }
  }

  async function createLink(e) {
    e.preventDefault();
    var form = e.currentTarget, button = form.querySelector("button[type=submit]");
    var body = shareFields(form);
    body.url = form.url.value.trim();
    FL.busy(button, true);
    try {
      var share = (await FL.api("POST", "/api/links", body)).share;
      result(document.getElementById("new-link-result"), share, "Opens " + share.target_url);
      form.reset();
      daysOptions(form.days, "link");
      loadShares(false);
      loadMe();
    } catch (err) { FL.fail(err); } finally { FL.busy(button, false); }
  }

  // Tokens
  async function loadTokens() {
    var data = await FL.api("GET", "/api/tokens");
    var body = document.getElementById("token-rows");
    body.replaceChildren();
    data.tokens.forEach(function (t) {
      var limits = [];
      if (t.team_name) limits.push("Team " + t.team_name);
      if (t.max_file_bytes) limits.push(FL.bytes(t.max_file_bytes) + " files");
      if (t.max_ttl_seconds) limits.push(Math.round(t.max_ttl_seconds / 86400) + " days");
      if (!t.allow_links) limits.push("No links");
      body.append(h("tr", null,
        h("td", null, h("strong", { text: t.name }), h("div", { class: "small muted mono", text: t.prefix + "…" })),
        h("td", { class: "small", text: limits.join(", ") || "Your full limits" }),
        h("td", { class: "small hide-sm", text: t.last_used_at ? FL.relative(t.last_used_at) : "Never used" }),
        h("td", { class: "small", text: t.expires_at ? FL.when(t.expires_at) : "No expiry" }),
        h("td", null, h("button", { type: "button", class: "small danger", text: "Revoke", onclick: async function () {
          if (!FL.confirm("Revoke " + t.name + "?  Anything using it stops working.")) return;
          try { await FL.api("DELETE", "/api/tokens/" + encodeURIComponent(t.id)); FL.toast("Token revoked."); loadTokens(); } catch (err) { FL.fail(err); }
        } }))));
    });
    document.getElementById("token-empty").hidden = data.tokens.length > 0;
    document.getElementById("token-quota").textContent = data.tokens.length + " of " + data.quota + " tokens in use.";
  }

  async function createToken(e) {
    e.preventDefault();
    var form = e.currentTarget, f = FL.form(form), button = form.querySelector("button[type=submit]");
    var body = { name: f.name, allow_links: form.allow_links.checked };
    if (f.team_id) body.team_id = f.team_id;
    if (f.max_days) body.max_days = Number(f.max_days);
    if (f.max_file_mb) body.max_file_mb = Number(f.max_file_mb);
    if (f.expires_in_days) body.expires_in_days = Number(f.expires_in_days);
    FL.busy(button, true);
    try {
      var data = await FL.api("POST", "/api/tokens", body);
      document.getElementById("token-secret").replaceChildren(
        FL.secretBox("New token", data.token),
        h("p", { class: "small muted", text: "Copy it now.  FleetLink keeps only a hash, so it cannot be shown again." }));
      form.reset();
      form.allow_links.checked = true;
      loadTokens();
    } catch (err) { FL.fail(err); } finally { FL.busy(button, false); }
  }

  // Teams
  function teamCard(team) {
    var mine = team.my_role, manage = mine === "owner" || mine === "admin";
    var rows = team.members.map(function (m) {
      var self = state.me && m.user_id === state.me.user.id;
      var role = h("span", { class: "pill gray", text: m.role });
      if (mine === "owner" && !self) {
        role = h("select", { "aria-label": "Role for " + m.display_name, onchange: async function (e) {
          try { await FL.api("PATCH", "/api/teams/" + team.id + "/members/" + m.user_id, { role: e.target.value }); FL.toast("Role updated."); loadTeamsPanel(); } catch (err) { FL.fail(err); loadTeamsPanel(); }
        } }, ["owner", "admin", "member"].map(function (r) { return h("option", { value: r, text: r, selected: r === m.role }); }));
      }
      var canRemove = !self && (mine === "owner" || (mine === "admin" && m.role === "member"));
      return h("tr", null,
        h("td", null, m.display_name, self ? h("span", { class: "pill", text: "You" }) : null),
        h("td", { class: "small hide-sm", text: m.email || "" }),
        h("td", null, role),
        h("td", null, canRemove ? h("button", { type: "button", class: "small danger", text: "Remove", onclick: async function () {
          if (!FL.confirm("Remove " + m.display_name + " from " + team.name + "?")) return;
          try { await FL.api("DELETE", "/api/teams/" + team.id + "/members/" + m.user_id); loadTeamsPanel(); } catch (err) { FL.fail(err); }
        } }) : null));
    });
    var card = h("div", { class: "card" },
      h("div", { class: "actions split" },
        h("h3", { text: team.name }),
        h("span", null, h("span", { class: "pill", text: "You: " + mine }), h("span", { class: "pill gray", text: team.share_count + " live shares" }))),
      h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, h("th", { text: "Name" }), h("th", { class: "hide-sm", text: "Email" }), h("th", { text: "Role" }), h("th", { text: "" }))), h("tbody", null, rows))));
    if (manage) {
      var add = h("form", { class: "row", onsubmit: async function (e) {
        e.preventDefault();
        var f = FL.form(e.currentTarget);
        try { await FL.api("POST", "/api/teams/" + team.id + "/members", { email: f.email, role: f.role }); FL.toast("Added."); loadTeamsPanel(); } catch (err) { FL.fail(err); }
      } },
        h("div", null, h("label", { text: "Add by email" }), h("input", { type: "email", name: "email", required: true, placeholder: "person@example.com" })),
        h("div", null, h("label", { text: "Role" }), h("select", { name: "role" }, h("option", { value: "member", text: "Member" }), mine === "owner" ? h("option", { value: "admin", text: "Admin" }) : null)),
        h("div", { class: "end" }, h("button", { type: "submit", text: "Add Person" })));
      card.append(add);
    }
    var tools = h("div", { class: "actions mt" });
    if (manage) tools.append(h("button", { type: "button", class: "small secondary", text: "Rename", onclick: async function () {
      var name = window.prompt("New team name", team.name);
      if (!name) return;
      try { await FL.api("PATCH", "/api/teams/" + team.id, { name: name }); loadTeamsPanel(); } catch (err) { FL.fail(err); }
    } }));
    tools.append(h("button", { type: "button", class: "small secondary", text: "Leave", onclick: async function () {
      if (!FL.confirm("Leave " + team.name + "?  Your shares stay in the team.")) return;
      try { await FL.api("DELETE", "/api/teams/" + team.id + "/members/" + state.me.user.id); loadTeamsPanel(); } catch (err) { FL.fail(err); }
    } }));
    if (mine === "owner") tools.append(h("button", { type: "button", class: "small danger", text: "Delete Team", onclick: async function () {
      if (!FL.confirm("Delete " + team.name + "?  Its shares stay with their owners.")) return;
      try { await FL.api("DELETE", "/api/teams/" + team.id); loadTeamsPanel(); } catch (err) { FL.fail(err); }
    } }));
    card.append(tools);
    return card;
  }

  async function loadTeamsPanel() {
    await loadTeams();
    var host = document.getElementById("team-list");
    host.replaceChildren();
    if (!state.teams.length) host.append(h("p", { class: "empty", text: "You are not in a team yet.  Create one to share links with other people." }));
    state.teams.forEach(function (t) { host.append(teamCard(t)); });
  }

  async function createTeam(e) {
    e.preventDefault();
    var form = e.currentTarget;
    try { await FL.api("POST", "/api/teams", { name: form.name.value }); form.reset(); FL.toast("Team created."); loadTeamsPanel(); } catch (err) { FL.fail(err); }
  }

  // Account
  async function loadAccount() {
    var me = state.me || (await FL.api("GET", "/api/me"));
    var profile = document.getElementById("profile-form");
    profile.display_name.value = me.user.display_name;
    profile.email.value = me.user.email || "";
    var keys = (await FL.api("GET", "/api/me/passkeys")).passkeys;
    var kb = document.getElementById("passkey-rows");
    kb.replaceChildren();
    keys.forEach(function (k) {
      kb.append(h("tr", null,
        h("td", null, h("strong", { text: k.name }), k.backed_up ? h("span", { class: "pill green", text: "Synced" }) : null),
        h("td", { class: "small", text: FL.when(k.created_at) }),
        h("td", { class: "small hide-sm", text: k.last_used_at ? FL.relative(k.last_used_at) : "Not yet" }),
        h("td", null, h("div", { class: "actions" },
          h("button", { type: "button", class: "small secondary", text: "Rename", onclick: async function () {
            var name = window.prompt("Passkey name", k.name);
            if (!name) return;
            try { await FL.api("PATCH", "/api/me/passkeys/" + encodeURIComponent(k.id), { name: name }); loadAccount(); } catch (err) { FL.fail(err); }
          } }),
          keys.length > 1 ? h("button", { type: "button", class: "small danger", text: "Remove", onclick: async function () {
            if (!FL.confirm("Remove the passkey " + k.name + "?")) return;
            try { await FL.api("DELETE", "/api/me/passkeys/" + encodeURIComponent(k.id)); loadAccount(); } catch (err) { FL.fail(err); }
          } }) : null))));
    });
    var sessions = (await FL.api("GET", "/api/me/sessions")).sessions;
    var sb = document.getElementById("session-rows");
    sb.replaceChildren();
    sessions.forEach(function (s) {
      sb.append(h("tr", null,
        h("td", null, s.label || (s.client === "ios" ? "iPhone app" : "Browser"), s.current ? h("span", { class: "pill green", text: "This device" }) : null),
        h("td", { class: "small", text: FL.relative(s.last_seen_at) }),
        h("td", { class: "small hide-sm", text: FL.when(s.created_at) }),
        h("td", null, s.current ? null : h("button", { type: "button", class: "small danger", text: "Sign Out", onclick: async function () {
          try { await FL.api("DELETE", "/api/me/sessions/" + encodeURIComponent(s.id)); loadAccount(); } catch (err) { FL.fail(err); }
        } }))));
    });
  }

  async function saveProfile(e) {
    e.preventDefault();
    var f = FL.form(e.currentTarget);
    try {
      state.me = await FL.api("PATCH", "/api/me", { display_name: f.display_name, email: f.email || null });
      FL.toast("Saved.");
      loadMe();
    } catch (err) { FL.fail(err); }
  }

  async function addPasskey() {
    try {
      var started = await FL.api("POST", "/api/me/passkeys/options", {});
      var credential = await FL.passkeyCreate(started.options);
      await FL.api("POST", "/api/me/passkeys/verify", { challengeId: started.challengeId, credential: credential });
      FL.toast("Passkey added.");
      loadAccount();
    } catch (err) { FL.fail(err.name === "NotAllowedError" ? new Error("Passkey creation was cancelled.") : err); }
  }

  async function signOutOthers() {
    try { var data = await FL.api("DELETE", "/api/me/sessions"); FL.toast("Signed out " + data.revoked + " other session" + (data.revoked === 1 ? "" : "s") + "."); loadAccount(); } catch (err) { FL.fail(err); }
  }

  async function deleteAccount(e) {
    e.preventDefault();
    var value = e.currentTarget.confirm.value.trim().toLowerCase();
    if (value !== "delete my account") { FL.toast('Type "delete my account" to confirm.', "error"); return; }
    try { await FL.api("DELETE", "/api/me", { confirm: "delete my account" }); location.href = "/?deleted=1"; } catch (err) { FL.fail(err); }
  }

  // Wire up
  document.getElementById("share-scope").addEventListener("change", function () { loadShares(false).catch(FL.fail); });
  document.getElementById("share-search").addEventListener("submit", function (e) { e.preventDefault(); loadShares(false).catch(FL.fail); });
  document.getElementById("share-more").addEventListener("click", function () { loadShares(true).catch(FL.fail); });
  document.getElementById("new-files").addEventListener("submit", uploadFiles);
  document.getElementById("new-link").addEventListener("submit", createLink);
  document.getElementById("token-form").addEventListener("submit", createToken);
  document.getElementById("team-form").addEventListener("submit", createTeam);
  document.getElementById("profile-form").addEventListener("submit", saveProfile);
  document.getElementById("add-passkey").addEventListener("click", addPasskey);
  document.getElementById("signout-others").addEventListener("click", signOutOthers);
  document.getElementById("delete-form").addEventListener("submit", deleteAccount);
  daysOptions(document.getElementById("new-files").days, "files");
  daysOptions(document.getElementById("new-link").days, "link");

  // Bots under this account
  async function loadBots() {
    var data = await FL.api("GET", "/api/bots");
    var body = document.getElementById("bot-rows");
    body.replaceChildren();
    document.getElementById("bot-summary").textContent = data.bots.length + " bot" + (data.bots.length === 1 ? "" : "s") +
      (data.fleet_owner ? " under your account, including the whole fleet.  They are admins of your Fleet team." : " under your account.");
    data.bots.forEach(function (b) { body.append(botRow(b)); });
    document.getElementById("bot-empty").hidden = data.bots.length > 0;
  }

  function botRow(b) {
    var active = b.status === "active";
    var base = "/api/bots/" + encodeURIComponent(b.id);
    var actions = h("div", { class: "actions" });
    if (active) actions.append(h("button", { type: "button", class: "small secondary", text: "New Token", onclick: async function () {
      var name = window.prompt("Name this token (where the bot runs)", b.seat + " token");
      if (!name) return;
      try {
        var made = await FL.api("POST", base + "/tokens", { name: name });
        document.getElementById("bot-secret").replaceChildren(h("div", { class: "notice ok" },
          h("p", { class: "small", text: "Shown once.  It acts as " + b.display_name + "." }), FL.secretBox(b.seat + " token", made.token)));
        loadBots();
      } catch (err) { FL.fail(err); }
    } }));
    if (b.token_count) actions.append(h("button", { type: "button", class: "small secondary", text: "Revoke Tokens", onclick: async function () {
      if (!FL.confirm("Revoke every token " + b.display_name + " has?")) return;
      try {
        var list = await FL.api("GET", base + "/tokens");
        for (var i = 0; i < list.tokens.length; i++) await FL.api("DELETE", base + "/tokens/" + encodeURIComponent(list.tokens[i].id));
        FL.toast("Revoked.");
        loadBots();
      } catch (err) { FL.fail(err); }
    } }));
    actions.append(h("button", { type: "button", class: "small secondary", text: "Rename", onclick: async function () {
      var name = window.prompt("Display name", b.display_name);
      if (!name) return;
      try { await FL.api("PATCH", base, { display_name: name }); loadBots(); } catch (err) { FL.fail(err); }
    } }));
    actions.append(h("button", { type: "button", class: "small " + (active ? "danger" : "secondary"), text: active ? "Disable" : "Enable", onclick: async function () {
      if (active && !FL.confirm("Disable " + b.display_name + "?  It stops working everywhere until you enable it.")) return;
      try { await FL.api("PATCH", base, { status: active ? "disabled" : "active" }); loadBots(); } catch (err) { FL.fail(err); }
    } }));
    return h("tr", null,
      h("td", null, h("strong", { text: b.display_name }), h("div", { class: "small muted mono", text: b.seat })),
      h("td", { class: "hide-sm" }, b.usage.shares + " · " + FL.bytes(b.usage.bytes)),
      h("td", null, String(b.token_count), b.token_last_used_at ? h("div", { class: "small muted", text: "used " + FL.relative(b.token_last_used_at) }) : null),
      h("td", null, h("span", { class: "pill" + (active ? " green" : " red"), text: b.status })),
      h("td", null, actions));
  }

  async function addBot(e) {
    e.preventDefault();
    var form = e.currentTarget, f = FL.form(form);
    var body = { seat: f.seat };
    if (f.display_name && f.display_name.trim()) body.display_name = f.display_name.trim();
    try { await FL.api("POST", "/api/bots", body); form.reset(); FL.toast("Bot added."); loadBots(); } catch (err) { FL.fail(err); }
  }
  document.getElementById("bot-form").addEventListener("submit", addBot);

  var loaded = {};
  var show = FL.tabs(root, function (name) {
    if (loaded[name]) return;
    loaded[name] = true;
    if (name === "tokens") loadTokens().catch(FL.fail);
    if (name === "teams") loadTeamsPanel().catch(FL.fail);
    if (name === "bots") loadBots().catch(FL.fail);
    if (name === "account") loadAccount().catch(FL.fail);
  });
  loadMe().then(loadTeams).then(function () { return loadShares(false); }).catch(FL.fail);
  void show;
})();
`;
