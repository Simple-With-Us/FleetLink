/**
 * Shared browser helpers, served at /assets/app.js.  Plain ES2017, no build
 * step.  Text from the server is only ever set with textContent.
 */
export const APP_JS = String.raw`
(function () {
  "use strict";
  var FL = window.FL = {};

  // Logo animations play once.  With reduced motion they stay on their poster, the final frame.
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.querySelectorAll("video[data-intro]").forEach(function (v) { v.removeAttribute("autoplay"); v.pause(); });
  }

  FL.h = function (tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value == null || value === false) return;
        if (key === "text") el.textContent = String(value);
        else if (key === "class") el.className = value;
        else if (key === "style") el.style.cssText = value;
        else if (key.indexOf("on") === 0) el.addEventListener(key.slice(2), value);
        else el.setAttribute(key, value === true ? "" : String(value));
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child == null || child === false) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) el.append(c); });
      else el.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return el;
  };

  FL.api = async function (method, path, body) {
    var init = { method: method, credentials: "same-origin", headers: { Accept: "application/json" } };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    var res = await fetch(path, init);
    var data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    if (res.status === 401 && path.indexOf("/api/auth/") !== 0) {
      window.location.href = "/login?next=" + encodeURIComponent(location.pathname + location.hash);
      throw new Error("Sign in again.");
    }
    if (!res.ok) throw new Error(data.error || ("Request failed (" + res.status + ")."));
    return data;
  };

  FL.toast = function (message, kind) {
    var host = document.getElementById("toast");
    if (!host) {
      host = FL.h("div", { id: "toast", role: "status", "aria-live": "polite" });
      document.body.append(host);
    }
    host.replaceChildren(FL.h("div", { class: "notice " + (kind || "ok"), text: message }));
    clearTimeout(FL._toastTimer);
    FL._toastTimer = setTimeout(function () { host.replaceChildren(); }, kind === "error" ? 7000 : 3500);
  };

  FL.fail = function (err) { FL.toast(err && err.message ? err.message : String(err), "error"); };

  FL.bytes = function (n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    var units = ["KB", "MB", "GB", "TB"];
    var v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (v >= 10 ? Math.round(v) : v.toFixed(1)) + " " + units[i];
  };

  FL.when = function (iso) {
    if (!iso) return "Never";
    var d = new Date(iso);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  };

  FL.relative = function (iso) {
    if (!iso) return "never";
    var diff = (new Date(iso).getTime() - Date.now()) / 1000;
    var abs = Math.abs(diff);
    var unit = abs < 3600 ? [Math.round(abs / 60), "minute"] : abs < 86400 ? [Math.round(abs / 3600), "hour"] : [Math.round(abs / 86400), "day"];
    var label = unit[0] + " " + unit[1] + (unit[0] === 1 ? "" : "s");
    return diff >= 0 ? "in " + label : label + " ago";
  };

  FL.copy = async function (value, label) {
    try {
      await navigator.clipboard.writeText(value);
      FL.toast((label || "Link") + " copied.");
    } catch (e) {
      window.prompt("Copy this:", value);
    }
  };

  FL.confirm = function (message) { return window.confirm(message); };

  FL.form = function (form) {
    var out = {};
    new FormData(form).forEach(function (value, key) { if (typeof value === "string") out[key] = value; });
    return out;
  };

  FL.busy = function (button, on) {
    if (!button) return;
    button.disabled = on;
    if (on) { button.dataset.label = button.textContent; button.textContent = "Working…"; }
    else if (button.dataset.label) button.textContent = button.dataset.label;
  };

  FL.secretBox = function (label, value) {
    return FL.h("div", { class: "secret", role: "status" },
      FL.h("strong", { text: label }),
      FL.h("code", { text: value }),
      FL.h("button", { type: "button", class: "small secondary", text: "Copy", onclick: function () { FL.copy(value, label); } }));
  };

  // WebAuthn JSON helpers for the passkey ceremonies.
  function fromB64url(s) {
    var pad = "=".repeat((4 - (s.length % 4)) % 4);
    var bin = atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + pad);
    var buf = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  }
  function toB64url(buf) {
    var bytes = new Uint8Array(buf), s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  FL.passkeyCreate = async function (options) {
    var pk = Object.assign({}, options);
    pk.challenge = fromB64url(pk.challenge);
    pk.user = Object.assign({}, pk.user, { id: fromB64url(pk.user.id) });
    if (pk.excludeCredentials) pk.excludeCredentials = pk.excludeCredentials.map(function (c) { return Object.assign({}, c, { id: fromB64url(c.id) }); });
    var cred = await navigator.credentials.create({ publicKey: pk });
    var r = cred.response;
    return {
      id: cred.id, rawId: toB64url(cred.rawId), type: cred.type,
      response: { clientDataJSON: toB64url(r.clientDataJSON), attestationObject: toB64url(r.attestationObject), transports: r.getTransports ? r.getTransports() : [] },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {}
    };
  };
  FL.passkeyGet = async function (options) {
    var pk = Object.assign({}, options);
    pk.challenge = fromB64url(pk.challenge);
    if (pk.allowCredentials) pk.allowCredentials = pk.allowCredentials.map(function (c) { return Object.assign({}, c, { id: fromB64url(c.id) }); });
    var cred = await navigator.credentials.get({ publicKey: pk });
    var r = cred.response;
    return {
      id: cred.id, rawId: toB64url(cred.rawId), type: cred.type,
      response: {
        clientDataJSON: toB64url(r.clientDataJSON), authenticatorData: toB64url(r.authenticatorData),
        signature: toB64url(r.signature), userHandle: r.userHandle ? toB64url(r.userHandle) : undefined
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {}
    };
  };
  FL.passkeysSupported = function () { return !!(window.PublicKeyCredential && navigator.credentials); };

  FL.tabs = function (root, onShow) {
    var buttons = Array.prototype.slice.call(root.querySelectorAll("[role=tab]"));
    function show(name, push) {
      buttons.forEach(function (b) {
        var on = b.dataset.tab === name;
        b.setAttribute("aria-selected", on ? "true" : "false");
        var panel = document.getElementById("panel-" + b.dataset.tab);
        if (panel) panel.hidden = !on;
      });
      if (push) history.replaceState(null, "", "#" + name);
      if (onShow) onShow(name);
    }
    buttons.forEach(function (b) { b.addEventListener("click", function () { show(b.dataset.tab, true); }); });
    var initial = location.hash.slice(1);
    show(buttons.some(function (b) { return b.dataset.tab === initial; }) ? initial : buttons[0].dataset.tab, false);
    return show;
  };
})();
`;
