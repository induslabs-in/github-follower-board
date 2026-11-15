// collect.mjs: the daily count of a GitHub follower board (https://github.com/induslabs-in/github-follower-board).
// For every public repository of one GitHub organisation or user it counts followers, stars, watchers, forks and
// visitors, keeps the history in data/history.json (GitHub itself forgets visitor numbers after 14 days) and writes
// README.md and charts/*.svg. Runs once a day in GitHub Actions (.github/workflows/daily.yml). Node 18 or newer,
// no packages.
//
// Settings come from the environment:
//   ORG             the organisation or user to count
//   GITHUB_TOKEN    any token: public numbers only
//   TRAFFIC_TOKEN   optional read-only key with "Administration: read" on the owner's repositories: visitor
//                   numbers (GitHub shows them only to people who can change a repository)
//   BOARD_REPO      owner/name of the board itself, left out of the list
//   BOARD_TIMEZONE  optional time zone for dates on the page, such as Asia/Kolkata or Europe/Berlin (default UTC)
//   BOARD_TITLE     optional name at the top of the page (default: the owner's display name, else its login)
//   OUT_DIR         where data/, charts/ and README.md live (default: this script's folder)
//   GITHUB_OUTPUT   set by GitHub Actions: the counted day is handed to the workflow as "day"
//   GITHUB_API, NOW test switches (a stand-in API address, the time to count as "now")

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORG = (process.env.ORG || '').trim();
const TOKEN = (process.env.GITHUB_TOKEN || '').trim();
const TRAFFIC = (process.env.TRAFFIC_TOKEN || '').trim();
const BOARD_REPO = (process.env.BOARD_REPO || '').trim().toLowerCase();
const API = (process.env.GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
const OUT = path.resolve(process.env.OUT_DIR || path.dirname(fileURLToPath(import.meta.url)));
const NOW = process.env.NOW ? new Date(process.env.NOW) : new Date();
if (!ORG) { console.error('STOPPED: ORG is not set'); process.exit(1); }
if (Number.isNaN(NOW.getTime())) { console.error('STOPPED: NOW is not a time'); process.exit(1); }

const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- dates (in BOARD_TIMEZONE; a day key is YYYY-MM-DD in that zone) ----------
const TZ = (process.env.BOARD_TIMEZONE || '').trim() || 'UTC';
let ZONE;
try {
  ZONE = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
} catch {
  console.error(`STOPPED: BOARD_TIMEZONE is not a time zone name: ${TZ} (examples: UTC, Asia/Kolkata, Europe/Berlin)`);
  process.exit(1);
}
const INDIA = /^Asia\/(Kolkata|Calcutta)$/i.test(TZ);
const NUM_LOCALE = INDIA ? 'en-IN' : 'en-US';
function zoneParts(d) { const o = {}; for (const p of ZONE.formatToParts(d)) o[p.type] = p.value; return o; }
const dayKeyOf = (d) => { const o = zoneParts(d); return `${o.year}-${o.month}-${o.day}`; };
const keyToMs = (k) => Date.parse(k + 'T00:00:00Z');
const msToKey = (ms) => new Date(ms).toISOString().slice(0, 10);
function shortDate(k) { const d = new Date(keyToMs(k)); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]; }
function stampOf(d) {
  const o = zoneParts(d);
  let h = Number(o.hour) % 24;
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${Number(o.day)} ${MONTHS[Number(o.month) - 1]} ${o.year}, ${h}:${o.minute} ${ap} ${INDIA ? 'IST' : o.timeZoneName}`;
}

// ---------- GitHub API ----------
async function call(url, token, accept) {
  const headers = { Accept: accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'github-follower-board' };
  if (token) headers.Authorization = 'Bearer ' + token;
  let last = null;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
      if (res.status >= 500) { last = new Error(`GitHub answered ${res.status} for ${url}`); await sleep(3000 * (i + 1)); continue; }
      return res;
    } catch (e) { last = e; await sleep(3000 * (i + 1)); }
  }
  throw last;
}
function nextLink(h) {
  if (!h) return null;
  const part = h.split(',').map((s) => s.trim()).find((s) => /rel="next"/.test(s));
  return part ? part.slice(part.indexOf('<') + 1, part.indexOf('>')) : null;
}
async function failText(res, what) { let t = ''; try { t = (await res.text()).slice(0, 200); } catch { /* none */ } return `GitHub answered ${res.status} for ${what}: ${t}`; }
async function getJSON(p, opts = {}) {
  const res = await call(API + p, opts.token === undefined ? TOKEN : opts.token, opts.accept);
  if (!res.ok) throw new Error(await failText(res, p));
  return res.json();
}
async function getAll(p, opts = {}) {
  const cap = opts.cap || 10000;
  let url = API + p + (p.includes('?') ? '&' : '?') + 'per_page=100';
  const out = [];
  while (url && out.length < cap) {
    const res = await call(url, opts.token === undefined ? TOKEN : opts.token, opts.accept);
    if (!res.ok) throw new Error(await failText(res, p));
    const page = await res.json();
    if (!Array.isArray(page)) throw new Error('unexpected answer for ' + p);
    out.push(...page);
    url = nextLink(res.headers.get('link'));
  }
  return out;
}

// ---------- history ----------
function loadHistory() {
  const f = path.join(OUT, 'data', 'history.json');
  let h = null;
  if (fs.existsSync(f)) h = JSON.parse(fs.readFileSync(f, 'utf8'));
  h = h || {};
  for (const k of ['days', 'traffic', 'window', 'referrers', 'stars', 'meta']) if (!h[k] || typeof h[k] !== 'object') h[k] = {};
  if (!h.followers || typeof h.followers !== 'object') h.followers = {};
  if (!h.followers.firstSeen) h.followers.firstSeen = {};
  if (!Array.isArray(h.followers.current)) h.followers.current = [];
  h.version = 1;
  h.owner = ORG;
  return h;
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]); return o; }
  return v;
}

// ---------- visitor numbers (needs TRAFFIC_TOKEN) ----------
async function traffic(full, key) {
  const get = async (p) => {
    const res = await call(`${API}/repos/${full}/traffic/${p}`, TRAFFIC);
    const exp = res.headers.get('github-authentication-token-expiration');
    if (exp) key.expires = exp;
    if (res.status === 401 || res.status === 403) {
      key.state = 'refused';
      key.message = `GitHub refused the visitor key (answer ${res.status}): it has expired, been deleted, or lacks "Administration: read"`;
      return null;
    }
    if (!res.ok) throw new Error(await failText(res, `traffic/${p} of ${full}`));
    return res.json();
  };
  const views = await get('views?per=day'); if (!views) return null;
  const clones = await get('clones?per=day'); if (!clones) return null;
  const refs = await get('popular/referrers'); if (!refs) return null;
  return { views, clones, refs };
}

// ---------- charts ----------
// Each chart is drawn once and saved twice, NAME.svg (light) and NAME-dark.svg. The README shows the one that
// matches the reader's GitHub theme through a <picture> element. (A media query inside one SVG follows the
// computer's setting instead, which leaves near-white text on GitHub's light theme on a dark-mode computer.)
const FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif';
const COMMON = `text{font-family:${FONT};font-size:12px}.muted{fill:#898781}.num{font-variant-numeric:tabular-nums}`;
const THEMES = {
  light: COMMON + '.ink{fill:#0b0b0b}.ink2{fill:#52514e}.grid{stroke:#e1e0d9}.base{stroke:#c3c2b7}.ring{stroke:#ffffff}.s1{stroke:#2a78d6}.f1{fill:#2a78d6}.s2{stroke:#eb6834}.f2{fill:#eb6834}',
  dark: COMMON + '.ink{fill:#f0efec}.ink2{fill:#c3c2b7}.grid{stroke:#2c2c2a}.base{stroke:#383835}.ring{stroke:#0d1117}.s1{stroke:#3987e5}.f1{fill:#3987e5}.s2{stroke:#d95926}.f2{fill:#d95926}',
};
const STYLE_SLOT = '/*theme*/';
export function themed(svg) { return { light: svg.replace(STYLE_SLOT, THEMES.light), dark: svg.replace(STYLE_SLOT, THEMES.dark) }; }
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r1 = (n) => Math.round(n * 10) / 10;
function niceStep(raw) {
  if (raw <= 1) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}
function axisFor(maxV) {
  const m = Math.max(1, maxV);
  const step = Math.max(1, Math.round(niceStep(m / 4)));
  const top = Math.ceil(m / step) * step;
  const ticks = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return { top, ticks };
}
function xLabelKeys(keys, max = 5) {
  if (keys.length <= max) return keys;
  const out = [];
  for (let i = 0; i < max; i++) out.push(keys[Math.round((i * (keys.length - 1)) / (max - 1))]);
  return [...new Set(out)];
}
function svgOpen(w, h, label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title><style>${STYLE_SLOT}</style>`;
}
function yAxis(parts, ticks, y, left, right) {
  for (const v of ticks) {
    const yy = r1(y(v));
    parts.push(`<line class="${v === 0 ? 'base' : 'grid'}" x1="${left}" x2="${right}" y1="${yy}" y2="${yy}" stroke-width="1"/>`);
    parts.push(`<text class="muted num" x="${left - 8}" y="${r1(yy + 4)}" text-anchor="end">${v}</text>`);
  }
}
function xAxis(parts, keys, x, y0) {
  const labels = xLabelKeys(keys);
  labels.forEach((k, i) => {
    const anchor = labels.length === 1 ? 'middle' : i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle';
    parts.push(`<text class="muted" x="${r1(x(k))}" y="${y0 + 20}" text-anchor="${anchor}">${shortDate(k)}</text>`);
  });
}
// series: [{ name, cls: 1|2, points: [{ k: 'YYYY-MM-DD', v }] }]
export function lineChart(series, label, w = 760, h = 280) {
  const m = { l: 44, r: 124, t: series.length > 1 ? 40 : 20, b: 34 };
  const W = w - m.l - m.r, H = h - m.t - m.b;
  const keys = [...new Set(series.flatMap((s) => s.points.map((p) => p.k)))].sort();
  const t0 = keyToMs(keys[0]), t1 = keyToMs(keys[keys.length - 1]);
  const { top, ticks } = axisFor(Math.max(...series.flatMap((s) => s.points.map((p) => p.v))));
  const x = (k) => m.l + (t1 === t0 ? W / 2 : ((keyToMs(k) - t0) / (t1 - t0)) * W);
  const y = (v) => m.t + H - (v / top) * H;
  const parts = [svgOpen(w, h, label)];
  if (series.length > 1) {
    let lx = m.l;
    for (const s of series) {
      parts.push(`<line class="s${s.cls}" x1="${lx}" x2="${lx + 16}" y1="14" y2="14" stroke-width="2" stroke-linecap="round"/>`);
      parts.push(`<text class="ink2" x="${lx + 22}" y="18">${esc(s.name)}</text>`);
      lx += 30 + s.name.length * 7 + 24;
    }
  }
  yAxis(parts, ticks, y, m.l, m.l + W);
  xAxis(parts, keys, x, m.t + H);
  const ends = [];
  for (const s of series) {
    const pts = [...s.points].sort((a, b) => (a.k < b.k ? -1 : 1));
    if (pts.length > 1) parts.push(`<path class="s${s.cls}" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" d="${pts.map((p, i) => (i ? 'L' : 'M') + r1(x(p.k)) + ' ' + r1(y(p.v))).join(' ')}"/>`);
    const last = pts[pts.length - 1];
    parts.push(`<circle class="f${s.cls} ring" cx="${r1(x(last.k))}" cy="${r1(y(last.v))}" r="4" stroke-width="2"/>`);
    ends.push({ y: y(last.v) + 4, x: x(last.k) + 10, text: `${s.name} ${last.v}` });
  }
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 15) ends[i].y = ends[i - 1].y + 15;
  for (const e of ends) parts.push(`<text class="ink num" x="${r1(e.x)}" y="${r1(e.y)}" font-weight="600">${esc(e.text)}</text>`);
  parts.push('</svg>');
  return parts.join('');
}
// points: [{ k, v }] for consecutive days
export function barChart(points, label, w = 760, h = 220) {
  const m = { l: 44, r: 16, t: 16, b: 34 };
  const W = w - m.l - m.r, H = h - m.t - m.b;
  const { top, ticks } = axisFor(Math.max(...points.map((p) => p.v)));
  const n = points.length;
  const slot = W / n;
  const bw = Math.max(2, slot - 2);
  const x = (k) => { const i = points.findIndex((p) => p.k === k); return m.l + i * slot + slot / 2; };
  const y = (v) => m.t + H - (v / top) * H;
  const parts = [svgOpen(w, h, label)];
  yAxis(parts, ticks, y, m.l, m.l + W);
  points.forEach((p, i) => {
    if (p.v <= 0) return;
    const x0 = m.l + i * slot + (slot - bw) / 2, x1 = x0 + bw;
    const yt = y(p.v), yb = m.t + H;
    const rr = Math.min(4, bw / 2, yb - yt);
    parts.push(`<path class="f1" d="M${r1(x0)} ${r1(yb)}V${r1(yt + rr)}Q${r1(x0)} ${r1(yt)} ${r1(x0 + rr)} ${r1(yt)}H${r1(x1 - rr)}Q${r1(x1)} ${r1(yt)} ${r1(x1)} ${r1(yt + rr)}V${r1(yb)}Z"/>`);
  });
  xAxis(parts, points.map((p) => p.k), x, m.t + H);
  parts.push('</svg>');
  return parts.join('');
}

// ---------- README ----------
const fmt = (n) => (n === null || n === undefined ? '-' : Number(n).toLocaleString(NUM_LOCALE));
const signed = (n) => (n > 0 ? `+${n}` : String(n));
function totalStars(day) { return Object.values(day.repos || {}).reduce((a, r) => a + (r.stars || 0), 0); }
function totalWatchers(day) { return Object.values(day.repos || {}).reduce((a, r) => a + (r.watchers || 0), 0); }
function plural(n, one, many) { return `${fmt(n)} ${n === 1 ? one : many}`; }

function render(hist, today, key, repoNames) {
  const dayKeys = Object.keys(hist.days).sort();
  const cur = hist.days[today];
  const weekAgo = msToKey(keyToMs(today) - 7 * DAY);
  const base = [...dayKeys].reverse().find((k) => k <= weekAgo) || dayKeys[0];
  const prev = hist.days[base];
  const visitorsOn = key.state === 'ok';
  const fresh = (r) => visitorsOn && hist.window[r] && hist.window[r].asOf === today;
  const vis14 = repoNames.reduce((a, r) => a + (fresh(r) ? hist.window[r].uniques : 0), 0);
  const stars = totalStars(cur);

  const L = [];
  L.push(`# ${hist.title} on GitHub`, '');
  const head = [plural(cur.followers, 'follower', 'followers'), plural(stars, 'star', 'stars'), plural(totalWatchers(cur), 'watcher', 'watchers')];
  if (visitorsOn) head.push(plural(vis14, 'visitor', 'visitors') + ' in 14 days');
  L.push(`**${head.join(' · ')}**`, '');
  if (base !== today) {
    const span = Math.round((keyToMs(today) - keyToMs(base)) / DAY);
    L.push(`Since ${shortDate(base)} (${span === 7 ? 'one week' : span === 1 ? 'yesterday' : span + ' days'}): ${signed(cur.followers - prev.followers)} followers, ${signed(stars - totalStars(prev))} stars.`, '');
  } else {
    L.push('First count today; the change from day to day starts tomorrow.', '');
  }

  const charts = [];
  // followers (from the daily counts) and stars (from the date of every star)
  const allStars = repoNames.flatMap((r) => (hist.stars[r] || []).map((s) => s.at)).filter(Boolean).map((a) => dayKeyOf(new Date(a))).sort();
  const startKey = [dayKeys[0], allStars[0]].filter(Boolean).sort()[0];
  if (startKey && startKey < today) {
    const fol = dayKeys.map((k) => ({ k, v: hist.days[k].followers }));
    const st = [];
    for (let t = keyToMs(startKey); t <= keyToMs(today); t += DAY) {
      const k = msToKey(t);
      st.push({ k, v: allStars.filter((s) => s <= k).length });
    }
    charts.push({ file: 'growth', title: 'Followers and stars', alt: 'Followers and stars, day by day', svg: themed(lineChart([{ name: 'Followers', cls: 1, points: fol }, { name: 'Stars', cls: 2, points: st }], 'Followers and stars, day by day')) });
  }
  // visitors per day, last 60 days
  const perDay = {};
  for (const r of repoNames) for (const [k, v] of Object.entries(hist.traffic[r] || {})) perDay[k] = (perDay[k] || 0) + (v.uniques || 0);
  const tKeys = Object.keys(perDay).sort();
  if (tKeys.length && Object.values(perDay).some((v) => v > 0)) {
    const endMs = keyToMs(tKeys[tKeys.length - 1]);
    const startMs = Math.max(keyToMs(tKeys[0]), endMs - 59 * DAY);
    const pts = [];
    for (let t = startMs; t <= endMs; t += DAY) pts.push({ k: msToKey(t), v: perDay[msToKey(t)] || 0 });
    if (pts.length < 14) { const pad = []; for (let t = startMs - (14 - pts.length) * DAY; t < startMs; t += DAY) pad.push({ k: msToKey(t), v: 0 }); pts.unshift(...pad); }
    charts.push({ file: 'visitors', title: 'Visitors per day', alt: 'Visitors per day (a person who opened two projects counts twice)', svg: themed(barChart(pts, 'Visitors per day')) });
  }
  for (const c of charts) L.push(`**${c.title}**`, '', `<picture><source media="(prefers-color-scheme: dark)" srcset="charts/${c.file}-dark.svg"><img alt="${esc(c.alt)}" src="charts/${c.file}.svg"></picture>`, '');
  if (!charts.length) L.push('_The charts start once there are two days of numbers._', '');

  L.push('## Projects', '');
  if (!repoNames.length) {
    L.push('No public projects yet. Each project shows here the day after it is published.', '');
  } else {
    const rows = repoNames.map((r) => {
      const d = cur.repos[r];
      const p = prev && prev.repos && prev.repos[r];
      const w = fresh(r) ? hist.window[r] : null;
      return { r, d, ds: p ? d.stars - p.stars : null, w };
    }).sort((a, b) => b.d.stars - a.d.stars || (b.w ? b.w.uniques : 0) - (a.w ? a.w.uniques : 0) || a.r.localeCompare(b.r));
    L.push('| Project | Stars | Watchers | Forks | Visitors, 14 days | Views, 14 days |', '|---|--:|--:|--:|--:|--:|');
    for (const x of rows) {
      const url = (hist.meta[x.r] && hist.meta[x.r].url) || `https://github.com/${ORG}/${x.r}`;
      const st = fmt(x.d.stars) + (x.ds ? ` (${signed(x.ds)})` : '');
      L.push(`| [${x.r}](${url}) | ${st} | ${fmt(x.d.watchers)} | ${fmt(x.d.forks)} | ${x.w ? fmt(x.w.uniques) : '-'} | ${x.w ? fmt(x.w.views) : '-'} |`);
    }
    L.push('');
  }

  if (visitorsOn) {
    const refs = {};
    for (const r of repoNames) for (const s of hist.referrers[r] || []) {
      const e = refs[s.site] || (refs[s.site] = { site: s.site, uniques: 0, views: 0 });
      e.uniques += s.uniques; e.views += s.views;
    }
    const top = Object.values(refs).sort((a, b) => b.uniques - a.uniques || b.views - a.views).slice(0, 10);
    if (top.length) {
      L.push('## Where visitors came from (last 14 days)', '', '| Site | Visitors | Views |', '|---|--:|--:|');
      for (const s of top) L.push(`| ${esc(s.site)} | ${fmt(s.uniques)} | ${fmt(s.views)} |`);
      L.push('');
    }
  }

  const since = keyToMs(today) - 7 * DAY;
  const news = [];
  for (const r of repoNames) for (const s of hist.stars[r] || []) if (s.at && Date.parse(s.at) >= since && s.login) news.push({ at: dayKeyOf(new Date(s.at)), text: `[@${s.login}](https://github.com/${s.login}) starred ${r}` });
  for (const login of hist.followers.current) {
    const f = hist.followers.firstSeen[login];
    if (f && f !== 'start' && keyToMs(f) >= since) news.push({ at: f, text: `[@${login}](https://github.com/${login}) followed` });
  }
  if (news.length) {
    news.sort((a, b) => (a.at < b.at ? 1 : -1));
    L.push('## New this week', '');
    for (const n of news.slice(0, 10)) L.push(`- ${n.text} (${shortDate(n.at)})`);
    if (news.length > 10) L.push(`- and ${news.length - 10} more`);
    L.push('');
  }

  let keyLine;
  if (key.state === 'ok') keyLine = key.expires ? `visitor numbers on (the key expires ${esc(key.expires)})` : 'visitor numbers on';
  else if (key.state === 'refused') keyLine = `visitor numbers stopped: ${esc(key.message)}`;
  else keyLine = 'visitor numbers off: no visitor key saved yet';
  L.push('---', '', `<sub>Updated ${stampOf(NOW)} · counted once a day on GitHub · ${keyLine}</sub>`, '');
  return { readme: L.join('\n'), charts };
}

// ---------- main ----------
async function main() {
  const hist = loadHistory();
  const owner = await getJSON(`/users/${ORG}`);
  hist.title = (process.env.BOARD_TITLE || '').trim() || owner.name || owner.login || ORG;
  let repos = owner.type === 'Organization'
    ? await getAll(`/orgs/${ORG}/repos?type=public&sort=full_name`)
    : await getAll(`/users/${ORG}/repos?type=owner&sort=full_name`);
  repos = repos.filter((r) => !r.private && r.full_name.toLowerCase() !== BOARD_REPO);
  const followers = await getAll(`/users/${ORG}/followers`, { cap: 5000 });

  const today = dayKeyOf(NOW);
  const firstRun = Object.keys(hist.days).length === 0;
  const key = { state: TRAFFIC ? 'ok' : 'none', expires: null, message: '' };
  const day = { followers: owner.followers, repos: {} };
  for (const r of repos) {
    const d = await getJSON(`/repos/${r.full_name}`);
    day.repos[r.name] = { stars: d.stargazers_count, watchers: d.subscribers_count, forks: d.forks_count, issues: d.open_issues_count };
    hist.meta[r.name] = { url: d.html_url, description: d.description || '', created: d.created_at, archived: !!d.archived };
    hist.stars[r.name] = d.stargazers_count > 0
      ? (await getAll(`/repos/${r.full_name}/stargazers`, { accept: 'application/vnd.github.star+json', cap: 5000 })).map((s) => ({ login: s.user && s.user.login, at: s.starred_at }))
      : [];
    if (key.state === 'ok') {
      const t = await traffic(r.full_name, key);
      if (t) {
        const tr = hist.traffic[r.name] || (hist.traffic[r.name] = {});
        for (const v of t.views.views || []) { const k = v.timestamp.slice(0, 10); tr[k] = { ...(tr[k] || {}), views: v.count, uniques: v.uniques }; }
        for (const c of t.clones.clones || []) { const k = c.timestamp.slice(0, 10); tr[k] = { ...(tr[k] || {}), clones: c.count, cloneUniques: c.uniques }; }
        hist.window[r.name] = { views: t.views.count, uniques: t.views.uniques, clones: t.clones.count, cloneUniques: t.clones.uniques, asOf: today };
        hist.referrers[r.name] = (t.refs || []).map((x) => ({ site: x.referrer, views: x.count, uniques: x.uniques }));
      }
    }
  }
  const logins = followers.map((f) => f.login).filter(Boolean);
  for (const l of logins) if (!hist.followers.firstSeen[l]) hist.followers.firstSeen[l] = firstRun ? 'start' : today;
  hist.followers.current = logins;
  hist.days[today] = day;
  hist.key = { ...key, checked: NOW.toISOString() };
  hist.lastRun = NOW.toISOString();

  const repoNames = repos.map((r) => r.name).sort();
  const { readme, charts } = render(hist, today, key, repoNames);
  fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'charts'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'data', 'history.json'), JSON.stringify(sortKeys(hist), null, 1) + '\n');
  const keep = new Set(charts.flatMap((c) => [c.file + '.svg', c.file + '-dark.svg']));
  for (const f of fs.readdirSync(path.join(OUT, 'charts'))) if (f.endsWith('.svg') && !keep.has(f)) fs.unlinkSync(path.join(OUT, 'charts', f));
  for (const c of charts) {
    fs.writeFileSync(path.join(OUT, 'charts', c.file + '.svg'), c.svg.light + '\n');
    fs.writeFileSync(path.join(OUT, 'charts', c.file + '-dark.svg'), c.svg.dark + '\n');
  }
  fs.writeFileSync(path.join(OUT, 'README.md'), readme);
  const stars = totalStars(day);
  console.log(`Counted ${ORG} on ${today}: ${day.followers} followers, ${repoNames.length} public projects, ${stars} stars; visitor numbers: ${key.state}${key.expires ? ' (key expires ' + key.expires + ')' : ''}`);
  if (key.state === 'refused') console.log('WARNING: ' + key.message);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `day=${today}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error('STOPPED: ' + (e && e.message ? e.message : e)); process.exit(1); });
