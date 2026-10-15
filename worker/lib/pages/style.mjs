/** Site stylesheet, served at /assets/app.css.  Light theme only. */
export const APP_CSS = String.raw`
:root {
  --ink: #0f172a;
  --muted: #475569;
  --line: #e2e8f0;
  --soft: #f8fafc;
  --panel: #ffffff;
  --brand: #1d4ed8;
  --brand-dark: #1e3a8a;
  --ok: #047857;
  --ok-soft: #ecfdf5;
  --warn: #92400e;
  --warn-soft: #fffbeb;
  --bad: #b91c1c;
  --bad-soft: #fef2f2;
  --radius: 10px;
  --shadow: 0 1px 2px rgba(15, 23, 42, 0.06), 0 4px 16px rgba(15, 23, 42, 0.05);
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink); background: var(--soft); }
a { color: var(--brand); }
a:hover { color: var(--brand-dark); }
:focus-visible { outline: 3px solid var(--brand); outline-offset: 2px; }
h1, h2, h3 { line-height: 1.2; margin: 0 0 0.6rem; }
h1 { font-size: 1.9rem; letter-spacing: -0.01em; }
h2 { font-size: 1.3rem; margin-top: 0.4rem; }
h3 { font-size: 1.05rem; }
p { margin: 0 0 0.9rem; }
code, pre, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
pre { background: #0f172a; color: #e2e8f0; padding: 0.9rem 1rem; border-radius: var(--radius); overflow-x: auto; }
.skip { position: absolute; left: -999px; top: 0; background: #fff; padding: 0.5rem 1rem; z-index: 10; }
.skip:focus { left: 1rem; }
.bar { max-width: 1080px; margin: 0 auto; padding: 0 1.25rem; display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
.top { background: #fff; border-bottom: 1px solid var(--line); }
.top .bar { min-height: 60px; justify-content: space-between; }
.brand { font-weight: 800; font-size: 1.15rem; color: var(--ink); text-decoration: none; letter-spacing: -0.01em; }
.top nav { display: flex; gap: 0.25rem; align-items: center; flex-wrap: wrap; }
.top nav a, .top nav .link { color: var(--muted); text-decoration: none; padding: 0.5rem 0.7rem; border-radius: 8px; font-weight: 600; font-size: 0.95rem; min-height: 40px; display: inline-flex; align-items: center; }
.top nav a:hover, .top nav .link:hover { background: var(--soft); color: var(--ink); }
.top nav a[aria-current="page"] { color: var(--brand); background: #eff6ff; }
form.inline { display: inline; margin: 0; }
.wrap { max-width: 1080px; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
.foot { border-top: 1px solid var(--line); background: #fff; color: var(--muted); font-size: 0.9rem; }
.foot .bar { min-height: 56px; }
.foot a { color: var(--muted); }
.narrow { max-width: 30rem; margin: 2rem auto; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 1.25rem 1.35rem; box-shadow: var(--shadow); margin-bottom: 1.25rem; }
.card > h2:first-child, .card > h3:first-child { margin-top: 0; }
.grid { display: grid; gap: 1.25rem; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.eyebrow { text-transform: uppercase; letter-spacing: 0.06em; font-size: 0.78rem; font-weight: 700; color: var(--muted); margin-bottom: 0.3rem; }
.muted { color: var(--muted); }
.small { font-size: 0.88rem; }
.hero { padding: 2.5rem 0 1.5rem; }
.hero h1 { font-size: 2.4rem; max-width: 40rem; }
.hero p { font-size: 1.15rem; color: var(--muted); max-width: 40rem; }
.actions { display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: center; }
.actions.split { justify-content: space-between; }
.mt { margin-top: 1rem; }
.end { align-self: end; }
label { display: block; font-weight: 600; font-size: 0.92rem; margin: 0.7rem 0 0.3rem; }
label.check { display: flex; gap: 0.5rem; align-items: center; font-weight: 500; }
input[type=text], input[type=email], input[type=url], input[type=password], input[type=number], input[type=search], select, textarea {
  width: 100%; font: inherit; padding: 0.6rem 0.7rem; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; color: var(--ink); min-height: 44px;
}
input[type=file] { font: inherit; padding: 0.5rem 0; }
textarea { min-height: 6rem; }
.row { display: grid; gap: 0 1rem; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
button, .button { font: inherit; font-weight: 700; border: 1px solid var(--brand); background: var(--brand); color: #fff; padding: 0.6rem 1.05rem; border-radius: 8px; cursor: pointer; min-height: 44px; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; }
button:hover, .button:hover { background: var(--brand-dark); border-color: var(--brand-dark); color: #fff; }
button.secondary, .button.secondary { background: #fff; color: var(--ink); border-color: #cbd5e1; }
button.secondary:hover, .button.secondary:hover { background: var(--soft); color: var(--ink); }
button.danger { background: #fff; color: var(--bad); border-color: #fca5a5; }
button.danger:hover { background: var(--bad-soft); color: var(--bad); }
button.small, .button.small { padding: 0.3rem 0.65rem; min-height: 34px; font-size: 0.86rem; }
button.link { background: none; border: none; color: var(--muted); padding: 0.5rem 0.7rem; font-weight: 600; min-height: 40px; }
button.link:hover { background: var(--soft); color: var(--ink); }
button[disabled] { opacity: 0.55; cursor: not-allowed; }
.notice { border-radius: 8px; padding: 0.75rem 1rem; margin: 0.75rem 0; border: 1px solid var(--line); background: #fff; }
.notice.error { background: var(--bad-soft); border-color: #fecaca; color: var(--bad); }
.notice.ok { background: var(--ok-soft); border-color: #a7f3d0; color: var(--ok); }
.notice.warn { background: var(--warn-soft); border-color: #fde68a; color: var(--warn); }
.secret { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; background: var(--warn-soft); border: 1px solid #fde68a; padding: 0.75rem 1rem; border-radius: 8px; margin: 0.75rem 0; }
.secret code { word-break: break-all; font-size: 0.95rem; flex: 1 1 18rem; }
table { width: 100%; border-collapse: collapse; font-size: 0.94rem; }
th, td { text-align: left; padding: 0.6rem 0.5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 700; }
td .actions { gap: 0.35rem; }
.table-wrap { overflow-x: auto; }
.pill { display: inline-block; font-size: 0.75rem; font-weight: 700; padding: 0.1rem 0.5rem; border-radius: 999px; background: #eef2ff; color: #3730a3; margin-right: 0.25rem; white-space: nowrap; }
.pill.gray { background: #f1f5f9; color: var(--muted); }
.pill.green { background: var(--ok-soft); color: var(--ok); }
.pill.red { background: var(--bad-soft); color: var(--bad); }
.pill.amber { background: var(--warn-soft); color: var(--warn); }
.tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--line); margin-bottom: 1.25rem; flex-wrap: wrap; }
.tabs button { background: none; border: none; color: var(--muted); border-bottom: 3px solid transparent; border-radius: 0; padding: 0.6rem 0.9rem; }
.tabs button:hover { background: none; color: var(--ink); }
.tabs button[aria-selected="true"] { color: var(--brand); border-bottom-color: var(--brand); }
.meter { height: 10px; background: #e2e8f0; border-radius: 999px; overflow: hidden; margin: 0.4rem 0; }
.meter > span { display: block; height: 100%; background: var(--brand); }
.stats { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); margin-bottom: 1.25rem; }
.stat { background: #fff; border: 1px solid var(--line); border-radius: var(--radius); padding: 1rem; }
.stat b { display: block; font-size: 1.6rem; }
.files { list-style: none; padding: 0; margin: 1rem 0; }
.files li { margin: 0.4rem 0; }
.files a { display: flex; justify-content: space-between; gap: 1rem; padding: 0.75rem 0.9rem; background: #fff; border: 1px solid var(--line); border-radius: 8px; text-decoration: none; font-weight: 600; min-height: 44px; }
.files a:hover { border-color: var(--brand); }
.file-size { color: var(--muted); font-weight: 500; font-size: 0.9rem; }
.empty { color: var(--muted); padding: 1rem 0; }
#toast { position: fixed; bottom: 1.25rem; left: 50%; transform: translateX(-50%); max-width: 90vw; z-index: 50; }
#toast .notice { box-shadow: var(--shadow); }
[hidden] { display: none !important; }
@media (max-width: 640px) {
  .hero h1 { font-size: 1.8rem; }
  th.hide-sm, td.hide-sm { display: none; }
}
`;

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1d4ed8"/><path d="M22 34a8 8 0 0 1 0-11.3l5.7-5.7a8 8 0 0 1 11.3 11.3l-2.8 2.8M42 30a8 8 0 0 1 0 11.3l-5.7 5.7A8 8 0 0 1 25 35.7l2.8-2.8" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/></svg>`;
