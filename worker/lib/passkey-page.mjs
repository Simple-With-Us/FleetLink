/** Passkey block inserted above the existing operator-secret form on /login and /signup. */

export function passkeyLoginMarkup(mode = "signin") {
  const isRegister = mode === "register";
  return `<section id="passkey-panel">
    <div role="tablist" style="display:flex;gap:0.5rem;margin-bottom:1.25rem;border-bottom:1px solid #e2e8f0;padding-bottom:0.75rem;">
      <button type="button" id="tab-passkey-signin" role="tab" aria-selected="${isRegister ? "false" : "true"}" class="tab-btn" style="flex:1;padding:0.6rem 0.75rem;font-size:0.92rem;font-weight:700;border:1px solid ${isRegister ? "#cbd5e1" : "#2563eb"};background:${isRegister ? "#ffffff" : "#2563eb"};color:${isRegister ? "#334155" : "#ffffff"};border-radius:6px;cursor:pointer;">Sign In</button>
      <button type="button" id="tab-passkey-register" role="tab" aria-selected="${isRegister ? "true" : "false"}" class="tab-btn" style="flex:1;padding:0.6rem 0.75rem;font-size:0.92rem;font-weight:700;border:1px solid ${isRegister ? "#2563eb" : "#cbd5e1"};background:${isRegister ? "#2563eb" : "#ffffff"};color:${isRegister ? "#ffffff" : "#334155"};border-radius:6px;cursor:pointer;">Create Account</button>
    </div>

    <div id="passkey-msg" class="msg-box" hidden></div>

    <div id="panel-signin" style="display:${isRegister ? "none" : "block"};">
      <h1 style="font-size:1.35rem;margin:0 0 0.4rem 0;">Sign In With A Passkey</h1>
      <p style="margin:0 0 1rem 0;font-size:0.88rem;color:#64748b;line-height:1.5;">Use Touch ID, Face ID, or your device security key.&nbsp; No passwords to type or remember.</p>
      <div class="form-group">
        <label for="signin-email">Email (optional)</label>
        <input type="text" id="signin-email" maxlength="254" autocomplete="username webauthn" placeholder="ada@example.com">
        <div class="hint" style="font-size:0.8rem;color:#64748b;margin-top:0.25rem;">Leave blank to pick from passkeys saved on this device.</div>
      </div>
      <button type="button" id="passkey-login" style="margin-top:0.5rem;background:#2563eb;">Sign In With Passkey</button>
    </div>

    <div id="panel-register" style="display:${isRegister ? "block" : "none"};">
      <h1 style="font-size:1.35rem;margin:0 0 0.4rem 0;">Create Your Account</h1>
      <p style="margin:0 0 1rem 0;font-size:0.88rem;color:#64748b;line-height:1.5;">FleetLink accounts use modern passkeys.&nbsp; A cryptographic key pair is created on this device.&nbsp; No password is stored or transmitted.</p>
      <div class="form-group">
        <label for="passkey-name">Display Name <span style="color:#ef4444;">*</span></label>
        <input type="text" id="passkey-name" maxlength="64" autocomplete="name" placeholder="Ada Lovelace">
      </div>
      <div class="form-group">
        <label for="passkey-email">Email (optional)</label>
        <input type="text" id="passkey-email" maxlength="254" autocomplete="username" placeholder="ada@example.com">
      </div>
      <button type="button" id="passkey-register" style="margin-top:0.5rem;background:#2563eb;">Create Account With Passkey</button>
    </div>

    <p class="hint" style="margin-top:1.1rem;font-size:0.85rem;text-align:center;color:#475569;">After authentication you will land on the <a href="/dashboard" style="color:#2563eb;font-weight:600;">dashboard</a>.</p>
  </section>
  <details style="margin:1.25rem 0;padding:0.75rem 1rem;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
    <summary style="font-size:0.88rem;font-weight:600;color:#475569;cursor:pointer;">Operator secret (admin &amp; agent portal)</summary>
    <p class="hint" style="margin-top:0.5rem;font-size:0.82rem;color:#64748b;">The form below accepts an operator secret or automation code.</p>`;
}

export function passkeyLoginScript() {
  return `<script>
(function () {
  var msg = document.getElementById("passkey-msg");
  function show(text, bad) {
    if (!msg) return;
    msg.hidden = false;
    msg.textContent = text;
    msg.className = "msg-box " + (bad ? "error-box" : "success-box");
  }

  var tabSignin = document.getElementById("tab-passkey-signin");
  var tabRegister = document.getElementById("tab-passkey-register");
  var panelSignin = document.getElementById("panel-signin");
  var panelRegister = document.getElementById("panel-register");

  function switchTab(mode) {
    var isReg = mode === "register";
    if (tabSignin) {
      tabSignin.setAttribute("aria-selected", isReg ? "false" : "true");
      tabSignin.style.background = isReg ? "#ffffff" : "#2563eb";
      tabSignin.style.color = isReg ? "#334155" : "#ffffff";
      tabSignin.style.borderColor = isReg ? "#cbd5e1" : "#2563eb";
    }
    if (tabRegister) {
      tabRegister.setAttribute("aria-selected", isReg ? "true" : "false");
      tabRegister.style.background = isReg ? "#2563eb" : "#ffffff";
      tabRegister.style.color = isReg ? "#ffffff" : "#334155";
      tabRegister.style.borderColor = isReg ? "#2563eb" : "#cbd5e1";
    }
    if (panelSignin) panelSignin.style.display = isReg ? "none" : "block";
    if (panelRegister) panelRegister.style.display = isReg ? "block" : "none";
    if (msg) msg.hidden = true;
  }

  if (tabSignin) tabSignin.onclick = function() { switchTab("signin"); };
  if (tabRegister) tabRegister.onclick = function() { switchTab("register"); };

  function b64urlToBuf(s) {
    var pad = "=".repeat((4 - (s.length % 4)) % 4);
    var bin = atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + pad);
    var buf = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  }
  function bufToB64url(buf) {
    var bytes = new Uint8Array(buf);
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  }
  function prep(publicKey, kind) {
    publicKey.challenge = b64urlToBuf(publicKey.challenge);
    if (kind === "create" && publicKey.user) publicKey.user.id = b64urlToBuf(publicKey.user.id);
    var list = kind === "create" ? publicKey.excludeCredentials : publicKey.allowCredentials;
    if (list) list.forEach(function (c) { c.id = b64urlToBuf(c.id); });
    return publicKey;
  }
  function credToJSON(cred) {
    var r = cred.response;
    var out = { id: cred.id, rawId: bufToB64url(cred.rawId), type: cred.type, response: {} };
    if (r.attestationObject) {
      out.response.attestationObject = bufToB64url(r.attestationObject);
      out.response.clientDataJSON = bufToB64url(r.clientDataJSON);
      if (r.getTransports) out.response.transports = r.getTransports();
    } else {
      out.response.clientDataJSON = bufToB64url(r.clientDataJSON);
      out.response.authenticatorData = bufToB64url(r.authenticatorData);
      out.response.signature = bufToB64url(r.signature);
      if (r.userHandle) out.response.userHandle = bufToB64url(r.userHandle);
    }
    return out;
  }
  async function post(url, body) {
    var res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body)
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }
  async function register() {
    var nameInput = document.getElementById("passkey-name");
    var emailInput = document.getElementById("passkey-email");
    var name = nameInput ? nameInput.value.trim() : "";
    var email = emailInput ? emailInput.value.trim() : "";
    if (!name) { show("Enter a display name to create your account.", true); if (nameInput) nameInput.focus(); return; }
    var btn = document.getElementById("passkey-register");
    if (btn) { btn.disabled = true; btn.textContent = "Creating passkey…"; }
    try {
      var started = await post("/api/auth/passkey/register/options", { displayName: name, email: email });
      var cred = await navigator.credentials.create({ publicKey: prep(started.options, "create") });
      await post("/api/auth/passkey/register/verify", { challengeId: started.challengeId, credential: credToJSON(cred) });
      show("Account created successfully! Redirecting…", false);
      window.location.href = "/dashboard";
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = "Create Account With Passkey"; }
      throw err;
    }
  }
  async function login() {
    var emailInput = document.getElementById("signin-email");
    var email = emailInput ? emailInput.value.trim() : "";
    var btn = document.getElementById("passkey-login");
    if (btn) { btn.disabled = true; btn.textContent = "Signing in…"; }
    try {
      var started = await post("/api/auth/passkey/authenticate/options", email ? { email: email } : {});
      var cred = await navigator.credentials.get({ publicKey: prep(started.options, "get") });
      await post("/api/auth/passkey/authenticate/verify", { challengeId: started.challengeId, credential: credToJSON(cred) });
      show("Signed in! Redirecting…", false);
      window.location.href = "/dashboard";
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = "Sign In With Passkey"; }
      throw err;
    }
  }
  var regBtn = document.getElementById("passkey-register");
  if (regBtn) {
    regBtn.onclick = function () {
      register().catch(function (err) { show(err.message || "Passkey creation failed.", true); });
    };
  }
  var logBtn = document.getElementById("passkey-login");
  if (logBtn) {
    logBtn.onclick = function () {
      login().catch(function (err) { show(err.message || "Passkey sign-in failed.", true); });
    };
  }
})();
</script>`;
}

function escapeHtml(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderLoginHtml(origin, errorMsg, isLoggedOut, mode = "login") {
  const isRegister = mode === "register";
  return `<!DOCTYPE html><html lang="en"><head>
  <title>${isRegister ? "Create Account" : "Sign In"} &bull; FleetLink</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Sign in or register for a FleetLink account.">
  <style>
    :root {
      --bg: #ffffff;
      --card-bg: #f8fafc;
      --border: #e2e8f0;
      --text: #0f172a;
      --text-muted: #64748b;
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
    }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 1.5rem; box-sizing: border-box; }
    .card { background: #ffffff; border: 1px solid var(--border); border-radius: 12px; padding: 2.25rem; max-width: 440px; width: 100%; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.06); }
    h1 { margin: 0 0 0.5rem 0; font-size: 1.5rem; color: #0f172a; letter-spacing: -0.02em; }
    p { margin: 0 0 1.25rem 0; font-size: 0.9rem; color: var(--text-muted); line-height: 1.5; }
    .form-group { margin-bottom: 1.15rem; }
    label { display: block; font-weight: 600; font-size: 0.88rem; color: #334155; margin-bottom: 0.35rem; }
    input[type="text"], input[type="password"] { width: 100%; box-sizing: border-box; padding: 0.7rem 0.85rem; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 0.95rem; outline: none; transition: border-color 0.15s; }
    input[type="text"]:focus, input[type="password"]:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(37,99,235,0.12); }
    .checkbox-wrap { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1.25rem; font-size: 0.88rem; color: #475569; }
    .checkbox-wrap input { width: 16px; height: 16px; accent-color: var(--primary); cursor: pointer; }
    button { width: 100%; background: var(--primary); color: white; border: none; border-radius: 8px; padding: 0.75rem; font-size: 0.98rem; font-weight: 600; cursor: pointer; transition: background 0.15s; }
    button:hover { background: var(--primary-hover); }
    .msg-box { padding: 0.75rem 0.95rem; border-radius: 6px; font-size: 0.88rem; margin-bottom: 1.25rem; line-height: 1.4; }
    .error-box { background: #fee2e2; border: 1px solid #fca5a5; color: #b91c1c; }
    .success-box { background: #dcfce7; border: 1px solid #86efac; color: #15803d; }
    .nav-links { display: flex; justify-content: space-between; margin-top: 1.5rem; padding-top: 1.25rem; border-top: 1px solid var(--border); font-size: 0.85rem; }
    .nav-links a { color: var(--primary); text-decoration: none; }
    .nav-links a:hover { text-decoration: underline; }
    .hint { font-size: 0.85rem; color: #334155; margin-top: 0.25rem; }
    :focus-visible { outline: 3px solid #1d4ed8; outline-offset: 2px; }
    button, .nav-links a { min-height: 44px; }
  </style></head><body>
  <div class="card">
    <div style="display: flex; align-items: center; gap: 0.6rem; margin-bottom: 1rem;">
      <div style="font-size: 1.75rem;">\u26A1</div>
      <div style="font-weight: 800; font-size: 1.2rem; color: #0f172a;">Fleet<span style="color:var(--primary);">Link</span></div>
    </div>
    ${isLoggedOut ? `<div class="msg-box success-box" role="status">You are signed out.</div>` : ""}
    ${errorMsg ? `<div class="msg-box error-box"><strong>Error:</strong> ${escapeHtml(errorMsg)}</div>` : ""}
    ${passkeyLoginMarkup(mode === "register" ? "register" : "signin")}
    <form method="POST" action="/login" id="login-form">
      <div class="form-group">
        <label for="username">Name, email, or sign-in code</label>
        <input type="text" id="username" name="username" placeholder="Name, email, or sign-in code" autocomplete="username">
      </div>
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" placeholder="Password, if you have one" autocomplete="current-password">
        <div class="hint">A sign-in code can go in either box.&nbsp; The password can stay empty when you use a code.</div>
      </div>
      <div class="checkbox-wrap">
        <input type="checkbox" id="remember" name="remember" value="true" checked>
        <label for="remember" style="margin:0;font-weight:normal;cursor:pointer;">Keep me signed in (30 days)</label>
      </div>
      <button type="submit" id="btn-login-submit">Sign in with operator secret</button>
    </form>
    </details>
    ${passkeyLoginScript()}
    <div class="nav-links">
      <a href="/dashboard">Dashboard</a>
      <a href="/">&larr; FleetLink Home</a>
      <a href="/portal">Your links</a>
      <a href="/privacy">Privacy Policy</a>
    </div>
  </div>
</body></html>`;
}
