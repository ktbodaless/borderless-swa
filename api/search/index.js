// Azure Static Web Apps Function: /api/search  (CommonJS)
// Legal: Only public employer ATS endpoints (Greenhouse/Lever). No aggregators.
// Links go to employer pages. Moderate concurrency. User-Agent set.

const fetch = require('node-fetch');

// --- Sources (curated; expand gradually) ---
const GH_BOARDS = [
  'coinbase','datadog','stripe','doordash','brex','asana','notion','plaid',
  'squarespace','robinhood','snowflake','rippling','benchling','palantir',
  'samsara','databricks','niantic'
];
const LV_TENANTS = [
  'airtable','postman','vercel','figma','ramp','affirm','opendoor','scaleai',
  'linear','loom','snyk','webflow','zapier'
];

// --- Sponsorship logic ---
const POS = [
  /visa\s+sponsorship/i, /sponsorship\s+available/i, /\bwill\s+sponsor\b/i,
  /employer\s+sponsorship/i, /work\s+authorization\s+provided/i,
  /eligible\s+for\s+(a\s+)?work\s+visa/i,
  /h[-\s]?1b(\s+transfer)?/i, /\bh\s?1\s?b\b/i,
  /cap[-\s]?exempt/i, /\be[-\s]?3\b/i, /\btn\b/i, /\bo[-\s]?1\b/i,
  /green\s*card\s*sponsorship/i, /\bopt\b/i, /\bcpt\b/i, /stem\s*opt/i
];
const NEG = [
  /without\s+sponsorship/i, /no\s+visa\s+sponsorship/i,
  /not\s+(able|available)\s+to\s+sponsor/i,
  /must\s+be\s+authorized\s+to\s+work.*without/i,
  /now\s+or\s+in\s+the\s+future.*without/i, /c2c\s+only/i
];

// returns {status: 'yes'|'no'|'unknown', flags:[]}
function sponsorshipStatus(text) {
  const t = (text || '').toLowerCase();
  if (NEG.some(r => r.test(t))) return { status: 'no', flags: [] };
  const matched = POS.some(r => r.test(t));
  if (!matched) return { status: 'unknown', flags: [] };

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
  return { status: 'yes', flags: Array.from(new Set(flags)) };
}

const UA = { headers: { 'user-agent': 'BorderlessBot/1.0 (+ATS only)' } };
const strip = (h)=> (h||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();

// salary parsing (very lightweight; USD only)
function parseSalary(text) {
  const t = (text || '').toLowerCase();
  // ranges like $120,000 - $180,000
  let m = t.match(/\$?\s?(\d{2,3}[,]?\d{3})\s*[-–]\s*\$?\s?(\d{2,3}[,]?\d{3})/);
  if (m) return { min: Number(m[1].replace(/,/g,'')), max: Number(m[2].replace(/,/g,'')), period:'year' };
  // single like $60/hr or $140,000
  m = t.match(/\$?\s?(\d{2,3}(?:[,]\d{3})?)(?:\s*\/?\s*(hour|hr|year|yr|annum))?/);
  if (m) {
    let val = Number(m[1].replace(/,/g,''));
    const per = m[2] || 'year';
    if (/hour|hr/.test(per)) val = Math.round(val * 2080); // ~annual
    return { min: val, max: val, period:'year' };
  }
  return null;
}

// experience parsing: "3+ years", "2 years"
function parseYears(text) {
  const m = (text || '').toLowerCase().match(/(\d{1,2})\s*\+?\s*(?:years|yrs)/);
  return m ? Number(m[1]) : null;
}

function workModeFrom(text, loc){
  const t=(text||'').toLowerCase() + ' ' + (loc||'').toLowerCase();
  if (/\bhybrid\b/.test(t)) return 'hybrid';
  if (/\bremote\b/.test(t)) return 'remote';
  return 'onsite';
}

// tiny concurrency helper
async function withLimit(items, limit, worker){
  const out=[]; let i=0;
  const run=async()=>{ while(i<items.length){ const idx=i++; out[idx]=await worker(items[idx],idx); } };
  await Promise.all(Array.from({length:Math.min(limit,items.length)}, run));
  return out.flat().filter(Boolean);
}

// --- Greenhouse ---
async function fetchGreenhouseBoard(board){
  const base=`https://boards-api.greenhouse.io/v1/boards/${board}`;
  const list=await fetch(`${base}/jobs`, UA);
  if (!list.ok) return [];
  const jobs=(await list.json()).jobs||[];
  return await withLimit(jobs.slice(0,100), 6, async (j)=>{
    const r=await fetch(`${base}/jobs/${j.id}`, UA);
    if(!r.ok) return null;
    const full=await r.json();
    const raw=strip(full.content||'');
    const desc = `${j.title} ${raw}`;
    const { status, flags } = sponsorshipStatus(desc);
    // keep all; we'll filter by sponsor param later
    const loc=(j.location?.name||'').trim(); const [city,state]=loc.split(',').map(s=>s.trim());
    const workMode = workModeFrom(desc, loc);
    const salary = parseSalary(desc);
    const years = parseYears(desc);
    return {
      id:`${board}-gh-${j.id}`, ats:'greenhouse',
      company:j?.absolute_url?.split('/')?.[3] || board,
      title:j.title, city:city||null, state:state||null,
      workMode, jobType:'fulltime',
      sponsor: status, flags,
      salaryMin: salary?.min || null, salaryMax: salary?.max || null,
      yearsMin: years,
      postedAt:j.updated_at||null, url:j.absolute_url,
      haystack: desc.toLowerCase()
    };
  });
}

// --- Lever ---
async function fetchLeverTenant(tenant){
  const res=await fetch(`https://api.lever.co/v0/postings/${tenant}?mode=json`, UA);
  if(!res.ok) return [];
  const jobs=await res.json();
  return jobs.slice(0,160).map(j=>{
    const raw=strip(j.description||''); const desc=`${j.text} ${raw}`;
    const { status, flags } = sponsorshipStatus(desc);
    const loc=(j.categories?.location||'').trim(); const [city,state]=loc.split(',').map(s=>s.trim());
    const workMode = workModeFrom(desc, loc);
    const jt=(j?.categories?.commitment||'').toLowerCase().includes('contract')?'contract':(/part[-\s]?time/.test(desc)?'parttime':'fulltime');
    const salary = parseSalary(desc);
    const years = parseYears(desc);
    return {
      id:`${tenant}-lv-${j.id}`, ats:'lever',
      company:j.company||tenant, title:j.text,
      city:city||null, state:state||null,
      workMode, jobType:jt,
      sponsor: status, flags,
      salaryMin: salary?.min || null, salaryMax: salary?.max || null,
      yearsMin: years,
      postedAt:j.createdAt||null, url:j.hostedUrl,
      haystack: desc.toLowerCase()
    };
  }).filter(Boolean);
}

// fuzzy helpers
const STOP=new Set(["a","an","the","and","or","of","in","for","to","on","with","by"]);
const toks=s=>(s||"").toLowerCase().split(/[^a-z0-9+]+/).filter(t=>t && !STOP.has(t));
function lev(a,b){const m=a.length,n=b.length,dp=Array.from({length:m+1},(_,i)=>Array(n+1).fill(0));
  for(let i=0;i<=m;i++)dp[i][0]=i; for(let j=0;j<=n;j++)dp[0][j]=j;
  for(let i=1;i<=m;i++)for(let j=1;j<=n;j++)dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+(a[i-1]==b[j-1]?0:1));
  return dp[m][n];}
function fuzzyContains(text,qTok){ if(!qTok) return false; const t=text.toLowerCase();
  if(t.includes(qTok)) return true; const words=t.split(/[^a-z0-9+]+/).filter(Boolean);
  const maxEd=qTok.length<=6?1:2; return words.some(w=>Math.abs(w.length-qTok.length)<=maxEd && lev(w,qTok)<=maxEd); }
function score(job,q){
  if(!q) return 0.2;
  const title=(job.title||"").toLowerCase(), hay=(job.haystack||"").toLowerCase();
  const phrase=q.toLowerCase().trim(); let s=0;
  if(phrase && title.includes(phrase)) s+=6; if(phrase && hay.includes(phrase)) s+=3;
  for(const t of toks(q)){ if(t.length<3) continue;
    if(title.includes(t)) s+=3; else if(hay.includes(t)) s+=1.5;
    else if(fuzzyContains(title,t)) s+=2.2; else if(fuzzyContains(hay,t)) s+=0.8; }
  if(job.flags?.length) s+=0.5;
  if(job.postedAt){ const days=Math.max(0,(Date.now()-new Date(job.postedAt).getTime())/86400000); s += Math.max(0,1-(days/60))*2; }
  return s;
}

module.exports = async function (context, req){
  try{
    const q=(req.query.q||'').trim();
    const posted=req.query.posted||'30d';
    const mode=(req.query.mode||'any').toLowerCase();           // remote|onsite|hybrid|any
    const type=(req.query.type||'any').toLowerCase();           // fulltime|contract|parttime|any
    const sponsor=(req.query.sponsor||'yes').toLowerCase();     // yes|no|any
    const ats=(req.query.ats||'any').toLowerCase();             // greenhouse|lever|any
    const minSalary = Number(req.query.minSalary||0);
    const minYears = Number(req.query.minYears||0);
    const companyQ = (req.query.company||'').toLowerCase();
    const cityQ = (req.query.city||'').toLowerCase();

    const [gh,lv]=await Promise.all([ withLimit(GH_BOARDS,3,fetchGreenhouseBoard), withLimit(LV_TENANTS,3,fetchLeverTenant) ]);
    let items=[...gh,...lv];

    // deduplicate: company+title+city+state (keep newest)
    const dedup = new Map();
    for (const j of items){
      const key = `${(j.company||'').toLowerCase()}|${(j.title||'').toLowerCase()}|${j.city||''}|${j.state||''}`;
      const prev = dedup.get(key);
      if (!prev || (new Date(j.postedAt||0) > new Date(prev.postedAt||0))) dedup.set(key, j);
    }
    items = Array.from(dedup.values());

    // posted window
    const now=Date.now(); const d=posted==='24h'?1:posted==='7d'?7:posted==='30d'?30:null;
    if(d) items=items.filter(j=> j.postedAt ? (new Date(j.postedAt).getTime() >= now - d*86400000) : true);

    // filters
    if(mode!=='any') items=items.filter(j=>j.workMode===mode);
    if(type!=='any') items=items.filter(j=>j.jobType===type);
    if(sponsor!=='any') items=items.filter(j=>j.sponsor===sponsor);
    if(ats!=='any') items=items.filter(j=>j.ats===ats);
    if(minSalary>0) items=items.filter(j=> (j.salaryMin||0) >= minSalary);
    if(minYears>0) items=items.filter(j=> (j.yearsMin||0) >= minYears);
    if(companyQ) items=items.filter(j=> (j.company||'').toLowerCase().includes(companyQ));
    if(cityQ) items=items.filter(j=> ((j.city||'')+' '+(j.state||'')).toLowerCase().includes(cityQ));

    // ranking
    const scored=items.map(j=>({j,s:score(j,q)})).sort((a,b)=>b.s-a.s);
    let out=scored.map(x=>x.j);

    // fallback if query too strict
    if(q && scored.slice(0,12).every(x=>x.s<1)){
      out=items.filter(j=>j.sponsor==='yes').sort((a,b)=> (new Date(b.postedAt||0))-(new Date(a.postedAt||0)));
    }

    // slim payload
    out = out.slice(0,300).map(({haystack, ...rest}) => rest);

    context.res={ headers:{'content-type':'application/json','cache-control':'public, max-age=300'}, body:JSON.stringify({items:out}) };
  }catch(e){
    context.res={ status:500, body:JSON.stringify({error:e.message}) };
  }
};
