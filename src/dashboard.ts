import { escapeHtml } from './pure';
import type { User } from './auth';

/** Same policy the portal page uses: the worker is the only host, so no external
 *  origins, and inline style plus inline script because the shell is assembled here. */
export const DASHBOARD_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'";

/** Rows held in the DOM per list page.  A list payload stays in memory; only this many
 *  rows are rendered at a time, so a 500-share response is never 500 rendered rows. */
const PAGE_SIZE = 25;

const shell = (inner: string) => `${inner}
<footer style="margin-top:3rem;padding-top:1.5rem;border-top:1px solid #eee;font-size:0.9rem;color:#666"><a href="/">FleetLink Home</a> &nbsp;&middot;&nbsp; <a href="/login">Sign In</a> &nbsp;&middot;&nbsp; <a href="/privacy">Privacy Policy</a> &nbsp;&middot;&nbsp; <a href="https://github.com/Simple-With-Us/FleetLink" target="_blank" rel="noopener">GitHub</a></footer>`;

const NAV = `<nav style="margin-bottom:1.5rem"><a href="/">&larr; Back to FleetLink</a> &nbsp;|&nbsp; <a href="/portal">Portal</a></nav>`;

const SIGNED_OUT = `${NAV}
<h1>Dashboard</h1>
<div style="background:#fee2e2;border:1px solid #f87171;color:#991b1b;padding:.75rem 1rem;border-radius:6px;margin:1rem 0;"><strong>Sign In Required.</strong>  Sign in to view your account, shares, agent tokens, and teams.</div>
<p><a href="/login" style="font-weight:600">Sign In</a> &nbsp;&middot;&nbsp; <a href="/">Back to FleetLink</a></p>`;

/** One label/value pair in the account card.  Values come from the signed-in session
 *  row, so they are escaped like any other user-supplied text. */
const accountRow = (label: string, value: string) =>
  `<div style="display:flex;gap:.75rem;padding:.35rem 0;border-bottom:1px solid #f3f4f6"><span style="min-width:11rem;color:#4b5563">${label}</span><span style="font-weight:600">${escapeHtml(value)}</span></div>`;

const accountCard = (user: User) => `<h2>Account</h2>
<div style="border:1px solid #e5e7eb;border-radius:8px;padding:1rem;margin:.5rem 0">
${accountRow('Display Name', user.display_name || 'Not Set')}
${accountRow('Email', user.email || 'Not Set')}
${accountRow('Role', user.role)}
${accountRow('Agent Token Quota', String(user.agent_token_quota ?? 3))}
</div>
<p style="margin-top:.5rem"><form action="/logout" method="post" style="display:inline"><button type="submit">Sign Out</button></form></p>`;

/** Agent tokens and teams are owner-scoped APIs that refuse a guest session, so the
 *  privileged panels are not rendered at all for a guest instead of rendering an empty
 *  shell that implies there is simply nothing there. */
const guestNotice = `<p style="background:#fffbeb;border:1px solid #fcd34d;color:#92400e;padding:.75rem 1rem;border-radius:6px;margin:1rem 0;">Agent Tokens And Teams Need An Account With An Email Address.  This Is A Guest Session, So Those Panels Are Not Shown.</p>`;

const SHARES_PANEL = `<h2>Shares</h2>
<p style="color:#4b5563">Create New Shares On The <a href="/">FleetLink Home Page</a>.  Use This Page To Renew Or Delete The Ones You Already Have.</p>
<div id="shares_body"><p>Loading Shares&hellip;</p></div>`;

const TOKENS_PANEL = `<h2>Agent Tokens</h2>
<p id="quota_line" style="color:#4b5563">Loading Quota&hellip;</p>
<p id="quota_hint" style="color:#4b5563"></p>
<details id="quota_details" style="margin:.5rem 0"><summary><strong>Request A Quota Increase</strong></summary>
<form id="f_quota" style="margin:.5rem 0;padding:.8rem;border:1px solid #ccc;border-radius:4px">
<p style="margin:0 0 .5rem">Ask For More Agent Tokens On The Free Tier.</p>
<label>Requested Count <input name="requested_count" type="number" min="4" max="20" value="5" required></label><br>
<label>Reason <input name="reason" placeholder="e.g. 5 parallel CI workers" required></label><br>
<button type="submit">Submit Request</button>
</form></details>
<details style="margin:.5rem 0"><summary><strong>Create Agent Token</strong></summary>
<form id="f_token" style="margin:.5rem 0;padding:.8rem;border:1px solid #ccc;border-radius:4px">
<label>Name <input name="name" required placeholder="e.g. CI Worker"></label><br>
<label>Max File MB <input name="max_file_mb" type="number" min="1" placeholder="default 300"></label><br>
<label>Max Batch MB <input name="max_batch_mb" type="number" min="1" placeholder="default 300"></label><br>
<label>Max Files <input name="max_files" type="number" min="1" placeholder="default 500"></label><br>
<label>Max TTL Seconds <input name="max_ttl_seconds" type="number" min="60" placeholder="default 604800"></label><br>
<label><input name="allow_redirects" type="checkbox" checked> Allow Redirects</label><br>
<button type="submit">Create Token</button>
</form></details>
<div id="token_panel" hidden style="background:#ecfdf5;border:1px solid #6ee7b7;color:#065f46;padding:.75rem 1rem;border-radius:6px;margin:1rem 0">
<p style="margin:0 0 .5rem"><strong>Your New Agent Token</strong></p>
<pre id="token_value" style="background:#fff;border:1px solid #e5e7eb;border-radius:4px;padding:.6rem;margin:0 0 .5rem;overflow-x:auto"></pre>
<p style="margin:0 0 .5rem">Copy This Token Now.  It Cannot Be Retrieved Again After You Leave This Page.</p>
<button type="button" id="copy_token">Copy Token</button> <button type="button" id="dismiss_token">Dismiss</button>
</div>
<div id="tokens_body"><p>Loading Agent Tokens&hellip;</p></div>
<p style="color:#4b5563;font-size:0.9rem">Revoked Tokens Are Removed From This List.</p>`;

const TEAMS_PANEL = `<h2>Teams</h2>
<details style="margin:.5rem 0"><summary><strong>Create A Team</strong></summary>
<form id="f_team" style="margin:.5rem 0;padding:.8rem;border:1px solid #ccc;border-radius:4px">
<p style="margin:0 0 .5rem">A New Team Starts A 7-Day Free Trial.  Team Shares Revert To Their Creator When The Trial Ends.</p>
<label>Team Name <input name="name" required placeholder="e.g. Design Team"></label><br>
<button type="submit">Create Team</button>
</form></details>
<div id="teams_body"><p>Loading Teams&hellip;</p></div>`;

const NOTIFY = `<div id="notice" hidden style="padding:.75rem 1rem;border-radius:6px;margin:1rem 0"></div>`;

/** Client behaviour.  Every handler is attached by assignment, never an inline
 *  attribute, and every server value reaches the DOM through textContent. */
const SCRIPT = `<script>
const PAGE=25;
function el(t,x){const n=document.createElement(t);if(x!==null&&x!==undefined)n.textContent=String(x);return n}
function td(x){const c=document.createElement('td');c.style.padding='.4rem .5rem';c.style.borderBottom='1px solid #f3f4f6';if(x instanceof Node)c.append(x);else c.textContent=(x===null||x===undefined)?'—':String(x);return c}
function fmtDate(v){if(!v)return 'Never';const d=new Date(v);return isNaN(d.getTime())?'Never':d.toISOString().slice(0,19).replace('T',' ')+' UTC'}
function toast(msg,bad){const t=document.querySelector('#notice');if(!t)return;t.textContent=msg;t.style.background=bad?'#fee2e2':'#ecfdf5';t.style.border='1px solid '+(bad?'#f87171':'#6ee7b7');t.style.color=bad?'#991b1b':'#065f46';t.hidden=false}
async function errText(r,fallback){try{const d=await r.json();return d&&d.error?d.error:fallback}catch(e){return fallback}}
function copyBtn(text,label){const b=el('button',label);b.type='button';b.style.marginLeft='.3rem';b.onclick=async()=>{try{await navigator.clipboard.writeText(text);b.textContent='Copied'}catch(e){b.textContent='Copy Failed'}setTimeout(()=>{b.textContent=label},1500)};return b}
function renderTable(host,headers,rows,page,setPage){
  host.replaceChildren();
  const per=PAGE,pages=Math.max(1,Math.ceil(rows.length/per)),cur=Math.min(Math.max(1,page),pages);
  const start=(cur-1)*per,slice=rows.slice(start,start+per);
  const t=document.createElement('table');t.style.width='100%';t.style.borderCollapse='collapse';
  const thead=document.createElement('thead'),htr=document.createElement('tr');
  for(const h of headers){const th=el('th',h);th.style.textAlign='left';th.style.padding='.4rem .5rem';th.style.borderBottom='1px solid #e5e7eb';htr.append(th)}
  thead.append(htr);t.append(thead);
  const tb=document.createElement('tbody');
  for(const r of slice){const tr=document.createElement('tr');for(const c of r)tr.append(td(c));tb.append(tr)}
  t.append(tb);host.append(t);
  const nav=document.createElement('div');nav.style.margin='.6rem 0';
  nav.append(el('span','Showing '+(start+1)+'–'+Math.min(start+per,rows.length)+' Of '+rows.length+'  '));
  const prev=el('button','Previous Page');prev.type='button';prev.disabled=cur<=1;prev.onclick=()=>setPage(cur-1);
  const next=el('button','Next Page');next.type='button';next.disabled=cur>=pages;next.onclick=()=>setPage(cur+1);
  nav.append(prev,' ',next);host.append(nav);
}
let shareRows=null,sharePage=1;
async function loadShares(){
  const host=document.querySelector('#shares_body');if(!host)return;
  const r=await fetch('/api/shares',{headers:{'Accept':'application/json'}});
  if(!r.ok){host.replaceChildren(el('p','Could Not Load Shares.  Sign In Again If This Keeps Happening.'));return}
  const d=await r.json();shareRows=d.shares||[];drawShares();
}
function drawShares(){
  const host=document.querySelector('#shares_body');if(!host)return;
  if(!shareRows||!shareRows.length){host.replaceChildren(el('p','No Active Shares Yet.'));return}
  renderTable(host,['Slug','URL','Mode','Files','Size','Expires','Renewals','Actions'],shareRows.map(s=>{
    const a=document.createElement('a');a.href=s.url;a.textContent=s.is_team?s.slug+' (Team)':s.slug;
    const act=document.createElement('div');
    const rn=el('button','Renew');rn.type='button';rn.onclick=()=>renewShare(s.slug);
    const dl=el('button','Delete');dl.type='button';dl.style.marginLeft='.3rem';dl.onclick=()=>deleteShare(s.slug);
    act.append(copyBtn(s.url,'Copy Link'),rn,dl);
    return [a,s.mode,s.mode==='redirect'?'—':s.files,s.mode==='redirect'?'—':Math.round(s.bytes/1024)+' KB',fmtDate(s.expires_at),s.renewals_used+' / 3',act];
  }),sharePage,p=>{sharePage=p;drawShares()});
}
async function renewShare(slug){
  const r=await fetch('/api/shares/'+encodeURIComponent(slug)+'/renew',{method:'POST'});
  if(!r.ok){toast(await errText(r,'Renewal Failed.'),true);return}
  toast('Share Renewed.',false);loadShares();
}
async function deleteShare(slug){
  if(!confirm('Delete Share '+slug+'?  This Cannot Be Undone.'))return;
  const r=await fetch('/api/shares/'+encodeURIComponent(slug),{method:'DELETE'});
  if(!r.ok){toast(await errText(r,'Delete Failed.'),true);return}
  toast('Share Deleted.',false);loadShares();
}
let tokenRows=null,tokenPage=1;
async function loadTokens(){
  const host=document.querySelector('#tokens_body');if(!host)return;
  const r=await fetch('/api/user/agent-tokens',{headers:{'Accept':'application/json'}});
  if(!r.ok){host.replaceChildren(el('p','Agent Tokens Are Not Available For This Session.'));return}
  const d=await r.json();
  const ql=document.querySelector('#quota_line');if(ql)ql.textContent='Active Tokens: '+d.count+' Of '+d.quota+' Quota';
  const qr=document.querySelector('#quota_details'),qh=document.querySelector('#quota_hint');
  if(qr&&qh){if(d.can_create){qr.open=false;qh.textContent=''}else{qr.open=true;qh.textContent='Your Quota Is Full.  Request An Increase To Create More Tokens.'}}
  tokenRows=d.tokens||[];drawTokens();
}
function drawTokens(){
  const host=document.querySelector('#tokens_body');if(!host)return;
  if(!tokenRows||!tokenRows.length){host.replaceChildren(el('p','No Agent Tokens Yet.'));return}
  renderTable(host,['Name','Prefix','Created','Last Used','Status','Actions'],tokenRows.map(t=>{
    const rv=el('button','Revoke');rv.type='button';rv.onclick=()=>revokeToken(t.id);
    return [t.name,t.token_prefix+'…',fmtDate(t.created_at),fmtDate(t.last_used_at),'active',rv];
  }),tokenPage,p=>{tokenPage=p;drawTokens()});
}
async function revokeToken(id){
  if(!confirm('Revoke This Agent Token?  Anything Using It Stops Working Immediately.'))return;
  const r=await fetch('/api/user/agent-tokens/'+encodeURIComponent(id),{method:'DELETE'});
  if(!r.ok){toast(await errText(r,'Revoke Failed.'),true);return}
  toast('Token Revoked.',false);loadTokens();
}
let teamRows=null,teamPage=1;
async function loadTeams(){
  const host=document.querySelector('#teams_body');if(!host)return;
  const r=await fetch('/api/teams',{headers:{'Accept':'application/json'}});
  if(!r.ok){host.replaceChildren(el('p','Team Workspaces Are Not Available For This Session.'));return}
  const d=await r.json();teamRows=d.teams||[];drawTeams();
}
function teamCard(t){
  const box=document.createElement('div');
  box.style.border='1px solid #e5e7eb';box.style.borderRadius='8px';box.style.padding='1rem';box.style.margin='.5rem 0';
  const h=document.createElement('h3');h.style.margin='0 0 .3rem';h.textContent=t.name;
  const badge=el('small',t.is_trial_active?('trial — '+t.trial_days_remaining+' day(s) left'):(t.plan==='pro'?'pro':'trial expired'));
  badge.style.marginLeft='.5rem';h.append(badge);box.append(h);
  const meta=el('p','Role: '+t.my_role+'  |  Members: '+t.members.length+'  |  Trial Ends: '+fmtDate(t.trial_ends_at));
  meta.style.color='#4b5563';meta.style.margin='0 0 .6rem';box.append(meta);
  const tbl=document.createElement('table');tbl.style.width='100%';tbl.style.borderCollapse='collapse';
  const thead=document.createElement('thead'),htr=document.createElement('tr');
  for(const h2 of ['Name','Email','Role','Actions']){const th=el('th',h2);th.style.textAlign='left';th.style.padding='.4rem .5rem';th.style.borderBottom='1px solid #e5e7eb';htr.append(th)}
  thead.append(htr);tbl.append(thead);
  const tb=document.createElement('tbody');
  for(const m of t.members){
    const tr=document.createElement('tr');
    tr.append(td(m.display_name),td(m.email),td(m.role));
    const rm=el('button','Remove Member');rm.type='button';
    if(m.role==='organizer'){rm.disabled=true;rm.title='The Organizer Cannot Be Removed.'}else{rm.onclick=()=>removeMember(t.id,m.user_id)}
    tr.append(td(rm));tb.append(tr);
  }
  tbl.append(tb);box.append(tbl);
  if((t.my_role==='organizer'||t.my_role==='admin')&&(t.is_trial_active||t.plan==='pro')){
    const f=document.createElement('form');f.style.marginTop='.6rem';
    const em=document.createElement('input');em.type='email';em.name='email';em.required=true;em.placeholder='teammate@example.com';
    const b=el('button','Add Member');b.type='submit';
    f.append(em,' ',b);
    f.onsubmit=async ev=>{ev.preventDefault();
      const r=await fetch('/api/teams/'+encodeURIComponent(t.id)+'/members',{method:'POST',body:new FormData(f)});
      if(!r.ok){toast(await errText(r,'Could Not Add Member.'),true);return}
      toast('Member Added.',false);f.reset();loadTeams()};
    box.append(f);
  }
  return box;
}
function drawTeams(){
  const host=document.querySelector('#teams_body');if(!host)return;
  host.replaceChildren();
  if(!teamRows||!teamRows.length){host.append(el('p','No Teams Yet.'));return}
  const per=PAGE,pages=Math.max(1,Math.ceil(teamRows.length/per)),cur=Math.min(Math.max(1,teamPage),pages);
  const start=(cur-1)*per;
  for(const t of teamRows.slice(start,start+per))host.append(teamCard(t));
  const nav=document.createElement('div');nav.style.margin='.6rem 0';
  nav.append(el('span','Showing '+(start+1)+'–'+Math.min(start+per,teamRows.length)+' Of '+teamRows.length+'  '));
  const prev=el('button','Previous Page');prev.type='button';prev.disabled=cur<=1;prev.onclick=()=>{teamPage=cur-1;drawTeams()};
  const next=el('button','Next Page');next.type='button';next.disabled=cur>=pages;next.onclick=()=>{teamPage=cur+1;drawTeams()};
  nav.append(prev,' ',next);host.append(nav);
}
async function removeMember(teamId,userId){
  if(!confirm('Remove This Member From The Team?'))return;
  const r=await fetch('/api/teams/'+encodeURIComponent(teamId)+'/members/'+encodeURIComponent(userId),{method:'DELETE'});
  if(!r.ok){toast(await errText(r,'Could Not Remove Member.'),true);return}
  toast('Member Removed.',false);loadTeams();
}
const fToken=document.querySelector('#f_token');
if(fToken)fToken.onsubmit=async e=>{
  e.preventDefault();
  const r=await fetch('/api/user/agent-tokens',{method:'POST',body:new FormData(fToken)});
  const d=await r.json().catch(()=>({}));
  if(!r.ok||!d.token){toast(d.error||'Token Creation Failed.',true);return}
  fToken.reset();loadTokens();
  const p=document.querySelector('#token_panel'),v=document.querySelector('#token_value');
  v.textContent=d.token;p.hidden=false;
};
const cp=document.querySelector('#copy_token');
if(cp)cp.onclick=async()=>{try{await navigator.clipboard.writeText(document.querySelector('#token_value').textContent);toast('Token Copied.',false)}catch(e){toast('Copy Failed.  Select The Token And Copy It Manually.',true)}};
const dm=document.querySelector('#dismiss_token');
if(dm)dm.onclick=()=>{document.querySelector('#token_panel').hidden=true;document.querySelector('#token_value').textContent=''};
const fQuota=document.querySelector('#f_quota');
if(fQuota)fQuota.onsubmit=async e=>{
  e.preventDefault();
  const r=await fetch('/api/user/agent-quota-request',{method:'POST',body:new FormData(fQuota)});
  if(!r.ok){toast(await errText(r,'Quota Request Failed.'),true);return}
  fQuota.reset();toast('Quota Increase Request Submitted.',false);
};
const fTeam=document.querySelector('#f_team');
if(fTeam)fTeam.onsubmit=async e=>{
  e.preventDefault();
  const r=await fetch('/api/teams',{method:'POST',body:new FormData(fTeam)});
  if(!r.ok){toast(await errText(r,'Team Creation Failed.'),true);return}
  fTeam.reset();toast('Team Created.',false);loadTeams();loadShares();
};
loadShares();loadTokens();loadTeams();
</script>`;

/** The dashboard body for a request.  Returns the signed-out shell with no session data
 *  when there is no signed-in user, so the route can answer 401 without leaking. */
export function dashboardBody(user: User | null): string {
  if (!user) return shell(SIGNED_OUT);
  const isGuest = !user.email;
  return shell(
    `${NAV}<h1>Dashboard</h1>${NOTIFY}${accountCard(user)}${SHARES_PANEL}` +
      (isGuest ? guestNotice : `${TOKENS_PANEL}${TEAMS_PANEL}`) +
      SCRIPT
  );
}