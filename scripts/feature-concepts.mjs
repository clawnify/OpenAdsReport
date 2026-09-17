// Editorial UI illustrations of existing capabilities. These are recreated
// HTML/SVG panels, not application screenshots or proposed product screens.
// Numbers come from the app's own sample data (src/server/sample.ts), so the
// illustrations and the preview mode tell the same story.
import { readFileSync } from 'node:fs';

const logo = name => `data:image/svg+xml;base64,${readFileSync(new URL(`../public/logos/${name}.svg`, import.meta.url)).toString('base64')}`;
const platform = id => `<span class="platform"><img src="${logo(id === 'meta' ? 'meta' : 'google-ads')}" alt="">${id === 'meta' ? 'META' : 'GOOGLE'}</span>`;
const bar = (value, max, tone) => `<span class="bar"><i class="${tone}" style="width:${Math.min(100, (value / max) * 100).toFixed(0)}%"></i></span>`;
const toneOf = roas => (roas < 1 ? 'bad' : roas < 2.5 ? 'warn' : 'good');
const download = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/></svg>';
const sheetIcon = '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="2" width="18" height="20" rx="3" fill="#1E8E4E"/><path d="M7 8h10v9H7zM7 11h10M7 14h10M11 8v9" fill="none" stroke="#fff" stroke-width="1.4"/></svg>';
const appIcon = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M9 9v11"/></svg>';
const arrow = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5"/></svg>';
// Pointer cursor, hotspot at its top-left tip. White keyline keeps it legible on any fill.
const pointer = (x, y) => `<svg class="cursor" style="left:${x}px;top:${y}px" width="40" height="52" viewBox="0 0 20 26" aria-hidden="true"><path d="M1.5 1.5v19.5l5-4.6 3.4 7.6 3.6-1.6-3.3-7.4h6.9Z" fill="#1A202C" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

export const conceptStyles = `
.concept{--tone:#f3d3d8;--deep:#b8404f;background:#f7f1ee;color:#1a202c}
.concept.account-audit{--tone:#f1dcc6;--deep:#9a5b1e;background:#f6f0e8}
.concept.spreadsheet-to-app{--tone:#d8e8dc;--deep:#2f6b47;background:#eff3ee}
.concept:before{content:"";position:absolute;left:690px;top:150px;width:900px;height:740px;background:radial-gradient(ellipse,var(--tone),transparent 69%);filter:blur(12px)}
.concept:after{content:"";position:absolute;width:880px;height:100px;left:640px;top:860px;background:radial-gradient(ellipse,#3a2a2a22,transparent 65%);filter:blur(25px);z-index:0}
.concept .brand{right:80px;top:58px;color:#3b3033;font-size:19px}.concept .brand img{width:31px;height:31px}
.concept .eyebrow{top:70px;left:80px;letter-spacing:1.8px;font-size:15px;color:var(--deep)}
.concept .copy{position:absolute;left:80px;top:287px;width:560px;z-index:2}
.concept .copy h1{position:static;margin:0;font-size:74px;line-height:1.04;letter-spacing:-3.4px;font-weight:650;white-space:pre-line}
.concept .copy p{font-size:25px;line-height:1.5;color:#6b6264;max-width:450px;margin:28px 0 0}
.ui{position:absolute;z-index:2;background:#fff;border:1px solid #ffffffdf;border-radius:24px;box-shadow:0 2px 3px #3a202508,0 15px 32px -15px #3a202530,0 45px 70px -38px #3a202550;overflow:hidden;font-size:22px;line-height:1.4}
.ui h2,.ui h3,.ui p{margin:0}.ui h2{font-size:30px;line-height:1.2;letter-spacing:-.7px;font-weight:650}.ui h3{font-size:23px;letter-spacing:-.3px;font-weight:600}
.muted{color:#64748b}.small{font-size:17px}.row{display:flex;align-items:center;gap:14px}.between{display:flex;align-items:center;justify-content:space-between;gap:16px}
.ui .label{font-size:14px;letter-spacing:1.6px;text-transform:uppercase;color:#475569;font-weight:600}
.tnum{font-variant-numeric:tabular-nums}
.platform{display:inline-flex;align-items:center;gap:8px;font-size:14px;letter-spacing:1.6px;color:#475569}.platform img{width:20px;height:20px;object-fit:contain}
.bar{display:inline-block;width:92px;height:7px;border-radius:7px;background:#eef0f3;overflow:hidden;vertical-align:middle}.bar i{display:block;height:100%;border-radius:7px}
.bar .bad{background:#b91c1c}.bar .warn{background:#b45309}.bar .good{background:#2f7a55}
.bad-text{color:#b91c1c}.warn-text{color:#b45309}.good-text{color:#047857}
.pill{display:inline-flex;align-items:center;gap:8px;font-size:15px;font-weight:600;border-radius:7px;padding:6px 11px;white-space:nowrap}
.pill.bad{background:#fef2f2;color:#b91c1c}.pill.warn{background:#fffbeb;color:#b45309}.pill.good{background:#ecfdf5;color:#047857}
.cursor{position:absolute;z-index:6;filter:drop-shadow(0 3px 5px #0003)}

/* 01 portfolio */
.portfolio-ui{left:660px;top:205px;width:800px;padding:30px 0 12px;transform:rotate(-2.5deg)}
.portfolio-ui .head{padding:0 32px 22px}
.pf-row{display:grid;grid-template-columns:1.5fr 1.1fr 1.5fr 1fr;align-items:center;padding:17px 32px;border-top:1px solid #eef0f3;font-size:21px}
.pf-row.cols{font-size:13px;letter-spacing:1.6px;color:#475569;font-weight:600;padding-top:14px;padding-bottom:14px}
.pf-row .num{text-align:right}.pf-row .roas{display:flex;align-items:center;gap:12px}
.issue-ui{left:930px;top:680px;width:540px;padding:24px 28px 26px 34px;transform:rotate(2.5deg);z-index:4}
.issue-ui:before{content:"";position:absolute;left:0;top:0;bottom:0;width:6px;background:#b91c1c}
.issue-ui .meta{font-size:16px;color:#475569;margin:8px 0 14px}.issue-ui p{font-size:19px;line-height:1.45}.issue-ui strong{font-weight:650}

/* 02 audit */
.audit-ui{left:655px;top:185px;width:760px;padding:30px 34px 34px;transform:rotate(-2.5deg)}
.score{display:flex;align-items:baseline;gap:6px}.score strong{font-size:92px;line-height:1;letter-spacing:-4px;font-weight:650}.score span{font-size:28px;color:#94a3b8}
.cat{display:grid;grid-template-columns:1fr 120px 60px;align-items:center;gap:14px;padding:15px 0;border-top:1px solid #eef0f3;font-size:21px}
.cat .meter{height:8px;border-radius:8px;background:#eef0f3;overflow:hidden}.cat .meter i{display:block;height:100%}
.cat.worst{background:#fef2f2;margin:0 -34px;padding:15px 34px}
.cat b{font-weight:600;text-align:right}
.start{margin-left:12px;font-size:13px;font-weight:650;letter-spacing:1.3px;text-transform:uppercase;color:#b91c1c}
.fixes-ui{left:960px;top:664px;width:520px;padding:24px 28px;transform:rotate(2.5deg);z-index:4}
.fix{display:grid;grid-template-columns:52px 1fr;gap:12px;margin-top:16px;font-size:18px;line-height:1.4}
.prio{font-size:14px;font-weight:700;border-radius:6px;padding:4px 0;text-align:center;background:#1a202c;color:#fff;height:fit-content}
.fix .stake{display:block;color:#b91c1c;font-weight:600;font-size:16px;margin-top:3px}
.pdf-btn{display:inline-flex;align-items:center;gap:8px;height:44px;padding:0 16px;border-radius:8px;font-size:17px;font-weight:550;background:#f1f5f9;border:1px solid #cbd5e1;color:#1a202c;box-shadow:inset 0 2px 3px #0f172a14}

/* 03 spreadsheet to app (reads at 800px wide: large type, few rows) */
.spreadsheet-to-app .copy{top:250px;width:620px}
.spreadsheet-to-app .copy h1{font-size:70px}
.spreadsheet-to-app .copy p{max-width:520px}
.switch{position:absolute;left:80px;top:610px;display:flex;align-items:center;gap:14px;font-size:22px;color:#475569;z-index:3}
.switch .opt{display:inline-flex;align-items:center;gap:10px;padding:12px 20px;border-radius:999px}
.switch .opt.on{background:#fff;color:#1a202c;font-weight:600;box-shadow:0 0 0 1px #e2e8f0,0 8px 20px -10px #1a202c40}
.sheet-ui{left:720px;top:128px;width:760px;padding:0;transform:rotate(-2deg);border-radius:18px;font-family:Arial,Helvetica,sans-serif}
.sheet-top{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid #e3e3e3;font-size:19px}
.fx{display:flex;gap:12px;padding:10px 20px;border-bottom:1px solid #e3e3e3;font-size:17px;color:#444}.fx em{color:#999;font-style:italic}
.grid{display:grid;grid-template-columns:40px 190px 110px 90px 120px 100px 1fr;font-size:18px}
.grid span{border-right:1px solid #e6e6e6;border-bottom:1px solid #e6e6e6;padding:9px 10px;white-space:nowrap;overflow:hidden}
.grid .h{background:#f3f3f3;color:#777;text-align:center;font-size:14px;padding:5px}
.grid .b{font-weight:700}.grid .r{text-align:right}.grid .err{color:#c5221f;background:#fce8e6}.grid .sel{outline:2px solid #1a73e8;outline-offset:-2px}
.tabs{display:flex;gap:4px;padding:8px 12px;background:#f8f8f8;font-size:15px;color:#666}.tabs span{padding:6px 12px;border-radius:6px}.tabs .on{background:#e6f4ea;color:#137333;font-weight:700}
.app-ui{left:620px;top:552px;width:860px;padding:0;transform:rotate(1.5deg);z-index:4}
.app-head{display:flex;align-items:center;justify-content:space-between;padding:20px 28px;border-bottom:1px solid #eef0f3}
.app-head .name{display:flex;align-items:center;gap:12px;font-size:22px;font-weight:650}.app-head img{width:34px;height:34px;border-radius:9px}
.seg{display:flex;background:#f1f5f9;border-radius:9px;padding:4px;font-size:16px;color:#475569}.seg span{padding:6px 12px;border-radius:6px}.seg .on{background:#fff;color:#1a202c;box-shadow:0 1px 2px #0002}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;padding:16px 28px 10px}
.kpi{border:1px solid #e2e8f0;border-radius:12px;padding:10px 16px}.kpi .label{font-size:12px}.kpi strong{display:block;font-size:26px;letter-spacing:-.8px;margin-top:2px}
.app-row{display:grid;grid-template-columns:1.3fr 1fr 1fr;align-items:center;padding:9px 28px;border-top:1px solid #eef0f3;font-size:20px}
.app-row .num{text-align:right}.app-row .roas{display:flex;align-items:center;gap:12px}
.fresh{padding:8px 28px 14px;font-size:15px;color:#64748b}

/* covers */
.cover-ads{color:#1a202c}.cover-ads:before{content:"";position:absolute;left:520px;top:160px;width:1000px;height:830px;background:radial-gradient(ellipse,#f3d3d8,transparent 70%)}
.cover-ads .cover-brand{left:80px;top:67px;gap:14px}.cover-ads .cover-brand img{width:46px;height:46px;border-radius:12px}.cover-ads .cover-brand h1{font-size:34px;letter-spacing:-1px}
.cover-ads .hero-copy{position:absolute;left:80px;top:300px;width:520px}.hero-copy h2{font-size:74px;line-height:1.04;letter-spacing:-3.4px;font-weight:650;margin:0;white-space:pre-line}.hero-copy p{font-size:24px;line-height:1.5;color:#6b6264;margin:28px 0 0;max-width:430px}
.cover-ads .frame{left:630px;top:190px;width:900px;height:600px;border:0;border-radius:20px;transform:rotate(-2.5deg);box-shadow:0 2px 3px #3a202508,0 20px 40px -16px #3a202530,0 45px 70px -38px #3a202550}
.cover-ads .issue-ui{left:1010px;top:740px;width:480px}
.cover-ads .hero-meta{position:absolute;left:80px;bottom:74px;color:#b8404f;font-size:16px;letter-spacing:.2px}
.cover-ads.dark{color:#f1eeee}.cover-ads.dark:before{background:radial-gradient(ellipse,#4a2a31,transparent 70%)}.cover-ads.dark .hero-copy p{color:#b9adb0}.cover-ads.dark .hero-meta{color:#e48c98}
.cover-ads.dark .frame{box-shadow:0 0 0 1px #3a3034,0 30px 70px -30px #000a}
.cover-ads.dark .issue-ui{background:#2a2326;border-color:#40363a;color:#f1eeee;box-shadow:0 0 0 1px #40363a,0 20px 35px -18px #000a}.cover-ads.dark .issue-ui .meta,.cover-ads.dark .platform{color:#b9adb0}
`;

// Top issue for the lowest-ROAS sample account, as the Portfolio View words it.
export const renderIssue = () => `<section class="ui issue-ui" aria-label="Conceptual top issue to fix"><div class="between"><h3>Cinder Gaming</h3>${platform('meta')}</div><p class="meta tnum">Spend $4.2K · ROAS <span class="bad-text">0.6x</span></p><p><strong>Campaigns are deep underwater.</strong> Pause the bottom three ad sets and consolidate budget into the best audience.</p></section>`;

const accounts = [
  ['Cinder Gaming', 'meta', 0.6, '$4,150.8', '$296.5'],
  ['Drift Apparel', 'google', 0.9, '$2,980.5', '$198.7'],
  ['Pulse Retail', 'meta', 1.4, '$6,720.8', '$98.8'],
  ['Nova SaaS', 'google', 2.1, '$8,910.2', '$141.4'],
  ['Vertex Finance', 'google', 3.8, '$12,420.6', '$42.1'],
];

const categories = [
  ['Conversion tracking', 80, 'warn', false],
  ['Wasted spend', 39, 'bad', true],
  ['Impression coverage', 47, 'bad', false],
  ['Ad creative quality', 62, 'warn', false],
  ['Quality Score', 67, 'warn', false],
  ['Bidding strategy', 40, 'bad', false],
];

const concepts = {
  portfolio: () => `<section class="ui portfolio-ui" aria-label="Conceptual portfolio table">
    <div class="between head"><div><h2>Portfolio</h2><p class="small muted">10 accounts · last 30 days</p></div><span class="pill warn tnum">ROAS 2.3x</span></div>
    <div class="pf-row cols"><span>ACCOUNT</span><span>PLATFORM</span><span>ROAS</span><span class="num">COST</span></div>
    ${accounts.map(([name, p, roas, cost]) => `<div class="pf-row"><span>${name}</span>${platform(p)}<span class="roas tnum"><span class="${toneOf(roas)}-text">${roas.toFixed(1)}x</span>${bar(roas, 5, toneOf(roas))}</span><span class="num tnum">${cost}</span></div>`).join('')}
  </section>${renderIssue()}`,
  'account-audit': () => `<section class="ui audit-ui" aria-label="Conceptual account audit scorecard">
    <div class="between"><div><span class="label">Account Audit</span><h2 style="margin-top:6px">Vertex Finance</h2><p class="small muted" style="margin-top:4px">${platform('google')}</p></div><div class="score tnum"><strong>58</strong><span>/100</span></div></div>
    <div style="margin-top:18px">${categories.map(([name, score, tone, worst]) => `<div class="cat${worst ? ' worst' : ''}"><span>${name}${worst ? ' <span class="start">← start here</span>' : ''}</span><span class="meter"><i class="${tone}" style="width:${score}%;background:${tone === 'bad' ? '#b91c1c' : '#b45309'}"></i></span><b class="tnum ${tone}-text">${score}</b></div>`).join('')}</div>
  </section><section class="ui fixes-ui" aria-label="Conceptual priority fixes with PDF download"><div class="between"><h3>Priority fixes</h3><span class="pdf-btn">${download}Download PDF</span></div>
    <div class="fix"><span class="prio">P0</span><span>Raise budgets on campaigns losing 15% of impressions to caps.<span class="stake tnum">$2,851 at stake</span></span></div>
    <div class="fix"><span class="prio">P0</span><span>Add the top 6 zero-conversion search terms as exact negatives.<span class="stake tnum">$1,928 at stake</span></span></div>
  </section>${pointer(1436, 730)}`,
  'spreadsheet-to-app': () => `<div class="switch"><span class="opt">${sheetIcon}Your spreadsheet</span>${arrow}<span class="opt on">${appIcon}Your team’s app</span></div>
  <section class="ui sheet-ui" aria-label="Conceptual weekly Google Ads report spreadsheet">
    <div class="sheet-top">${sheetIcon}<strong>Google Ads report</strong><span class="muted" style="font-size:16px">pasted from export, Monday</span></div>
    <div class="fx"><em>fx</em><span>=D4/B4</span></div>
    <div class="grid">
      <span class="h"></span><span class="h">A</span><span class="h">B</span><span class="h">C</span><span class="h">D</span><span class="h">E</span><span class="h">F</span>
      <span class="h">1</span><span class="b">Account</span><span class="b r">Cost</span><span class="b r">Conv.</span><span class="b r">Revenue</span><span class="b r">ROAS</span><span></span>
      <span class="h">2</span><span>Drift Apparel</span><span class="r">2,980.50</span><span class="r">15</span><span class="r">2,682</span><span class="r">0.90</span><span></span>
      <span class="h">3</span><span>Acme E-commerce</span><span class="r">4,220.10</span><span class="r">27</span><span class="r">5,064</span><span class="r">1.20</span><span></span>
      <span class="h">4</span><span>Orbit Travel</span><span class="r"></span><span class="r">30</span><span class="r">5,457</span><span class="r err sel">#DIV/0!</span><span></span>
      <span class="h">5</span><span>Vertex Finance</span><span class="r">12,420.60</span><span class="r">295</span><span class="r">47,198</span><span class="r">3.80</span><span></span>
    </div>
    <div class="tabs"><span>Week 36</span><span class="on">Week 37</span><span>Week 37 (copy)</span></div>
  </section>
  <section class="ui app-ui" aria-label="Conceptual OpenAdsReport portfolio view">
    <div class="app-head"><span class="name"><img src="__ICON__" alt="">OpenAdsReport</span><span class="seg"><span>Account View</span><span class="on">Portfolio View</span><span>Reports</span></span></div>
    <div class="kpis"><div class="kpi"><span class="label">Total spend</span><strong class="tnum">$53,955</strong></div><div class="kpi"><span class="label">ROAS</span><strong class="tnum">2.3x</strong></div><div class="kpi"><span class="label">CPA</span><strong class="tnum">$76.1</strong></div></div>
    ${[['Drift Apparel', 0.9, '$2,980.5'], ['Orbit Travel', 1.6, '$3,410.3'], ['Vertex Finance', 3.8, '$12,420.6']].map(([name, roas, cost]) => `<div class="app-row"><span class="row" style="gap:12px">${name}</span><span class="roas tnum"><span class="${toneOf(roas)}-text">${roas.toFixed(1)}x</span>${bar(roas, 5, toneOf(roas))}</span><span class="num tnum">${cost}</span></div>`).join('')}
    <div class="fresh tnum">Synced 2 hours ago · data through Sep 16</div>
  </section>`,
};

export function renderConcept(id, iconUri) {
  if (!Object.hasOwn(concepts, id)) throw new Error(`Unknown feature concept: ${id}`);
  return concepts[id]().replaceAll('__ICON__', iconUri);
}
