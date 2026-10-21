/**
 * Site stylesheet, served at /assets/app.css.  One design system for the
 * landing page, sign-in, dashboard, admin, and share pages.  Colors come from
 * the app icon: deep navy and electric blue for the link, gold for the bolt.
 * Light theme only.
 */
export const APP_CSS = String.raw`
:root {
  --ink: #0b1b33;
  --muted: #4a5a72;
  --line: #dfe6f0;
  --soft: #f4f7fb;
  --panel: #ffffff;
  --navy: #0b1f3a;
  --navy-2: #12305a;
  --brand: #1a56db;
  --brand-dark: #133d9e;
  --cyan: #19a7e6;
  --gold: #f5a524;
  --gold-dark: #b86e00;
  --ok: #047857;
  --ok-soft: #ecfdf5;
  --warn: #92400e;
  --warn-soft: #fffbeb;
  --bad: #b91c1c;
  --bad-soft: #fef2f2;
  --radius: 12px;
  --shadow: 0 1px 2px rgba(11, 31, 58, 0.06), 0 8px 24px rgba(11, 31, 58, 0.06);
  --shadow-lg: 0 2px 4px rgba(11, 31, 58, 0.06), 0 24px 48px rgba(11, 31, 58, 0.12);
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; background: #fff; }
body { margin: 0; font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink); background: var(--soft);; min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column; }
a { color: var(--brand); }
a:hover { color: var(--brand-dark); }
:focus-visible { outline: 3px solid var(--cyan); outline-offset: 2px; }
h1, h2, h3 { line-height: 1.2; margin: 0 0 0.6rem; letter-spacing: -0.015em; }
h1 { font-size: 2rem; }
h2 { font-size: 1.35rem; margin-top: 0.4rem; }
h3 { font-size: 1.05rem; }
p { margin: 0 0 0.9rem; }
code, pre, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
pre { background: var(--navy); color: #dbe7ff; padding: 0.9rem 1rem; border-radius: var(--radius); overflow-x: auto; line-height: 1.5; }
.skip { position: absolute; left: -999px; top: 0; background: #fff; padding: 0.5rem 1rem; z-index: 10; }
.skip:focus { left: 1rem; }
.bar { max-width: 1120px; margin: 0 auto; padding: 0 1.25rem; display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }

/* Header, shared by every page */
.top { background: rgba(255, 255, 255, 0.92); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 20; backdrop-filter: saturate(1.4) blur(8px); }
.top .bar { min-height: 64px; justify-content: space-between; }
.brand { display: inline-flex; align-items: center; gap: 0.6rem; font-weight: 800; font-size: 1.2rem; color: var(--navy); text-decoration: none; letter-spacing: -0.02em; }
.brand:hover { color: var(--navy); }
.brand img { width: 34px; height: 34px; border-radius: 9px; box-shadow: 0 2px 8px rgba(25, 167, 230, 0.35); }
.top nav { display: flex; gap: 0.25rem; align-items: center; flex-wrap: wrap; }
.top nav .nav-pages, .top nav .nav-account { display: inline-flex; align-items: center; gap: 0.25rem; flex-wrap: wrap; }
.top nav a, .top nav .link { color: var(--muted); text-decoration: none; padding: 0.5rem 0.75rem; border-radius: 8px; font-weight: 600; font-size: 0.95rem; min-height: 40px; display: inline-flex; align-items: center; }
.top nav a:hover, .top nav .link:hover { background: var(--soft); color: var(--ink); }
.top nav a[aria-current="page"] { color: var(--brand); background: #eaf1ff; }
.top nav a.button { color: #fff; margin-left: 0.25rem; background: var(--brand); }
.top nav a.button:hover { color: #fff; background: var(--brand-dark); }
.top nav a.button.secondary { background: #fff; color: var(--ink); border-color: #c7d2e3; }
.top nav a.button.secondary:hover { background: var(--soft); color: var(--ink); border-color: #c7d2e3; }
.top .brand-wordmark-picture, .top .brand-wordmark-picture source { display: none; }
.top.is-public.is-scrolled .brand-wordmark-picture { display: contents; }
.top.is-hero .brand-wordmark-picture, .top.is-hero .brand-wordmark-picture source { display: contents; }
.top .brand-wordmark { display: none; height: 28px; width: auto; border-radius: 0; box-shadow: none; }
.top.is-hero .bar { position: relative; }
.top.is-hero .brand { position: absolute; left: 1.25rem; top: 50%; transform: translateY(-50%); }
.top.is-hero nav { margin-left: auto; }
.top.is-hero .brand-wordmark { display: inline-block; opacity: 0; visibility: hidden; transition: opacity .3s ease, visibility .3s; }
.top.is-hero.is-scrolled .brand-wordmark { opacity: 1; visibility: visible; }
@media (prefers-reduced-motion: reduce) { .top.is-hero .brand-wordmark { transition: none; } }
.top.is-public.is-scrolled nav a:not(.button) { display: none; }
/* Owner-requested 1px optical adjustment; flex centering is otherwise unchanged. */
.top.is-public.is-scrolled nav a.button.secondary { transform: translateY(-1px); }
.top.is-public.is-scrolled .brand:has(.brand-wordmark) img:not(.brand-wordmark), .top.is-public.is-scrolled .brand:has(.brand-wordmark) .brand-text { display: none; }
.top.is-public.is-scrolled .brand:has(.brand-wordmark) .brand-wordmark { display: inline-block; }
.who { display: inline-flex; align-items: center; gap: 0.45rem; color: var(--ink); font-weight: 600; font-size: 0.95rem; padding: 0 0.5rem; }
.avatar { width: 30px; height: 30px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: linear-gradient(135deg, var(--brand), var(--cyan)); color: #fff; font-weight: 800; font-size: 0.85rem; }
form.inline { display: inline; margin: 0; }

main { flex: 1 0 auto; }
.wrap { max-width: 1120px; margin: 0 auto; padding: 2rem 1.25rem 3rem; }

/* Footer, shared by every page */
.foot { border-top: 1px solid var(--line); background: #fff; color: var(--muted); font-size: 0.92rem; }
.foot .bar { min-height: 72px; justify-content: center; gap: 0.75rem 2.5rem; padding-top: 1.1rem; padding-bottom: 1.1rem; }
.foot nav { display: flex; gap: 0.5rem 1.4rem; flex-wrap: wrap; justify-content: center; align-items: center; }
.foot a { color: var(--muted); text-decoration: none; }
.foot nav a { color: var(--ink); font-weight: 600; }
.foot nav a:hover { color: var(--brand); }
.foot nav a.mail-icon { display: inline-flex; align-items: center; padding: 0.15rem 0; }
.foot nav.legal { flex-basis: 100%; font-size: 0.8rem; opacity: 0.7; gap: 0.35rem 1.25rem; }
.foot nav.legal a { color: var(--muted); font-weight: 500; }
.foot nav.legal a:hover { color: var(--ink); }

/* Building blocks */
.narrow { max-width: 30rem; margin: 2rem auto; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 1.25rem 1.35rem; box-shadow: var(--shadow); margin-bottom: 1.25rem; }
.card > h2:first-child, .card > h3:first-child { margin-top: 0; }
.grid { display: grid; gap: 1.25rem; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); }
.grid-3 { display: grid; gap: 1.25rem; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.eyebrow { text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.78rem; font-weight: 800; color: var(--brand); margin-bottom: 0.4rem; }
.muted { color: var(--muted); }
.small { font-size: 0.88rem; }
.actions { display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: center; }
.actions.split { justify-content: space-between; }
.mt { margin-top: 1rem; }
.end { align-self: end; }
#share-search .end { display: flex; gap: 0.5rem; }
#share-search .end button { flex: 1 1 0; white-space: nowrap; }
label { display: block; font-weight: 600; font-size: 0.92rem; margin: 0.7rem 0 0.3rem; }
label.check { display: flex; gap: 0.5rem; align-items: center; font-weight: 500; }
input[type=text], input[type=email], input[type=url], input[type=password], input[type=number], input[type=search], select, textarea {
  width: 100%; font: inherit; padding: 0.6rem 0.75rem; border: 1px solid #c7d2e3; border-radius: 9px; background: #fff; color: var(--ink); min-height: 44px;
}
input:focus, select:focus, textarea:focus { border-color: var(--brand); outline: 3px solid rgba(26, 86, 219, 0.18); outline-offset: 0; }
input[type=file] { font: inherit; padding: 0.5rem 0; }
textarea { min-height: 6rem; }
.row { display: grid; gap: 0 1rem; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
button, .button { font: inherit; font-weight: 700; border: 1px solid var(--brand); background: var(--brand); color: #fff; padding: 0.6rem 1.1rem; border-radius: 9px; cursor: pointer; min-height: 44px; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; }
button:hover, .button:hover { background: var(--brand-dark); border-color: var(--brand-dark); color: #fff; }
button.secondary, .button.secondary { background: #fff; color: var(--ink); border-color: #c7d2e3; }
button.secondary:hover, .button.secondary:hover { background: var(--soft); color: var(--ink); }
.button.gold { background: var(--gold); border-color: var(--gold); color: var(--navy); }
.button.gold:hover { background: #ffb940; border-color: #ffb940; color: var(--navy); }
.button.large { padding: 0.8rem 1.4rem; font-size: 1.05rem; min-height: 50px; }
button.danger { background: #fff; color: var(--bad); border-color: #fca5a5; }
button.danger:hover { background: var(--bad-soft); color: var(--bad); }
button.small, .button.small { padding: 0.3rem 0.65rem; min-height: 34px; font-size: 0.86rem; }
select.small { width: auto; max-width: 15rem; padding: 0.3rem 0.5rem; min-height: 34px; font-size: 0.86rem; }
button.link { background: none; border: none; color: var(--muted); padding: 0.5rem 0.75rem; font-weight: 600; min-height: 40px; }
button.link:hover { background: var(--soft); color: var(--ink); }
button[disabled] { opacity: 0.55; cursor: not-allowed; }
.notice { border-radius: 9px; padding: 0.75rem 1rem; margin: 0.75rem 0; border: 1px solid var(--line); background: #fff; }
.notice.error { background: var(--bad-soft); border-color: #fecaca; color: var(--bad); }
.notice.ok { background: var(--ok-soft); border-color: #a7f3d0; color: var(--ok); }
.notice.warn { background: var(--warn-soft); border-color: #fde68a; color: var(--warn); }
.secret { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; background: var(--warn-soft); border: 1px solid #fde68a; padding: 0.75rem 1rem; border-radius: 9px; margin: 0.75rem 0; }
.secret code { word-break: break-all; font-size: 0.95rem; flex: 1 1 18rem; }
table { width: 100%; border-collapse: collapse; font-size: 0.94rem; }
th, td { text-align: left; padding: 0.65rem 0.5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 700; }
th.sortable { cursor: pointer; user-select: none; transition: color 0.15s; }
th.sortable:hover { color: var(--brand); }
th.sortable::after { content: " ↕"; opacity: 0.35; font-size: 0.85em; }
th.sortable.sort-asc::after { content: " ▲"; opacity: 1; color: var(--brand); }
th.sortable.sort-desc::after { content: " ▼"; opacity: 1; color: var(--brand); }
.chip-row { display: flex; gap: 0.4rem; flex-wrap: wrap; margin: 0.5rem 0; }
.chip { font-size: 0.8rem; font-weight: 600; padding: 0.25rem 0.65rem; border-radius: 999px; background: #eef2f7; color: var(--text); border: 1px solid transparent; cursor: pointer; transition: all 0.15s; }
.chip:hover { background: #e0e7f1; }
.chip.active { background: var(--brand); color: #fff; }
.share-summary { font-size: 0.82rem; color: var(--muted); margin: 0.25rem 0 0.5rem; }
td .actions { gap: 0.35rem; }
td .rowmenu { position: relative; }
.rowmenu { display: inline-block; }
.rowmenu > summary { list-style: none; cursor: pointer; user-select: none; border: 1px solid var(--line); border-radius: 8px; background: #fff; color: var(--muted); font-weight: 800; padding: 0.35rem 0.65rem; line-height: 1; letter-spacing: 0.06em; }
.rowmenu > summary::-webkit-details-marker { display: none; }
.rowmenu > summary:hover, .rowmenu[open] > summary { background: var(--soft); color: var(--ink); }
.rowmenu .actions { position: absolute; right: 0; top: calc(100% + 4px); z-index: 30; flex-direction: column; flex-wrap: nowrap; align-items: stretch; background: #fff; border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow-lg); padding: 0.5rem; min-width: 150px; gap: 0.35rem; }
.rowmenu .actions > * { width: 100%; justify-content: center; text-align: center; }
@media (min-width: 641px) {
  .rowmenu > summary { display: none; }
  .rowmenu:not([open]) > .actions { display: flex; }
  .rowmenu .actions { position: static; flex-direction: row; flex-wrap: wrap; background: none; border: 0; box-shadow: none; padding: 0; min-width: 0; }
  .rowmenu .actions > * { width: auto; }
}
.table-wrap { overflow-x: auto; background: #fff; border: 1px solid var(--line); border-radius: var(--radius); padding: 0.25rem 0.75rem; box-shadow: var(--shadow); margin-bottom: 1rem; }
.table-wrap tr:last-child td { border-bottom: none; }
.pill { display: inline-block; font-size: 0.75rem; font-weight: 700; padding: 0.12rem 0.55rem; border-radius: 999px; background: #e8efff; color: var(--brand-dark); margin-right: 0.25rem; white-space: nowrap; }
.pill.gray { background: #eef2f7; color: var(--muted); }
.pill.green { background: var(--ok-soft); color: var(--ok); }
.pill.red { background: var(--bad-soft); color: var(--bad); }
.pill.amber { background: #fff4dc; color: var(--gold-dark); }
.tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--line); margin-bottom: 1.25rem; flex-wrap: wrap; }
.tabs button { background: none; border: none; color: var(--muted); border-bottom: 3px solid transparent; border-radius: 0; padding: 0.65rem 0.95rem; }
.tabs button:hover { background: none; color: var(--ink); }
.tabs button[aria-selected="true"] { color: var(--brand); border-bottom-color: var(--brand); }
.meter { height: 10px; background: #e3e9f2; border-radius: 999px; overflow: hidden; margin: 0.4rem 0; }
.meter > span { display: block; height: 100%; background: linear-gradient(90deg, var(--brand), var(--cyan)); }
.stats { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); margin-bottom: 1.25rem; }
.stat { background: #fff; border: 1px solid var(--line); border-radius: var(--radius); padding: 1rem; box-shadow: var(--shadow); }
.stat b { display: block; font-size: 1.6rem; }
.files { list-style: none; padding: 0; margin: 1rem 0; }
.files li { margin: 0.4rem 0; }
.files a { display: flex; justify-content: space-between; gap: 1rem; padding: 0.75rem 0.9rem; background: #fff; border: 1px solid var(--line); border-radius: 9px; text-decoration: none; font-weight: 600; min-height: 44px; }
.files a:hover { border-color: var(--brand); }
.file-size { color: var(--muted); font-weight: 500; font-size: 0.9rem; }
.empty { color: var(--muted); padding: 1rem 0; }
#toast { position: fixed; bottom: 1.25rem; left: 50%; transform: translateX(-50%); max-width: 90vw; z-index: 50; }
#toast .notice { box-shadow: var(--shadow-lg); }
[hidden] { display: none !important; }

/* Landing page */
.hero { position: relative; overflow: hidden; background:
    radial-gradient(900px 420px at 85% 10%, rgba(25, 167, 230, 0.16), transparent 60%),
    radial-gradient(600px 360px at 10% 90%, rgba(245, 165, 36, 0.12), transparent 60%),
    linear-gradient(180deg, #ffffff, #eef4fc);
  border-bottom: 1px solid var(--line); }
.hero .bar { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); gap: 3rem; align-items: center; padding-top: 4rem; padding-bottom: 4.5rem; }
.hero h1 { font-size: 3rem; letter-spacing: -0.03em; margin-bottom: 1rem; }
.hero h1 .glow { background: linear-gradient(90deg, var(--brand), var(--cyan)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.hero .lead { font-size: 1.2rem; color: var(--muted); max-width: 36rem; }
.hero .actions { margin-top: 1.5rem; }
.hero .fine { margin-top: 1rem; font-size: 0.92rem; color: var(--muted); }
.hero-intro { display: block; width: min(460px, 100%); aspect-ratio: 16 / 9; margin: -3rem 0 -1.25rem -2rem; mix-blend-mode: multiply; }
.hero-intro img { display: block; width: 100%; height: auto; }
.auth-intro { display: block; width: 132px; height: 132px; margin: 0 auto; mix-blend-mode: multiply; }
.auth-intro img { display: block; width: 100%; height: auto; }
.hero-mark { width: 64px; height: 64px; border-radius: 16px; box-shadow: 0 6px 24px rgba(25, 167, 230, 0.35); margin-bottom: 1.25rem; }
.preview { background: #fff; border: 1px solid var(--line); border-radius: 16px; box-shadow: var(--shadow-lg); overflow: hidden; transform: perspective(1400px) rotateY(-4deg) rotateX(2deg); }
.preview-bar { display: flex; align-items: center; gap: 0.4rem; padding: 0.65rem 0.9rem; background: #f3f6fb; border-bottom: 1px solid var(--line); }
.preview-bar i { width: 10px; height: 10px; border-radius: 50%; background: #d3dbe7; display: inline-block; }
.preview-bar span { margin-left: 0.6rem; font-size: 0.8rem; color: var(--muted); background: #fff; border: 1px solid var(--line); border-radius: 6px; padding: 0.1rem 0.6rem; }
.preview-body { padding: 1.1rem 1.2rem 1.3rem; }
.preview-body h3 { font-size: 1.15rem; margin-bottom: 0.2rem; }
.preview-tabs { display: flex; gap: 1rem; border-bottom: 1px solid var(--line); margin: 0.8rem 0 0.4rem; font-size: 0.85rem; font-weight: 700; color: var(--muted); }
.preview-tabs b { color: var(--brand); border-bottom: 2px solid var(--brand); padding-bottom: 0.35rem; }
.preview-row { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; padding: 0.6rem 0; border-bottom: 1px solid var(--line); font-size: 0.88rem; }
.preview-row:last-child { border-bottom: none; }
.preview-row .mono { color: var(--brand); font-weight: 600; }
.slug-a { display: inline-flex; align-items: center; gap: 0.25rem; }
.slug-a svg { width: 0.78em; height: 0.78em; flex: none; opacity: 0.55; }
.slug-a:hover svg { opacity: 1; }
.preview-row small { display: block; color: var(--muted); }
.landing { padding-top: 0; }
.meter-sample { width: 2%; }
.section { padding: 3.5rem 0 1rem; }
.section-head { max-width: 40rem; margin-bottom: 1.5rem; }
.section-head h2 { font-size: 1.8rem; }
.way { display: flex; flex-direction: column; }
.way .icon { width: 44px; height: 44px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; background: #eaf1ff; color: var(--brand); margin-bottom: 0.8rem; }
.way .icon svg { width: 24px; height: 24px; }
.way pre { margin: auto 0 0; font-size: 0.8rem; white-space: pre-wrap; word-break: break-all; }
.feature h3 { display: flex; align-items: center; gap: 0.5rem; }
.feature h3::before { content: ""; width: 10px; height: 10px; border-radius: 3px; background: linear-gradient(135deg, var(--gold), #ffd36b); box-shadow: 0 0 10px rgba(245, 165, 36, 0.6); flex: none; }
.cta { margin: 3rem 0 1rem; background: radial-gradient(600px 300px at 90% 0%, rgba(25, 167, 230, 0.35), transparent 60%), linear-gradient(135deg, var(--navy), var(--navy-2)); color: #e7efff; border-radius: 20px; padding: 2.5rem; display: flex; justify-content: space-between; align-items: center; gap: 1.5rem; flex-wrap: wrap; box-shadow: var(--shadow-lg); }
.cta h2 { color: #fff; font-size: 1.7rem; margin: 0 0 0.3rem; }
.cta p { margin: 0; color: #b9c9e6; }
.cta .button.secondary { background: transparent; color: #fff; border-color: rgba(255, 255, 255, 0.4); }
.cta .button.secondary:hover { background: rgba(255, 255, 255, 0.1); }

/* Integration strip under the hero */
.strip { background: var(--navy); color: #b9c9e6; font-size: 0.9rem; }
.strip .bar { min-height: 52px; justify-content: center; gap: 0.5rem 2rem; padding-top: 0.5rem; padding-bottom: 0.5rem; }
.strip b { color: var(--gold); margin-right: 0.35rem; font-weight: 800; }

/* Section helpers */
.split-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 1rem; flex-wrap: wrap; }
.two-col { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.5rem; align-items: start; }
.lead-sm { font-size: 1.1rem; max-width: 46rem; }
.tile .icon { width: 42px; height: 42px; border-radius: 11px; display: inline-flex; align-items: center; justify-content: center; background: #eaf1ff; color: var(--brand); margin-bottom: 0.75rem; }
.tile .icon svg { width: 22px; height: 22px; }
.tile p:last-child { margin-bottom: 0; }
.checks { list-style: none; padding: 0; margin: 1rem 0 0; }
.checks li { position: relative; padding-left: 1.6rem; margin: 0.7rem 0; }
.checks li::before { content: ""; position: absolute; left: 0; top: 0.45rem; width: 10px; height: 10px; border-radius: 3px; background: linear-gradient(135deg, var(--gold), #ffd36b); box-shadow: 0 0 10px rgba(245, 165, 36, 0.6); }

/* Handoff flow */
.flow { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1.25rem; counter-reset: step; }
.flow-step { background: #fff; border: 1px solid var(--line); border-radius: var(--radius); padding: 1.25rem; box-shadow: var(--shadow); display: flex; flex-direction: column; }
.flow-step p { color: var(--muted); }
.step-num { width: 30px; height: 30px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--navy); color: var(--gold); font-weight: 800; margin-bottom: 0.7rem; }
.term { margin-top: auto; background: var(--navy); color: #dbe7ff; border-radius: 10px; overflow: hidden; font-size: 0.8rem; }
.term-bar { display: flex; gap: 0.35rem; padding: 0.5rem 0.7rem; background: #0e2747; }
.term-bar i { width: 8px; height: 8px; border-radius: 50%; background: #2c4a73; display: inline-block; }
.term code { display: block; padding: 0.7rem 0.8rem 0.85rem; white-space: pre-wrap; word-break: break-word; line-height: 1.55; }
.term b { color: var(--gold); }
.term .ok { color: #7ee2a8; }
.term .dim, .chat-card .dim { color: #7f95b8; }
.term .hl { color: var(--gold); }
.chat-card { margin-top: auto; border: 1px solid var(--line); border-radius: 10px; padding: 0.8rem; background: #fbfcfe; font-size: 0.9rem; }
.chat-card p { color: var(--ink); margin: 0.4rem 0 0.6rem; }
.chat-head { display: flex; gap: 0.5rem; align-items: center; font-size: 0.85rem; }
.chat-head .avatar { width: 24px; height: 24px; font-size: 0.75rem; }
.link-card { display: flex; gap: 0.7rem; align-items: center; border: 1px solid var(--line); border-left: 4px solid var(--cyan); border-radius: 8px; padding: 0.55rem 0.7rem; background: #fff; }
.link-card small { display: block; color: var(--muted); }
.link-icon { width: 30px; height: 30px; border-radius: 8px; background: #eaf1ff; color: var(--brand); display: inline-flex; align-items: center; justify-content: center; flex: none; }
.link-icon svg { width: 18px; height: 18px; }

/* Team card */
.team-card .member { display: flex; gap: 0.7rem; align-items: center; padding: 0.6rem 0; border-bottom: 1px solid var(--line); }
.team-card .member:last-child { border-bottom: none; }
.team-card small { display: block; color: var(--muted); }
.avatar.bot { background: linear-gradient(135deg, var(--gold), #ffcb5c); color: var(--navy); }

/* FAQ */
.faq { display: grid; gap: 0.75rem; }
.faq details { background: #fff; border: 1px solid var(--line); border-radius: var(--radius); padding: 0.9rem 1.1rem; box-shadow: var(--shadow); }
.faq summary { cursor: pointer; font-weight: 700; }
.faq details p { margin: 0.6rem 0 0; color: var(--muted); }

/* Agent guide steps */
.steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1.25rem; }
.step { display: flex; flex-direction: column; }
.step pre { margin-top: auto; }
.section h2 { font-size: 1.5rem; }
#guide .card > h2 { font-size: 2rem; }
#guide .card h3 { font-size: 1.5rem; }
.section > pre, .section .two-col pre, .section .card pre { font-size: 0.82rem; }
.section .card pre { margin-bottom: 0; }

/* Sign in */
.auth-head { text-align: center; margin: 1rem auto 2rem; max-width: 34rem; }
.auth-head > img { width: 72px; height: 72px; border-radius: 18px; box-shadow: 0 6px 24px rgba(25, 167, 230, 0.35); }
.auth-head h1 { margin-top: 1rem; }
.center-text { text-align: center; margin-top: 1.5rem; }
.auth-grid { display: grid; gap: 1.25rem; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); max-width: 880px; margin: 0 auto; }

/* Dashboard and admin header */
.dash-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 1.5rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
.dash-head h1 { margin: 0; }
.dash-head .usage { min-width: 260px; flex: 0 1 360px; background: #fff; border: 1px solid var(--line); border-radius: var(--radius); padding: 0.8rem 1rem; box-shadow: var(--shadow); }
.dash-head .usage p { margin: 0; }

@media (max-width: 900px) {
  .flow, .steps, .two-col { grid-template-columns: 1fr; }
  .grid-3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .hero .bar { grid-template-columns: 1fr; gap: 2rem; padding-top: 2.5rem; padding-bottom: 3rem; }
  .preview { transform: none; }
}
@media (max-width: 640px) {
  .top nav { display: contents; }
  .top .brand { order: 1; }
  .top nav .nav-account { order: 2; margin-left: auto; }
  .top nav .nav-pages { order: 3; flex-basis: 100%; margin-top: 0.15rem; }
  .top nav a, .top nav .link { padding: 0.4rem 0.55rem; }
  .top .bar { row-gap: 0.1rem; padding-bottom: 0.3rem; }
  .dash-head .usage { flex: 1 1 100%; }
  .tabs { flex-wrap: nowrap; gap: 0; margin-left: -1.25rem; margin-right: -1.25rem; padding: 0 0.3rem; }
  .tabs button { flex: 1 1 0; min-width: 0; padding: 0.55rem 0.1rem; font-size: 0.72rem; text-align: center; white-space: nowrap; }
  th, td { padding: 0.5rem 0.3rem; }
  table { font-size: 0.86rem; }
  .table-wrap { padding: 0.25rem 0.5rem; }
  .table-wrap td, .table-wrap td div, .table-wrap td .mono { overflow-wrap: anywhere; }
  /* Slim the hero bar on scroll only on small screens; wider bars have room for the wordmark plus links. */
  .top.is-hero.is-scrolled nav a:not(.button) { display: none; }
  .grid-3 { grid-template-columns: 1fr; }
  .hero h1 { font-size: 2.1rem; }
  .who span { display: none; }
  th.hide-sm, td.hide-sm { display: none; }
  .cta { padding: 1.75rem; }
}
@media (max-width: 480px) {
  /* Every bar stays on one line on a phone: tighter spacing, and the signed-in
     bar drops For Agents / Help (both are in the footer). */
  .top .bar { min-height: 52px; gap: 0.35rem; padding: 0 0.75rem; flex-wrap: nowrap; }
  .top nav { gap: 0; flex-wrap: nowrap; }
  .top nav a, .top nav .link { padding: 0.35rem 0.42rem; font-size: 0.84rem; min-height: 34px; }
  .top nav a.button { padding: 0.3rem 0.6rem; min-height: 34px; }
}
`;
