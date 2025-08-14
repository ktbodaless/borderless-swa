// Azure Static Web Apps Function: /api/search  (CommonJS)
// Legal: Only public employer ATS endpoints (Greenhouse/Lever). No aggregators.
// All links point to the employer's own posting.

const fetch = require('node-fetch');

// --- Source lists (curated; add more over time) ---
const GH_BOARDS = [
  'coinbase','datadog','stripe','doordash','brex','asana','notion','plaid',
  'squarespace','robinhood','snowflake','rippling','benchling','palantir',
  'samsara','databricks','niantic'
];

const LV_TENANTS = [
  'airtable','postman','vercel','figma','ramp','affirm','opendoor','scaleai',
  'linear','loom','snyk','webflow','zapier'
];

// --- Sponsorship detection (explicit only) ---
const POSITIVES = [
  /visa\s+sponsorship/i, /sponsorship\s+available/i, /\bwill\s+sponsor\b/i,
  /employer\s+sponsorship/i, /work\s+authorization\s+provided/i,
  /eligible\s+for\s+(a\s+)?work\s+visa/i,
  /h[-\s]?1b(\s+transfer)?/i, /\bh\s?1\s?b\b/i,
  /cap[-\s]?exempt/i, /\be[-\s]?3\b/i, /\btn\b/i, /\bo[-\s]?1\b/i,
  /green\s*card\s*sponsorship/i, /\bopt\b/i, /\bcpt\b/i, /stem\s*opt/i
];
const NEGATIVES = [
  /without\s+sponsorship/i, /no\s+visa\s+sponsorship/i,
  /not\s+(able|available)\s+to\s+sponsor/i,
  /must\s+be\s+authorized\s+to\s+work.*without/i,
  /now\s+or\s+in\s+the\s+future.*without/i, /c2c\s+only/i
];
function labelSponsorship(text) {
  const t = (text || '').toLowerCase();
  if (NEGATIVES.some(r => r.test(t))) return { ok:false, flags:[] };
  if (!POSITIVES.some(r => r.test(t))) return { ok:false, flags:[] };

  const flags = [];
  if (/h[-\s]?1b\s+transfer/.test(t)) flags.push('H-1B transfer');
  if (/\bh[-\s]?1b\b/.test(t) || /\bh\s?1\s?b\b/.test(t)) flags.push('H-1B (new)');
  if (/cap[-\s]?exempt/.test(t)) flags.push('H-1B cap-exempt');
  if (/\be[-\s]?3\b/.test(t)) flags.push('E-3');
  if (/\btn\b/.test(t)) flags.push('TN');
  if (/\bo[-\s]?1\b/.test(t)) flags.push('O-1');
  if (/green\s*card/.test(t)) flags.push('GC sponsor');
  if (/\bopt\b/.test(t)) flags.push('OPT-friendly');
  if (/\bcpt\b/.test(t)) flags.push('CPT-friendly');
  return { ok:true, flags:[...new Set(flags)] };
}

const stripHtml = (h) => (h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// --- small concurrency helper ---
async function withLimit(items, limit, worker) {
  const out = []; let i = 0;
  const runner = async () => { while (i < items.length) { const idx = i++; out[idx] = await worker(items[idx], idx); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return out.flat().filter(Boolean);
}

// --- ATS fetchers ---
async function fetchGreenhouseBoard(board) {
  const base = `https://boards-api.greenhouse.io/v1/boards/${board}`;
  const list = await fetch(`${base}/jobs`, { headers:{'user-agent':'BorderlessBot/1.0'} });
  if (!list.ok) return [];
  const data = await list.json();
  const jobs = data.jobs || [];
  return await withLimit(jobs.slice(0, 80), 6, async (j) => {
    const r = await fetch(`${base}/jobs/${j.id}`, { headers:{'user-agent':'BorderlessBot/1.0'} });
    if (!r.ok) return null;
    const full = await r.json();
    const raw = stripHtml(full.content || '');
    const { ok, flags } = labelSponsorship(raw);
    if (!ok) return null;

    const loc = (j.location?.name || '').trim();
    const [city, state] = loc.split(',').map(s => s.trim());
    const remote = /remote/i.test(loc);

    return {
      id: `${board}-gh-${j.id}`,
      source: 'greenhouse',
      company: j?.absolute_url?.split('/')?.[3] || board,
      title: j.title, city: city || null, state: state || null,
      remote, workMode: remote ? 'remote' : 'onsite', jobType: 'fulltime',
      flags, postedAt: j.updated_at || null, url: j.absolute_url,
      haystack: `${j.title} ${raw}`.toLowerCase()
    };
  });
}
async function fetchLeverTenant(tenant) {
  const res = await fetch(`https://api.lever.co/v0/postings/${tenant}?mode=json`, { headers:{'user-agent':'BorderlessBot/1.0'} });
  if (!res.ok) return [];
  const jobs = await res.json();
  return jobs.slice(0, 150).map((j) => {
    const raw = stripHtml(j.description || '');
    const { ok, flags } = labelSponsorship(raw);
    if (!ok) return null;
    const loc = (j.categories?.location || '').trim();
    const [city, state] = loc.split(',').map(s => s.trim());
    const remote = /remote/i.test(loc);
    const jt = (j?.categories?.commitment || '').toLowerCase().includes('contract') ? 'contract' : 'fulltime';
    return {
      id: `${tenant}-lv-${j.id}`, source: 'lever',
      company: j.company || tenant, title: j.text,
      city: city || null, state: state || null,
      remote, workMode: remote ? 'remote' : 'onsite', jobType: jt,
      flags, postedAt: j.createdAt || null, url: j.hostedUrl,
      haystack: `${j.text} ${raw}`.toLowerCase()
    };
  }).filter(Boolean);
}

// --- fuzzy helpers ---
const STOP = new Set(["a","an","the","and","or","of","in","for","to","on","with","by"]);
function tokens(s) { return (s||"").toLowerCase().split(/[^a-z0-9+]+/).filter(t => t && !STOP.has(t)); }
function lev(a,b){ // tiny Levenshtein
  const m=a.length,n=b.length; const dp=Array.from({length:m+1},(_,i)=>Array(n+1).fill(0));
  for(let i=0;i<=m;i++)dp[i][0]=i; for(let j=0;j<=n;j++)dp[0][j]=j;
  for(let i=1;i<=m;i++)for(let j=1;j<=n;j++){
    dp[i][j]=Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+(a[i-1]==b[j-1]?0:1));
  }
  return dp[m][n];
}
function fuzzyContains(text, qTok){
  if (!qTok) return false;
  const t = text.toLowerCase();
  if (t.includes(qTok)) return true;
  const words = t.split(/[^a-z0-9+]+/).filter(Boolean);
  for (const w of words) {
    const maxEd = qTok.length <= 6 ? 1 : 2;
    if (Math.abs(w.length - qTok.length) <= maxEd && lev(w, qTok) <= maxEd) return true;
  }
  return false;
}
function scoreJob(job, q) {
  if (!q) return 0.1; // if no query, mild score to allow recency sorting
  const qTokens = tokens(q);
  const title = (job.title || "").toLowerCase();
  const hay = (job.haystack || "").toLowerCase();

  let s = 0;
  const phrase = q.toLowerCase().trim();
  if (phrase && title.includes(phrase)) s += 6;
  if (phrase && hay.includes(phrase)) s += 3;

  for (const t of qTokens) {
    if (t.length < 3) continue;
    if (title.includes(t)) s += 3;
    else if (hay.includes(t)) s += 1.5;
    else if (fuzzyContains(title, t)) s += 2.2;
    else if (fuzzyContains(hay, t)) s += 0.8;
  }

  // small boosts
  if (job.flags?.length) s += 0.5; // sponsorship signals
  if (/analyst|analytics|analysis/.test(title) && /business/.test(phrase)) s += 1.2;
  if (/business/.test(title) && /analyst|analytics/.test(phrase)) s += 1.0;

  // recency boost (≤ 60 days)
  if (job.postedAt) {
    const days = Math.max(0, (Date.now() - new Date(job.postedAt).getTime()) / 86400000);
    const rec = Math.max(0, 1 - (days / 60)); // 0..1
    s += rec * 2;
  }
  return s;
}

module.exports = async function (context, req) {
  try {
    const q = (req.query.q || '').trim();
    const posted = req.query.posted || '30d';
    const mode = req.query.mode || 'any';
    const type = req.query.type || 'any';

    const [gh, lv] = await Promise.all([
      withLimit(GH_BOARDS, 3, fetchGreenhouseBoard),
      withLimit(LV_TENANTS, 3, fetchLeverTenant)
    ]);
    let items = [...gh, ...lv];

    // posted window
    const now = Date.now();
    const days = posted === '24h' ? 1 : posted === '7d' ? 7 : posted === '30d' ? 30 : null;
    if (days) items = items.filter(j => j.postedAt ? (new Date(j.postedAt).getTime() >= now - days*86400000) : true);
    if (mode !== 'any') items = items.filter(j => j.workMode === mode);
    if (type !== 'any') items = items.filter(j => j.jobType === type);

    // fuzzy relevance
    const scored = items.map(j => ({ j, s: scoreJob(j, q) }));
    scored.sort((a,b) => b.s - a.s);
    let out = scored.map(x => x.j);

    // if a query was provided and the top few scores are tiny, show a recent sponsorship fallback
    if (q && scored.slice(0, 10).every(x => x.s < 1)) {
      out = items.filter(j => j.flags?.length);
      out.sort((a,b) => (new Date(b.postedAt||0)) - (new Date(a.postedAt||0)));
    }

    // trim payload
    out = out.map(({ haystack, ...rest }) => rest);

    context.res = {
      headers: { 'content-type': 'application/json', 'cache-control':'public, max-age=300' },
      body: JSON.stringify({ items: out })
    };
  } catch (e) {
    context.res = { status: 500, body: JSON.stringify({ error: e.message }) };
  }
};
