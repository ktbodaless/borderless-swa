// Azure Functions (JavaScript) for Static Web Apps
// Route: /api/search
const fetch = require('node-fetch');

const GH_BOARDS = ['coinbase','datadog','stripe','asana','plaid','notion']; // keep small & fast
const LV_TENANTS = ['airtable','shopify','vercel','figma','postman'];

const POSITIVES = [
  /visa\s+sponsorship\s+available/i,
  /h[-\s]?1b(\s+transfer)?/i,
  /cap[-\s]?exempt/i,
  /e[-\s]?3/i,
  /\btn\b/i,
  /o[-\s]?1\b/i,
  /green\s*card\s*sponsorship/i,
  /\bopt\b/i,
  /\bcpt\b/i,
  /stem\s*opt/i
];
const NEGATIVES = [
  /without\s+sponsorship/i,
  /no\s+visa\s+sponsorship/i,
  /not\s+(able|available)\s+to\s+sponsor/i,
  /must\s+be\s+authorized\s+to\s+work.*without/i,
  /c2c\s+only/i
];

function labelSponsorship(text) {
  const t = (text || '').toLowerCase();
  if (NEGATIVES.some(r => r.test(t))) return { ok: false, flags: [] };
  const hits = POSITIVES.filter(r => r.test(t));
  if (!hits.length) return { ok: false, flags: [] };
  const flags = [];
  if (/h[-\s]?1b\s+transfer/i.test(t)) flags.push('H-1B transfer');
  if (/h[-\s]?1b(?!\s+transfer)/i.test(t)) flags.push('H-1B (new)');
  if (/cap[-\s]?exempt/i.test(t)) flags.push('H-1B cap-exempt');
  if (/e[-\s]?3/i.test(t)) flags.push('E-3');
  if (/\btn\b/.test(t)) flags.push('TN');
  if (/o[-\s]?1\b/i.test(t)) flags.push('O-1');
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

async function fetchGreenhouseBoard(board) {
  const base = `https://boards-api.greenhouse.io/v1/boards/${board}`;
  const list = await fetch(`${base}/jobs`);
  if (!list.ok) return [];
  const data = await list.json();
  const jobs = data.jobs || [];
  // fetch details with modest concurrency
  return await withLimit(jobs.slice(0, 60), 5, async (j) => {
    const r = await fetch(`${base}/jobs/${j.id}`);
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
      city: city || null,
      state: state || null,
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

async function fetchLeverTenant(tenant) {
  const res = await fetch(`https://api.lever.co/v0/postings/${tenant}?mode=json`);
  if (!res.ok) return [];
  const jobs = await res.json();
  return jobs.slice(0, 120).map((j) => {
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
      city: city || null,
      state: state || null,
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

module.exports = async function (context, req) {
  try {
    const q = (req.query.q || '').toLowerCase().trim();
    const posted = req.query.posted || null; // 24h | 7d | 30d
    const mode = req.query.mode || 'any';    // remote | onsite | any
    const type = req.query.type || 'any';    // fulltime | contract | any

    const [gh, lv] = await Promise.all([
      withLimit(GH_BOARDS, 3, fetchGreenhouseBoard),
      withLimit(LV_TENANTS, 3, fetchLeverTenant)
    ]);
    let items = [...gh, ...lv];

    if (q) items = items.filter(j => j.haystack.includes(q) || (j.company || '').toLowerCase().includes(q));

    const now = Date.now();
    const days = posted === '24h' ? 1 : posted === '7d' ? 7 : posted === '30d' ? 30 : null;
    if (days) items = items.filter(j => j.postedAt ? (new Date(j.postedAt).getTime() >= now - days*86400000) : true);

    if (mode !== 'any') items = items.filter(j => j.workMode === mode);
    if (type !== 'any') items = items.filter(j => j.jobType === type);

    items.sort((a,b) => (new Date(b.postedAt||0)) - (new Date(a.postedAt||0)));
    items = items.map(({ haystack, ...rest }) => rest);

    context.res = {
      headers: { 'content-type': 'application/json', 'cache-control':'public, max-age=300' },
      body: JSON.stringify({ items })
    };
  } catch (e) {
    context.res = { status: 500, body: JSON.stringify({ error: e.message }) };
  }
};
