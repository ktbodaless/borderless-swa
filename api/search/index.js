// Azure Static Web Apps Function: /api/search  (CommonJS)
// Legal: Only public employer ATS endpoints (Greenhouse/Lever). No aggregators.
// Links point to canonical company pages.

const fetch = require('node-fetch');

// --------------- Sources (safe starter lists) ---------------
const GH_BOARDS = [
  // Greenhouse org slugs known to exist (keep curated; add more gradually)
  'coinbase','datadog','stripe','doordash','brex','asana','notion',
  'plaid','squarespace','robinhood','snowflake','rippling','samsara',
  'databricks','benchling','palantir','niantic'
];

const LV_TENANTS = [
  // Lever tenants known to exist
  'airtable','postman','vercel','figma','ramp','affirm','opendoor',
  'scaleai','linear','loom','snyk','webflow','zapier'
];

// --------------- Sponsorship detection ---------------
const POSITIVES = [
  /visa\s+sponsorship/i,
  /sponsorship\s+available/i,
  /\bwill\s+sponsor\b/i,
  /employer\s+sponsorship/i,
  /work\s+authorization\s+provided/i,
  /eligible\s+for\s+(a\s+)?work\s+visa/i,
  /h[-\s]?1b(\s+transfer)?/i, /\bh\s?1\s?b\b/i,
  /cap[-\s]?exempt/i, /\be[-\s]?3\b/i, /\btn\b/i, /\bo[-\s]?1\b/i,
  /green\s*card\s*sponsorship/i, /\bopt\b/i, /\bcpt\b/i, /stem\s*opt/i
];

const NEGATIVES = [
  /without\s+sponsorship/i,
  /no\s+visa\s+sponsorship/i,
  /not\s+(able|available)\s+to\s+sponsor/i,
  /must\s+be\s+authorized\s+to\s+work.*without/i,
  /now\s+or\s+in\s+the\s+future.*without/i,
  /c2c\s+only/i
];

function labelSponsorship(text) {
  const t = (text || '').toLowerCase();
  if (NEGATIVES.some(r => r.test(t))) return { ok: false, flags: [] };
  if (!POSITIVES.some(r => r.test(t))) return { ok: false, flags: [] };

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

  return { ok: true, flags: Array.from(new Set(flags)) };
}

const stripHtml = (h) => (h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

async function withLimit(items, limit, worker) {
  const out = []; let i = 0;
  const runner = async () => { while (i < items.length) { const idx = i++; out[idx] = await worker(items[idx], idx); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return out.flat().filter(Boolean);
}

// --------------- Greenhouse ---------------
async function fetchGreenhouseBoard(board) {
  const base = `https://boards-api.greenhouse.io/v1/boards/${board}`;
  const list = await fetch(`${base}/jobs`, { headers: { 'user-agent': 'BorderlessBot/1.0 (+jobs)' } });
  if (!list.ok) return [];
  const data = await list.json();
  const jobs = data.jobs || [];

  return await withLimit(jobs.slice(0, 80), 6, async (j) => {
    const r = await fetch(`${base}/jobs/${j.id}`, { headers: { 'user-agent': 'BorderlessBot/1.0 (+jobs)' } });
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
      title: j.title,
      city: city || null, state: state || null,
      remote,
      workMode: remote ? 'remote' : 'onsite',
      jobType: 'fulltime',
      flags,
      postedAt: j.updated_at || null,
      url: j.absolute_url,
      haystack: `${j.title} ${raw}`.toLowerCase()
    };
  });
}

// --------------- Lever ---------------
async function fetchLeverTenant(tenant) {
  const res = await fetch(`https://api.lever.co/v0/postings/${tenant}?mode=json`, { headers: { 'user-agent': 'BorderlessBot/1.0 (+jobs)' } });
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
      id: `${tenant}-lv-${j.id}`,
      source: 'lever',
      company: j.company || tenant,
      title: j.text,
      city: city || null, state: state || null,
      remote,
      workMode: remote ? 'remote' : 'onsite',
      jobType: jt,
      flags,
      postedAt: j.createdAt || null,
      url: j.hostedUrl,
      haystack: `${j.text} ${raw}`.toLowerCase()
    };
  }).filter(Boolean);
}

// --------------- Handler ---------------
module.exports = async function (context, req) {
  try {
    const q = (req.query.q || '').toLowerCase().trim();
    const posted = req.query.posted || '30d'; // default 30 days
    const mode = req.query.mode || 'any';
    const type = req.query.type || 'any';

    const [gh, lv] = await Promise.all([
      withLimit(GH_BOARDS, 3, fetchGreenhouseBoard),
      withLimit(LV_TENANTS, 3, fetchLeverTenant)
    ]);
    let items = [...gh, ...lv];

    // search filter
    let filtered = items;
    if (q) filtered = items.filter(j => j.haystack.includes(q) || (j.company || '').toLowerCase().includes(q));

    // posted window
    const now = Date.now();
    const days = posted === '24h' ? 1 : posted === '7d' ? 7 : posted === '30d' ? 30 : null;
    if (days) filtered = filtered.filter(j => j.postedAt ? (new Date(j.postedAt).getTime() >= now - days*86400000) : true);

    if (mode !== 'any') filtered = filtered.filter(j => j.workMode === mode);
    if (type !== 'any') filtered = filtered.filter(j => j.jobType === type);

    // smooth fallback: if a typed query yields 0, return most recent sponsorship roles
    if (q && filtered.length === 0) {
      filtered = items.filter(j => !!j.flags?.length);
    }

    // sort newest
    filtered.sort((a,b) => (new Date(b.postedAt||0)) - (new Date(a.postedAt||0)));
    // slim payload
    filtered = filtered.map(({ haystack, ...rest }) => rest);

    context.res = {
      headers: { 'content-type': 'application/json', 'cache-control':'public, max-age=300' },
      body: JSON.stringify({ items: filtered })
    };
  } catch (e) {
    context.res = { status: 500, body: JSON.stringify({ error: e.message }) };
  }
};
