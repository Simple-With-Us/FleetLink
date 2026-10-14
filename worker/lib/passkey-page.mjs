/** Passkey block inserted above the existing operator-secret form on /login. */

export function passkeyLoginMarkup() {
  return `<section id="passkey-panel">
    <h1>Sign In With A Passkey</h1>
    <p>FleetLink accounts use a passkey.  No password is stored.  Create one on this device, or sign in with a passkey you already have.</p>
    <div id="passkey-msg" class="msg-box" hidden></div>
    <div class="form-group">
      <label for="passkey-name">Display Name</label>
      <input type="text" id="passkey-name" maxlength="64" autocomplete="name" placeholder="Ada Lovelace">
    </div>
    <div class="form-group">
      <label for="passkey-email">Email (optional)</label>
      <input type="text" id="passkey-email" maxlength="254" autocomplete="username" placeholder="ada@example.com">
    </div>
    <button type="button" id="passkey-register">Create A Passkey</button>
    <button type="button" id="passkey-login" style="margin-top:0.6rem;background:#0f172a">Sign In With A Passkey</button>
    <p class="hint">After sign-in you land on the <a href="/dashboard">dashboard</a>.</p>
  </section>
  <details style="margin:1.25rem 0">
    <summary>Operator secret (admin and agent portal)</summary>
    <p class="hint">Account passwords and OAuth are not part of this build.  The form below is the existing operator secret for the portal.</p>`;
}

export function passkeyLoginScript() {
  return `<script>
(function () {
  var msg = document.getElementById("passkey-msg");
  function show(text, bad) {
    msg.hidden = false;
    msg.textContent = text;
    msg.className = "msg-box " + (bad ? "error-box" : "success-box");
  }
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
    var name = document.getElementById("passkey-name").value.trim();
    var email = document.getElementById("passkey-email").value.trim();
    if (!name) { show("Enter a display name to create a passkey.", true); return; }
    var started = await post("/api/auth/passkey/register/options", { displayName: name, email: email });
    var cred = await navigator.credentials.create({ publicKey: prep(started.options, "create") });
    await post("/api/auth/passkey/register/verify", { challengeId: started.challengeId, credential: credToJSON(cred) });
    window.location.href = "/dashboard";
  }
  async function login() {
    var email = document.getElementById("passkey-email").value.trim();
    var started = await post("/api/auth/passkey/authenticate/options", email ? { email: email } : {});
    var cred = await navigator.credentials.get({ publicKey: prep(started.options, "get") });
    await post("/api/auth/passkey/authenticate/verify", { challengeId: started.challengeId, credential: credToJSON(cred) });
    window.location.href = "/dashboard";
  }
  document.getElementById("passkey-register").onclick = function () {
    register().catch(function (err) { show(err.message || "Passkey creation failed.", true); });
  };
  document.getElementById("passkey-login").onclick = function () {
    login().catch(function (err) { show(err.message || "Passkey sign-in failed.", true); });
  };
})();
</script>`;
}
