/** The admin console, served at /assets/admin.js. */
export const ADMIN_JS = String.raw`
(function () {
  "use strict";
  var FL = window.FL, h = FL.h;
  var root = document.getElementById("admin");
  if (!root) return;
  var selfId = root.dataset.user;
  var GB = 1024 * 1024 * 1024;

  function stat(label, value) { return h("div", { class: "stat" }, h("b", { text: value }), h("span", { class: "small muted", text: label })); }

  async function loadStats() {
    var s = await FL.api("GET", "/api/admin/stats");
    var active = 0, disabled = 0, admins = 0;
    s.users.forEach(function (row) {
      if (row.status === "active") active += row.n;
      if (row.status === "disabled") disabled += row.n;
      if (row.role === "admin" && row.status === "active") admins += row.n;
    });
    document.getElementById("stats").replaceChildren(
      stat("Active people", String(active)),
      stat("Admins", String(admins)),
      stat("Disabled", String(disabled)),
      stat("Live shares", String(s.shares.count)),
      stat("Stored", FL.bytes(s.shares.bytes)),
      stat("Teams", String(s.teams)),
      stat("Open invites", String(s.active_invites)),
      stat("Sign-up", s.settings.signup_mode));
  }

  // People
  async function patchUser(user, body, done) {
    try { await FL.api("PATCH", "/api/admin/users/" + encodeURIComponent(user.id), body); FL.toast(done); loadUsers(); loadStats(); } catch (err) { FL.fail(err); }
  }

  function quotaLabel(user) {
    if (user.role === "admin") return "Unlimited";
    var q = user.effective.storage_bytes;
    return FL.bytes(user.usage.bytes) + " of " + FL.bytes(q) + (user.storage_quota_bytes == null ? "" : " (custom)");
  }

  function userRow(user) {
    var badges = [h("span", { class: "pill" + (user.role === "admin" ? "" : " gray"), text: user.role })];
    if (user.status === "disabled") badges.push(h("span", { class: "pill red", text: "disabled" }));
    if (user.is_system) badges.push(h("span", { class: "pill amber", text: "system" }));
    var actions = h("div", { class: "actions" });
    if (!user.is_system && user.id !== selfId) {
      actions.append(h("button", { type: "button", class: "small secondary", text: user.role === "admin" ? "Make User" : "Make Admin", onclick: function () {
        var role = user.role === "admin" ? "user" : "admin";
        if (FL.confirm("Change " + user.display_name + " to " + role + "?  They will be signed out.")) patchUser(user, { role: role }, "Role changed.");
      } }));
      actions.append(h("button", { type: "button", class: "small secondary", text: user.status === "active" ? "Disable" : "Enable", onclick: function () {
        var status = user.status === "active" ? "disabled" : "active";
        if (FL.confirm((status === "disabled" ? "Disable " : "Enable ") + user.display_name + "?" + (status === "disabled" ? "  Their links stop working and they are signed out." : ""))) patchUser(user, { status: status }, status === "disabled" ? "Disabled." : "Enabled.");
      } }));
    }
    if (!user.is_system) {
      actions.append(h("button", { type: "button", class: "small secondary", text: "Quota", onclick: function () {
        var current = user.storage_quota_bytes == null ? "" : String(Math.round((user.storage_quota_bytes / GB) * 100) / 100);
        var value = window.prompt("Storage quota in GB for " + user.display_name + ".  Leave empty for the default.", current);
        if (value === null) return;
        var body = { storage_quota_bytes: value.trim() === "" ? null : Math.round(Number(value) * GB) };
        if (body.storage_quota_bytes !== null && !(body.storage_quota_bytes >= 0)) { FL.toast("Enter a number of GB.", "error"); return; }
        var tokens = window.prompt("API token quota.  Leave empty for the default.", user.token_quota == null ? "" : String(user.token_quota));
        if (tokens !== null) body.token_quota = tokens.trim() === "" ? null : Number(tokens);
        patchUser(user, body, "Quota saved.");
      } }));
    }
    if (!user.is_system && user.id !== selfId) {
      actions.append(h("button", { type: "button", class: "small danger", text: "Delete", onclick: async function () {
        if (!FL.confirm("Delete " + user.display_name + "?  Their passkeys, tokens, and sessions go now.  Their shares are removed within the hour.")) return;
        try { await FL.api("DELETE", "/api/admin/users/" + encodeURIComponent(user.id)); FL.toast("Account deleted."); loadUsers(); loadStats(); } catch (err) { FL.fail(err); }
      } }));
    }
    return h("tr", null,
      h("td", null, h("strong", { text: user.display_name }), h("div", { class: "small muted", text: user.email || user.id })),
      h("td", null, badges),
      h("td", { class: "small" }, user.usage.shares + " shares", h("div", { class: "muted", text: quotaLabel(user) })),
      h("td", { class: "small hide-sm" }, user.passkey_count + " passkeys, " + user.token_count + " tokens"),
      h("td", { class: "small hide-sm", text: user.last_seen_at ? FL.relative(user.last_seen_at) : "Never" }),
      h("td", null, actions));
  }

  async function loadUsers() {
    var q = document.getElementById("user-q").value.trim();
    var data = await FL.api("GET", "/api/admin/users" + (q ? "?q=" + encodeURIComponent(q) : ""));
    document.getElementById("user-rows").replaceChildren.apply(document.getElementById("user-rows"), data.users.map(userRow));
  }

  // Invites
  async function loadInvites() {
    var data = await FL.api("GET", "/api/admin/invites");
    var body = document.getElementById("invite-rows");
    body.replaceChildren();
    data.invites.forEach(function (inv) {
      var cls = inv.state === "active" ? "green" : "gray";
      body.append(h("tr", null,
        h("td", null, h("span", { class: "mono", text: inv.prefix + "-…" }), inv.note ? h("div", { class: "small muted", text: inv.note }) : null),
        h("td", null, h("span", { class: "pill " + cls, text: inv.state }), h("span", { class: "pill gray", text: inv.role }), inv.team_name ? h("span", { class: "pill", text: inv.team_name }) : null),
        h("td", { class: "small", text: inv.uses + " of " + inv.max_uses }),
        h("td", { class: "small hide-sm", text: FL.when(inv.expires_at) }),
        h("td", null, inv.state === "active" ? h("button", { type: "button", class: "small danger", text: "Revoke", onclick: async function () {
          try { await FL.api("DELETE", "/api/admin/invites/" + encodeURIComponent(inv.id)); loadInvites(); } catch (err) { FL.fail(err); }
        } }) : null)));
    });
    document.getElementById("invite-empty").hidden = data.invites.length > 0;
  }

  async function createInvite(e) {
    e.preventDefault();
    var form = e.currentTarget, f = FL.form(form);
    var body = { role: f.role, max_uses: Number(f.max_uses || 1), expires_in_days: Number(f.expires_in_days || 14) };
    if (f.note) body.note = f.note;
    try {
      var data = await FL.api("POST", "/api/admin/invites", body);
      var link = location.origin + "/login?invite=" + encodeURIComponent(data.code);
      document.getElementById("invite-secret").replaceChildren(
        FL.secretBox("Invite code", data.code),
        FL.secretBox("Sign-up link", link),
        h("p", { class: "small muted", text: "Send one of these to the person.  The code is not shown again." }));
      form.reset();
      loadInvites();
      loadStats();
    } catch (err) { FL.fail(err); }
  }

  // Shares
  async function loadShares() {
    var q = document.getElementById("share-q").value.trim();
    var data = await FL.api("GET", "/api/shares?scope=all&limit=100" + (q ? "&q=" + encodeURIComponent(q) : ""));
    var body = document.getElementById("share-rows");
    body.replaceChildren();
    data.shares.forEach(function (s) {
      body.append(h("tr", null,
        h("td", null, h("a", { href: s.url, target: "_blank", rel: "noopener", class: "mono", text: s.slug }), s.title ? h("div", { class: "small muted", text: s.title }) : null),
        h("td", { class: "small", text: s.owner.display_name || s.owner.id }),
        h("td", { class: "small" }, s.kind === "link" ? "Link" : s.file_count + " files, " + FL.bytes(s.total_bytes), s.source === "legacy" ? h("span", { class: "pill amber", text: "adopted" }) : null),
        h("td", { class: "small", text: s.expires_at ? FL.relative(s.expires_at) : "Never" }),
        h("td", null, h("button", { type: "button", class: "small danger", text: "Delete", onclick: async function () {
          if (!FL.confirm("Delete " + s.slug + " (owned by " + (s.owner.display_name || s.owner.id) + ")?")) return;
          try { await FL.api("DELETE", "/api/shares/" + encodeURIComponent(s.slug)); FL.toast("Deleted."); loadShares(); loadStats(); } catch (err) { FL.fail(err); }
        } }))));
    });
    document.getElementById("share-empty").hidden = data.shares.length > 0;
  }

  // Settings
  async function loadSettings() {
    var data = await FL.api("GET", "/api/admin/settings");
    var form = document.getElementById("settings-form");
    var host = document.getElementById("settings-fields");
    host.replaceChildren();
    data.fields.forEach(function (field) {
      var id = "setting-" + field.key;
      var input;
      if (field.key === "signup_mode") {
        input = h("select", { id: id, name: field.key }, ["open", "invite", "closed"].map(function (v) { return h("option", { value: v, text: v, selected: field.value === v }); }));
      } else {
        var value = Array.isArray(field.value) ? field.value.join(", ") : String(field.value);
        input = h("input", { id: id, name: field.key, type: "text", value: value });
      }
      host.append(h("div", null,
        h("label", { for: id, text: field.label }),
        input,
        h("p", { class: "small muted", text: field.description + "  Source: " + field.source + "." })));
    });
    form.dataset.loaded = "1";
  }

  async function saveSettings(e) {
    e.preventDefault();
    var f = FL.form(e.currentTarget), values = {};
    Object.keys(f).forEach(function (k) {
      var v = f[k].trim();
      values[k] = /_bytes$|_quota$/.test(k) ? Number(v) : v;
    });
    try { await FL.api("PUT", "/api/admin/settings", { values: values }); FL.toast("Settings saved."); loadSettings(); loadStats(); } catch (err) { FL.fail(err); }
  }

  // Audit
  async function loadAudit() {
    var data = await FL.api("GET", "/api/admin/audit?limit=100");
    var body = document.getElementById("audit-rows");
    body.replaceChildren();
    data.events.forEach(function (ev) {
      body.append(h("tr", null,
        h("td", { class: "small", text: FL.when(ev.created_at) }),
        h("td", { class: "small", text: ev.actor_name || ev.actor_id || "system" }),
        h("td", { class: "small mono", text: ev.action }),
        h("td", { class: "small mono hide-sm", text: [ev.target, ev.detail ? JSON.stringify(ev.detail) : ""].filter(Boolean).join(" ") })));
    });
  }

  document.getElementById("user-search").addEventListener("submit", function (e) { e.preventDefault(); loadUsers().catch(FL.fail); });
  document.getElementById("invite-form").addEventListener("submit", createInvite);
  document.getElementById("share-search").addEventListener("submit", function (e) { e.preventDefault(); loadShares().catch(FL.fail); });
  document.getElementById("settings-form").addEventListener("submit", saveSettings);
  document.getElementById("run-sweep").addEventListener("click", async function () {
    try { var data = await FL.api("POST", "/api/admin/sweep", {}); FL.toast("Sweep finished: " + JSON.stringify(data.report)); loadStats(); } catch (err) { FL.fail(err); }
  });

  var loaded = {};
  FL.tabs(root, function (name) {
    if (loaded[name]) return;
    loaded[name] = true;
    var loaders = { people: loadUsers, invites: loadInvites, shares: loadShares, settings: loadSettings, audit: loadAudit };
    if (loaders[name]) loaders[name]().catch(FL.fail);
  });
  loadStats().catch(FL.fail);
})();
`;
