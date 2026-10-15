/** Sign-in and sign-up with a passkey, served at /assets/login.js. */
export const LOGIN_JS = String.raw`
(function () {
  "use strict";
  var FL = window.FL;
  var root = document.getElementById("auth");
  if (!root) return;
  var msg = document.getElementById("auth-msg");
  var next = new URLSearchParams(location.search).get("next");
  var target = next && next.charAt(0) === "/" && next.charAt(1) !== "/" ? next : "/dashboard";

  function say(text, kind) {
    msg.hidden = false;
    msg.className = "notice " + (kind || "error");
    msg.textContent = text;
  }

  if (!FL.passkeysSupported()) {
    say("This browser cannot use passkeys.  Try a current Safari, Chrome, Edge, or Firefox.", "warn");
  }

  var signIn = document.getElementById("signin-form");
  signIn.addEventListener("submit", async function (e) {
    e.preventDefault();
    var button = signIn.querySelector("button");
    FL.busy(button, true);
    try {
      var email = signIn.email.value.trim();
      var started = await FL.api("POST", "/api/auth/passkey/authenticate/options", email ? { email: email } : {});
      var credential = await FL.passkeyGet(started.options);
      await FL.api("POST", "/api/auth/passkey/authenticate/verify", { challengeId: started.challengeId, credential: credential });
      location.href = target;
    } catch (err) {
      say(err.name === "NotAllowedError" ? "Sign-in was cancelled or timed out." : err.message);
    } finally {
      FL.busy(button, false);
    }
  });

  var signUp = document.getElementById("signup-form");
  signUp.addEventListener("submit", async function (e) {
    e.preventDefault();
    var button = signUp.querySelector("button");
    FL.busy(button, true);
    try {
      var body = { displayName: signUp.display_name.value.trim(), email: signUp.email.value.trim() || null };
      if (signUp.invite && signUp.invite.value.trim()) body.invite = signUp.invite.value.trim();
      var started = await FL.api("POST", "/api/auth/passkey/register/options", body);
      var credential = await FL.passkeyCreate(started.options);
      await FL.api("POST", "/api/auth/passkey/register/verify", { challengeId: started.challengeId, credential: credential });
      location.href = target;
    } catch (err) {
      say(err.name === "NotAllowedError" ? "Passkey creation was cancelled or timed out." : err.name === "InvalidStateError" ? "This device already has a FleetLink passkey.  Sign in instead." : err.message);
    } finally {
      FL.busy(button, false);
    }
  });

  var invite = new URLSearchParams(location.search).get("invite");
  if (invite && signUp.invite) {
    signUp.invite.value = invite;
    document.getElementById("signup").scrollIntoView();
  }
})();
`;
