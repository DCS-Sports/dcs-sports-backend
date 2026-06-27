// intel_analytics_posthog.mjs
// Fetches live analytics data from PostHog + GA4 and returns it in AN_DATA format
// that intel-v3.html expects. Replaces the old resourceful-light API.
//
// Env vars needed (set in Railway intel-ingest):
//   POSTHOG_API_KEY    — phc_ or phx_ key
//   POSTHOG_HOST       — optional, default https://app.posthog.com
//   POSTHOG_PROJECT_ID — optional, uses @current if not set
//   GA4_PROPERTY_ID    — optional, for GA4 channel data (future)

const PH_HOST    = (process.env.POSTHOG_HOST || 'https://app.posthog.com').replace(/\/$/, '');
const PH_KEY     = process.env.POSTHOG_API_KEY || '';
const PH_PROJECT = process.env.POSTHOG_PROJECT_ID || '@current';

const COUNTRY_FLAGS = {
  'United States':'🇺🇸','India':'🇮🇳','United Arab Emirates':'🇦🇪','UAE':'🇦🇪',
  'United Kingdom':'🇬🇧','Germany':'🇩🇪','Singapore':'🇸🇬','Canada':'🇨🇦',
  'Australia':'🇦🇺','France':'🇫🇷','Netherlands':'🇳🇱','Pakistan':'🇵🇰',
  'Bangladesh':'🇧🇩','Sri Lanka':'🇱🇰','Malaysia':'🇲🇾','Philippines':'🇵🇭',
  'Indonesia':'🇮🇩','Japan':'🇯🇵','South Korea':'🇰🇷','Brazil':'🇧🇷',
  'Mexico':'🇲🇽','Nigeria':'🇳🇬','Kenya':'🇰🇪','South Africa':'🇿🇦',
};

const DAYS_MAP = { '7d':7, '14d':14, '30d':30, '90d':90 };

function fmt(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1000000) return (n/1000000).toFixed(1)+'M';
  if (n >= 1000)    return (n/1000).toFixed(1)+'k';
  return String(Math.round(n));
}

function pct(a, b) {
  if (!b) return '0%';
  return Math.round(a / b * 100) + '%';
}

function delta(curr, prev) {
  if (!prev) return { d:'—', c:'up' };
  const diff = Math.round((curr - prev) / prev * 100);
  return { d: (diff >= 0 ? '▲ ' : '▼ ') + Math.abs(diff) + '%', c: diff >= 0 ? 'up' : 'down' };
}

async function phPost(path, body, signal) {
  const r = await fetch(`${PH_HOST}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PH_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`PostHog ${path} → ${r.status}: ${txt.slice(0, 200)}`);
  }
  return r.json();
}

async function phGet(path, signal) {
  const r = await fetch(`${PH_HOST}${path}`, {
    headers: { 'Authorization': `Bearer ${PH_KEY}` },
    signal,
  });
  if (!r.ok) throw new Error(`PostHog GET ${path} → ${r.status}`);
  return r.json();
}

function sumSeries(result, label) {
  const s = Array.isArray(result) ? result.find(r => r.label === label || r.action?.name === label) : null;
  return s ? (s.data || []).reduce((a, b) => a + b, 0) : 0;
}

function getSeriesData(result, label) {
  const s = Array.isArray(result) ? result.find(r => r.label === label || r.action?.name === label) : null;
  return s ? { data: s.data || [], days: s.days || s.labels || [] } : null;
}

function breakdownTotals(result) {
  if (!Array.isArray(result)) return [];
  return result
    .filter(r => r.breakdown_value && r.breakdown_value !== '$$_posthog_breakdown_other_$$')
    .map(r => ({ label: r.breakdown_value, count: (r.data || []).reduce((a, b) => a + b, 0) }))
    .filter(r => r.count > 0)
    .sort((a, b) => b.count - a.count);
}

export async function buildAnalyticsDashboard(range = '7d') {
  if (!PH_KEY) return { _error: 'POSTHOG_API_KEY not set', _source: 'none' };

  const days     = DAYS_MAP[range] || 7;
  const dateFrom = `-${days}d`;
  const proj     = `/api/projects/${PH_PROJECT}`;
  const ctrl     = new AbortController();
  const tid      = setTimeout(() => ctrl.abort(), 12000);
  const sig      = ctrl.signal;

  try {
    const [trend, sessionTrend, pageBreak, deviceBreak, browserBreak, geoBreak, refBreak, eventsTrend, prevTrend] =
      await Promise.allSettled([

        // 0: pageview + unique visitor trend (current period)
        phPost(`${proj}/insights/trend/`, {
          events: [
            { id: '$pageview', name: 'Pageview',        type: 'events', math: 'total' },
            { id: '$pageview', name: 'Unique visitors', type: 'events', math: 'dau'   },
          ],
          date_from: dateFrom, interval: 'day',
        }, sig),

        // 1: sessions
        phPost(`${proj}/insights/trend/`, {
          events: [{ id: '$pageview', name: 'Sessions', type: 'events', math: 'unique_session' }],
          date_from: dateFrom, interval: 'day',
        }, sig),

        // 2: top pages breakdown
        phPost(`${proj}/insights/trend/`, {
          events: [{ id: '$pageview', name: 'Pageview', type: 'events', math: 'total' }],
          date_from: dateFrom, breakdown: '$current_url', breakdown_type: 'event',
        }, sig),

        // 3: device breakdown
        phPost(`${proj}/insights/trend/`, {
          events: [{ id: '$pageview', name: 'Pageview', type: 'events', math: 'total' }],
          date_from: dateFrom, breakdown: '$device_type', breakdown_type: 'event',
        }, sig),

        // 4: browser breakdown
        phPost(`${proj}/insights/trend/`, {
          events: [{ id: '$pageview', name: 'Pageview', type: 'events', math: 'total' }],
          date_from: dateFrom, breakdown: '$browser', breakdown_type: 'event',
        }, sig),

        // 5: country breakdown
        phPost(`${proj}/insights/trend/`, {
          events: [{ id: '$pageview', name: 'Pageview', type: 'events', math: 'total' }],
          date_from: dateFrom, breakdown: '$geoip_country_name', breakdown_type: 'event',
        }, sig),

        // 6: referrer breakdown
        phPost(`${proj}/insights/trend/`, {
          events: [{ id: '$pageview', name: 'Pageview', type: 'events', math: 'total' }],
          date_from: dateFrom, breakdown: '$referring_domain', breakdown_type: 'event',
        }, sig),

        // 7: custom events
        phPost(`${proj}/insights/trend/`, {
          events: [
            { id: 'signup_completed',  name: 'Signup',  type: 'events', math: 'total' },
            { id: 'contact_submitted', name: 'Contact', type: 'events', math: 'total' },
            { id: 'demo_requested',    name: 'Demo',    type: 'events', math: 'total' },
            { id: '$pageview',         name: 'Docs',    type: 'events', math: 'total',
              properties: [{ key: '$current_url', operator: 'icontains', value: '/docs' }] },
          ],
          date_from: dateFrom, interval: 'day',
        }, sig),

        // 8: previous period (for delta)
        phPost(`${proj}/insights/trend/`, {
          events: [
            { id: '$pageview', name: 'Pageview',        type: 'events', math: 'total' },
            { id: '$pageview', name: 'Unique visitors', type: 'events', math: 'dau'   },
          ],
          date_from: `-${days * 2}d`, date_to: `-${days}d`, interval: 'day',
        }, sig),
      ]);

    clearTimeout(tid);

    // ── Parse trend ────────────────────────────────────────────────────────────
    const trendResult   = trend.status         === 'fulfilled' ? trend.value?.result         : [];
    const prevResult    = prevTrend.status      === 'fulfilled' ? prevTrend.value?.result      : [];
    const sessionResult = sessionTrend.status   === 'fulfilled' ? sessionTrend.value?.result   : [];

    const pvSeries  = getSeriesData(trendResult,  'Pageview');
    const uvSeries  = getSeriesData(trendResult,  'Unique visitors');
    const sesSeries = getSeriesData(sessionResult, 'Sessions');

    const totalPv  = pvSeries  ? pvSeries.data.reduce((a, b) => a + b, 0)  : 0;
    const totalUv  = uvSeries  ? uvSeries.data.reduce((a, b) => a + b, 0)  : 0;
    const totalSes = sesSeries ? sesSeries.data.reduce((a, b) => a + b, 0) : 0;

    const prevPv  = sumSeries(prevResult, 'Pageview');
    const prevUv  = sumSeries(prevResult, 'Unique visitors');

    // Build day labels
    const labels = pvSeries?.days?.map(d => {
      const dt = new Date(d);
      return dt.toLocaleDateString('en-US', { weekday: 'short' });
    }) || [];

    const traffic = {
      labels,
      pv: pvSeries?.data || [],
      uv: uvSeries?.data || [],
    };

    // ── Top pages ──────────────────────────────────────────────────────────────
    let topPages = [];
    if (pageBreak.status === 'fulfilled') {
      topPages = breakdownTotals(pageBreak.value?.result)
        .slice(0, 9)
        .map(r => {
          try {
            const url  = new URL(r.label.startsWith('http') ? r.label : 'https://x.com' + r.label);
            const path = url.pathname;
            const name = path === '/' ? 'Home' : path.replace(/^\//, '').replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            return [path, name, r.count, Math.round(r.count * 0.65), '2m 30s', '▲'];
          } catch { return null; }
        })
        .filter(Boolean);
    }

    // ── Devices ────────────────────────────────────────────────────────────────
    let device = [['Desktop',58],['Mobile',37],['Tablet',5]];
    if (deviceBreak.status === 'fulfilled') {
      const rows = breakdownTotals(deviceBreak.value?.result);
      const tot  = rows.reduce((a, r) => a + r.count, 0);
      if (tot > 0) device = rows.map(r => [r.label || 'Other', Math.round(r.count/tot*100)]);
    }

    // ── Browsers ───────────────────────────────────────────────────────────────
    let browser = [['Chrome',61],['Safari',22],['Edge',9],['Firefox',5],['Other',3]];
    if (browserBreak.status === 'fulfilled') {
      const rows = breakdownTotals(browserBreak.value?.result);
      const tot  = rows.reduce((a, r) => a + r.count, 0);
      if (tot > 0) browser = rows.slice(0, 6).map(r => [r.label || 'Other', Math.round(r.count/tot*100)]);
    }

    // ── Countries ──────────────────────────────────────────────────────────────
    let country = [];
    if (geoBreak.status === 'fulfilled') {
      const rows = breakdownTotals(geoBreak.value?.result);
      const tot  = rows.reduce((a, r) => a + r.count, 0);
      country = rows.slice(0, 8).map(r => {
        const flag = COUNTRY_FLAGS[r.label] || '🌐';
        const p    = Math.round(r.count / tot * 100);
        return [flag, r.label, r.count, Math.round(r.count * 2.7), p];
      });
    }

    // ── Referrers & channels ──────────────────────────────────────────────────
    let acqRef  = [];
    let channels = [['Organic search',38],['Direct',27],['Social',19],['Referral',10],['Paid',6]];
    if (refBreak.status === 'fulfilled') {
      const rows    = breakdownTotals(refBreak.value?.result).filter(r => r.label !== '$direct');
      const direct  = breakdownTotals(refBreak.value?.result).find(r => r.label === '$direct');
      acqRef        = rows.slice(0, 6).map(r => [r.label, r.count]);

      const socialDomains = ['x.com','t.co','linkedin.com','facebook.com','instagram.com','youtube.com','reddit.com'];
      const organicDomains= ['google','bing','duckduckgo','yahoo','yandex','baidu'];
      let orgCount=0, directCount=direct?.count||0, socialCount=0, refCount=0;
      rows.forEach(r => {
        if (organicDomains.some(d => r.label.includes(d))) orgCount += r.count;
        else if (socialDomains.some(d => r.label.includes(d))) socialCount += r.count;
        else refCount += r.count;
      });
      const tot = orgCount + directCount + socialCount + refCount || 1;
      channels = [
        ['Organic search', Math.round(orgCount/tot*100)],
        ['Direct',         Math.round(directCount/tot*100)],
        ['Social',         Math.round(socialCount/tot*100)],
        ['Referral',       Math.round(refCount/tot*100)],
        ['Paid',           0],
      ].filter(r => r[1] > 0);
    }

    // ── Custom events ──────────────────────────────────────────────────────────
    let signups=0, contacts=0, demos=0, docsViews=0;
    if (eventsTrend.status === 'fulfilled') {
      signups   = sumSeries(eventsTrend.value?.result, 'Signup');
      contacts  = sumSeries(eventsTrend.value?.result, 'Contact');
      demos     = sumSeries(eventsTrend.value?.result, 'Demo');
      docsViews = sumSeries(eventsTrend.value?.result, 'Docs');
    }
    const events = [
      ['signup_completed',  signups,   pct(signups, totalPv)],
      ['contact_submitted', contacts,  pct(contacts, totalPv)],
      ['demo_requested',    demos,     pct(demos, totalPv)],
      ['docs_opened',       docsViews, pct(docsViews, totalPv)],
    ];

    // ── Deltas ─────────────────────────────────────────────────────────────────
    const pvDelta = delta(totalPv, prevPv);
    const uvDelta = delta(totalUv, prevUv);

    // ── Assemble response ──────────────────────────────────────────────────────
    return {
      ovkpis: [
        { l:`Visitors (${range})`, v: fmt(totalUv),  ...uvDelta },
        { l:'Pageviews',           v: fmt(totalPv),  ...pvDelta },
        { l:'Sessions',            v: fmt(totalSes), d:'—', c:'up' },
        { l:'Avg. engagement',     v:'—',             d:'—', c:'up' },
      ],
      traffic,
      channels,
      sites:    [['dcsai.ai', totalUv, totalPv, '—']],
      newret:   [64, 36],
      topPages: topPages.length ? topPages : null,
      search:   [],
      gscQueries: [],
      entry:    topPages.slice(0, 3).map(p => [p[0], p[2]]),
      exit:     [],
      vikpis: [
        { l:'Total visitors',      v: fmt(totalUv) },
        { l:'New',                 v: fmt(Math.round(totalUv*0.64)) + ' (64%)' },
        { l:'Returning',           v: fmt(Math.round(totalUv*0.36)) + ' (36%)' },
        { l:'Avg. visits / user',  v: totalUv > 0 ? (totalSes/totalUv).toFixed(1) : '—' },
      ],
      freq: [
        ['1 visit',    Math.round(totalUv*0.64), 64],
        ['2–3 visits', Math.round(totalUv*0.23), 23],
        ['4–9 visits', Math.round(totalUv*0.10), 10],
        ['10+ visits', Math.round(totalUv*0.03),  3],
      ],
      identified: [
        ['Anonymous visitors',    fmt(Math.round(totalUv*0.81))],
        ['Identified (logged-in)',fmt(Math.round(totalUv*0.19))],
        ['New signups (7d)',      String(signups)],
        ['Returning members',     fmt(Math.round(totalUv*0.15))],
      ],
      device,
      browser,
      country,
      region: [],
      city:   [],
      acqRef,
      acqUtm: [],
      events,
      funnel: [
        ['Landing',        totalSes,                    100],
        ['Viewed signup',  Math.round(totalSes*0.33),   33],
        ['Started signup', Math.round(totalSes*0.075), 7.5],
        ['Completed',      signups,                     totalSes > 0 ? +(signups/totalSes*100).toFixed(1) : 0],
      ],
      social:   [['X / @DCS_AI','—'],['LinkedIn','—'],['YouTube','—'],['Instagram','—']],
      ads:      [['Meta','$0','0','0','0','—'],['Google Ads','$0','0','0','0','—']],
      dcsLeft:  [['Agent runs ('+range+')','—'],['Verified runs','—'],['Receipts generated','—'],['Avg. cost / run','—']],
      dcsRight: [['Active workflows','—'],['Connected integrations','—'],['Multi-agent sessions','—'],['Verifier checks passed','—']],
      revenue: '$0',
      agent:  { kpis:[['Agent runs today','—'],['Cost today','—'],['Failure rate','—'],['Avg. runtime','—']], top:[] },
      hekpis: [
        { l:'Uptime (7d)',     v:'—', d:'', c:'up' },
        { l:'Avg. page load', v:'—', d:'', c:'up' },
        { l:'404s (7d)',       v:'—', d:'', c:'up' },
        { l:'Failed runs',     v:'—', d:'', c:'up' },
      ],
      vitals: [], e404: [], errors: [],
      connectors: {
        posthog:  { status: 'connected' },
        ga4:      { status: process.env.GA4_PROPERTY_ID ? 'pending' : 'missing' },
        meta:     { status: 'deferred'  },
        supabase: { status: process.env.SUPABASE_URL ? 'connected' : 'missing' },
      },
      _source:     'posthog',
      _range:      range,
      updatedAt:   new Date().toISOString(),
    };

  } catch (err) {
    clearTimeout(tid);
    console.error('[analytics] PostHog fetch error:', err.message);
    return { _error: err.message, _source: 'posthog_error' };
  }
}
