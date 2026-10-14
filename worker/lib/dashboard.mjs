import { escapeHtml } from "./bytes.mjs";

export const DASHBOARD_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'";

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dashboard — FleetLink</title>
<style>
  body{font:16px system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#111}
  a{color:#1d4ed8} input,button{font:inherit;margin:.3rem 0;padding:.45rem} table{width:100%;border-collapse:collapse}
  th,td{text-align:left;padding:.35rem .4rem;border-bottom:1px solid #eee;vertical-align:top}
  .card{border:1px solid #e5e7eb;border-radius:8px;padding:1rem;margin:.5rem 0}
  .warn{background:#fffbeb;border:1px solid #fcd34d;color:#92400e;padding:.75rem 1rem;border-radius:6px}
  .err{background:#fee2e2;border:1px solid #f87171;color:#991b1b;padding:.75rem 1rem;border-radius:6px}
  #notice[hidden]{display:none}
</style></head><body>`;

function accountCard(user) {
  const row = (label, value) =>
    `<div style="display:flex;gap:.75rem;padding:.35rem 0;border-bottom:1px solid #f3f4f6"><span style="min-width:11rem;color:#4b5563">${escapeHtml(label)}</span><span style="font-weight:600">${escapeHtml(value)}</span></div>`;
  return `<h2>Account</h2><div class="card">
    ${row("Display Name", user.display_name || "Not Set")}
    ${row("Email", user.email || "Not Set")}
    ${row("Role", user.role)}
    ${row("Agent Token Quota", String(user.agent_token_quota ?? 3))}
    ${row("Passkeys", String(user.passkey_count ?? 0))}
  </div>
  <form action="/logout" method="post"><button type="submit">Sign Out</button></form>`;
}

const SIGNED_OUT = `<nav><a href="/">&larr; FleetLink</a></nav>
<h1>Dashboard</h1>
<div class="err"><strong>Sign In Required.</strong>  Sign in with a passkey to view your account, agent tokens, and teams.</div>
<p><a href="/login">Sign In</a></p>`;

const SCRIPT = `<script>
function el(t,x){var n=document.createElement(t);if(x!=null)n.textContent=String(x);return n}
function toast(msg,bad){var t=document.querySelector("#notice");t.hidden=false;t.textContent=msg;t.className=bad?"err":"card"}
async function errText(r,fallback){try{var d=await r.json();return d&&d.error?d.error:fallback}catch(e){return fallback}}
async function loadShares(){
  var host=document.querySelector("#shares_body");
  var r=await fetch("/api/shares",{headers:{Accept:"application/json"}});
  if(!r.ok){host.textContent="Could not load shares.";return}
  var d=await r.json();
  host.textContent=d.note || (d.shares&&d.shares.length?d.shares.length+" shares":"No account-indexed shares yet.");
}
async function loadTokens(){
  var host=document.querySelector("#tokens_body");
  var r=await fetch("/api/user/agent-tokens",{headers:{Accept:"application/json"}});
  if(!r.ok){host.textContent="Agent tokens are not available for this session.";return}
  var d=await r.json();
  var line=document.querySelector("#quota_line");
  if(line)line.textContent="Active tokens: "+d.count+" of "+d.quota+".";
  host.replaceChildren();
  if(!d.tokens||!d.tokens.length){host.append(el("p","No agent tokens yet."));return}
  var table=document.createElement("table");
  d.tokens.forEach(function(t){
    var tr=document.createElement("tr");
    var btn=el("button","Revoke");btn.type="button";btn.onclick=function(){revokeToken(t.id)};
    [t.name,t.token_prefix,t.created_at].forEach(function(c){var td=document.createElement("td");td.textContent=c;tr.append(td)});
    var td=document.createElement("td");td.append(btn);tr.append(td);table.append(tr);
  });
  host.append(table);
}
async function revokeToken(id){
  if(!confirm("Revoke this agent token?"))return;
  var r=await fetch("/api/user/agent-tokens/"+encodeURIComponent(id),{method:"DELETE"});
  if(!r.ok){toast(await errText(r,"Revoke failed."),true);return}
  toast("Token revoked.",false);loadTokens();
}
async function loadTeams(){
  var host=document.querySelector("#teams_body");
  var r=await fetch("/api/teams",{headers:{Accept:"application/json"}});
  if(!r.ok){host.textContent="Teams are not available for this session.";return}
  var d=await r.json();
  host.replaceChildren();
  if(!d.teams||!d.teams.length){host.append(el("p","No teams yet."));return}
  d.teams.forEach(function(t){
    var box=document.createElement("div");box.className="card";
    box.append(el("h3",t.name+" ("+t.plan+", "+t.my_role+")"));
    (t.members||[]).forEach(function(m){box.append(el("div",(m.display_name||m.email||m.user_id)+" — "+m.role))});
    host.append(box);
  });
}
var fToken=document.querySelector("#f_token");
if(fToken)fToken.onsubmit=async function(e){
  e.preventDefault();
  var r=await fetch("/api/user/agent-tokens",{method:"POST",body:new FormData(fToken)});
  var d=await r.json().catch(function(){return {}});
  if(!r.ok||!d.token){toast(d.error||"Token creation failed.",true);return}
  document.querySelector("#token_value").textContent=d.token;
  document.querySelector("#token_panel").hidden=false;
  fToken.reset();loadTokens();
};
var fTeam=document.querySelector("#f_team");
if(fTeam)fTeam.onsubmit=async function(e){
  e.preventDefault();
  var r=await fetch("/api/teams",{method:"POST",body:new FormData(fTeam)});
  if(!r.ok){toast(await errText(r,"Team creation failed."),true);return}
  fTeam.reset();toast("Team created.",false);loadTeams();
};
var fQuota=document.querySelector("#f_quota");
if(fQuota)fQuota.onsubmit=async function(e){
  e.preventDefault();
  var r=await fetch("/api/user/agent-quota-request",{method:"POST",body:new FormData(fQuota)});
  if(!r.ok){toast(await errText(r,"Quota request failed."),true);return}
  fQuota.reset();toast("Quota increase request submitted.",false);
};
loadShares();loadTokens();loadTeams();
</script>`;

/** Signed-out callers get the shell and a 401.  No account data is embedded. */
export function dashboardBody(user) {
  if (!user) return `${PAGE}${SIGNED_OUT}</body></html>`;
  return `${PAGE}
    <nav><a href="/">&larr; FleetLink</a> &nbsp;|&nbsp; <a href="/portal">Portal</a></nav>
    <h1>Dashboard</h1>
    <div id="notice" hidden></div>
    ${accountCard(user)}
    <h2>Shares</h2>
    <p>New account uploads are not indexed here yet.  Operator shares stay in the portal.</p>
    <div id="shares_body"><p>Loading shares…</p></div>
    <h2>Agent Tokens</h2>
    <p id="quota_line">Loading quota…</p>
    <form id="f_token">
      <label>Name <input name="name" required placeholder="CI worker"></label>
      <button type="submit">Create Token</button>
    </form>
    <div id="token_panel" hidden class="card"><p><strong>Your new agent token</strong></p><pre id="token_value"></pre><p>Copy this token now.  It cannot be retrieved again.</p></div>
    <div id="tokens_body"></div>
    <form id="f_quota">
      <label>Requested count <input name="requested_count" type="number" min="4" max="20" value="5" required></label>
      <label>Reason <input name="reason" required></label>
      <button type="submit">Request Quota Increase</button>
    </form>
    <h2>Teams</h2>
    <form id="f_team"><label>Team name <input name="name" required></label><button type="submit">Create Team</button></form>
    <div id="teams_body"></div>
    ${SCRIPT}</body></html>`;
}

export function dashboardResponse(user) {
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": DASHBOARD_CSP,
    "X-Content-Type-Options": "nosniff"
  };
  return new Response(dashboardBody(user), { status: user ? 200 : 401, headers });
}
