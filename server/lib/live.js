/**
 * live.js — بوابة البيانات الحية (تُستدعى من الخادم فقط، مع تخزين مؤقت ووسم المصدر)
 * -----------------------------------------------------------------------------
 * كل استجابة تحمل: { source, source_url, fetched_at, stale, data }
 * - لا تُولَّد أي قيمة من الخيال: إن فشل المصدر تُعاد آخر نسخة مع stale=true
 *   أو خطأ صريح 502 — ولا تُعاد بيانات مُختلقة.
 */
'use strict';

const CACHE = new Map(); // key -> { value, at }
const TTL = { fx: 30 * 60e3, weather: 10 * 60e3, news: 15 * 60e3, crypto: 5 * 60e3, macro: 12 * 3600e3 };

// مدن/موانئ رئيسية مرتبطة بمستودعات النظام (إحداثيات حقيقية)
const PORTS = [
  { id: 'aden', name: 'ميناء عدن', lat: 12.7855, lng: 45.0187 },
  { id: 'jebel_ali', name: 'ميناء جبل علي', lat: 25.0100, lng: 55.0610 },
  { id: 'salalah', name: 'ميناء صلالة', lat: 16.9460, lng: 54.0050 },
  { id: 'istanbul', name: 'ميناء إسطنبول', lat: 41.0082, lng: 28.9784 },
  { id: 'guangzhou', name: 'ميناء جوانزو (ناشا)', lat: 22.7500, lng: 113.6000 },
  { id: 'newyork', name: 'ميناء نيويورك', lat: 40.6840, lng: -74.0450 }
];

async function getJson(url, timeout = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'user-agent': 'Almasar-Logistics/1.0 (+server)', accept: 'application/json' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

async function getText(url, timeout = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; AlmasarBot/1.0)', accept: 'application/rss+xml,text/xml' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally { clearTimeout(t); }
}

function cacheGet(kind, key) {
  const hit = CACHE.get(kind + ':' + key);
  if (!hit) return null;
  const age = Date.now() - hit.at;
  return { ...hit.value, stale: age > TTL[kind], age_ms: age };
}
function cacheSet(kind, key, value) {
  CACHE.set(kind + ':' + key, { value, at: Date.now() });
  return value;
}

// ---------- أسعار الصرف ----------
async function fx() {
  const primary = await getJson('https://api.frankfurter.dev/v1/latest?base=USD').catch((e) => ({ __err: e.message }));
  let rates = null, date = null, source = null, sourceUrl = null, note = null;

  if (primary && primary.rates) {
    rates = {};
    // Frankfurter يعيد المفتاح باسم العملة
    for (const k of ['EUR', 'GBP', 'SAR', 'AED', 'OMR', 'CNY', 'TRY', 'KWD', 'QAR', 'EGP', 'JOD']) {
      if (primary.rates[k] != null) rates[k] = primary.rates[k];
    }
    date = primary.date; source = 'Frankfurter API (بيانات البنك المركزي الأوروبي)';
    sourceUrl = 'https://www.frankfurter.dev/';
  }

  // الريال اليمني غير مشمول في ECB — يُجلب من مزوّد ثانٍ
  if (!rates || !rates.YER) {
    const alt = await getJson('https://open.er-api.com/v6/latest/USD').catch(() => null);
    if (alt && alt.rates) {
      rates = rates || {};
      for (const k of ['YER', 'SAR', 'AED', 'OMR', 'EGP', 'JOD', 'KWD', 'QAR']) {
        if (alt.rates[k] != null) rates[k] = alt.rates[k];
      }
      source = source ? source + ' + open.er-api.com' : 'open.er-api.com (ExchangeRate-API)';
      sourceUrl = 'https://www.exchangerate-api.com/docs/free';
      date = date || new Date(alt.time_last_update_unix * 1000).toISOString().slice(0, 10);
      note = 'الريال اليمني مصدره open.er-api وليس البنك المركزي الأوروبي';
    }
  }

  if (!rates) throw new Error('تعذّر جلب أسعار الصرف من المصدرين');
  return { source, source_url: sourceUrl, rate_date: date, base: 'USD', rates, note };
}

// ---------- الطقس وحالة البحر ----------
async function weather() {
  const out = [];
  for (const p of PORTS) {
    try {
      const w = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lng}&current=temperature_2m,wind_speed_10m,weather_code&timezone=UTC`);
      let marine = null;
      try {
        marine = await getJson(`https://marine-api.open-meteo.com/v1/marine?latitude=${p.lat}&longitude=${p.lng}&current=wave_height,wave_period`);
      } catch (_) { marine = null; }
      out.push({
        port_id: p.id, port: p.name, lat: p.lat, lng: p.lng,
        temperature_c: w.current?.temperature_2m ?? null,
        wind_kmh: w.current?.wind_speed_10m ?? null,
        weather_code: w.current?.weather_code ?? null,
        wave_height_m: marine?.current?.wave_height ?? null,
        wave_period_s: marine?.current?.wave_period ?? null,
        observed_at: w.current?.time || null
      });
    } catch (e) {
      out.push({ port_id: p.id, port: p.name, error: e.message });
    }
  }
  const ok = out.filter((x) => !x.error);
  if (!ok.length) throw new Error('تعذّر جلب بيانات الطقس لأي ميناء');
  return { source: 'Open-Meteo (نموذج الطقس) + Open-Meteo Marine', source_url: 'https://open-meteo.com/', ports: out };
}

// ---------- أخبار لوجستية (RSS) ----------
function parseRss(xml, limit = 12) {
  const items = [];
  const blocks = xml.split(/<item[\s>]/).slice(1);
  for (const b of blocks.slice(0, limit)) {
    const pick = (tag) => {
      const m = b.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
      if (!m) return null;
      return m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#8217;|&apos;/g, "'").replace(/&#8211;|&ndash;/g, '–')
        .replace(/&#8212;|&mdash;/g, '—').replace(/&#\d+;/g, '').trim();
    };
    items.push({ title: pick('title'), link: pick('link'), pubDate: pick('pubDate'), description: (pick('description') || '').slice(0, 220) });
  }
  return items.filter((i) => i.title && i.link);
}

async function news() {
  const feeds = [
    { name: 'gCaptain', url: 'https://gcaptain.com/feed/', focus: 'الشحن البحري' },
    { name: 'FreightWaves', url: 'https://www.freightwaves.com/feed', focus: 'الشحن والسلاسل اللوجستية' }
  ];
  const out = [];
  for (const f of feeds) {
    try {
      const xml = await getText(f.url);
      out.push({ feed: f.name, focus: f.focus, url: f.url, items: parseRss(xml) });
    } catch (e) {
      out.push({ feed: f.name, url: f.url, error: e.message, items: [] });
    }
  }
  if (!out.some((x) => x.items.length)) throw new Error('تعذّر جلب أي خبر من المصادر');
  return { source: 'RSS: gCaptain + FreightWaves', source_url: feeds.map((f) => f.url).join(' , '), feeds: out };
}

// ---------- عملات رقمية ----------
async function cryptoPrices() {
  const d = await getJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,tether,binancecoin&vs_currencies=usd&include_last_updated_at=true');
  return {
    source: 'CoinGecko', source_url: 'https://www.coingecko.com/',
    prices: Object.entries(d).map(([id, v]) => ({ asset: id, usd: v.usd, updated_at: v.last_updated_at ? new Date(v.last_updated_at * 1000).toISOString() : null }))
  };
}

// ---------- مؤشرات اقتصادية ----------
async function macro() {
  const d = await getJson('https://api.worldbank.org/v2/country/YE;SA;AE;OM/indicator/SP.POP.TOTL?format=json&per_page=40&date=2020:2025');
  const rows = Array.isArray(d) && d[1] ? d[1] : [];
  const latest = {};
  for (const r of rows) {
    if (!r || r.value == null) continue;
    const c = r.country?.value;
    if (!latest[c] || +r.date > +latest[c].year) latest[c] = { country: c, year: r.date, population: r.value };
  }
  const list = Object.values(latest);
  if (!list.length) throw new Error('لا توجد بيانات من البنك الدولي');
  return { source: 'World Bank Open Data', source_url: 'https://data.worldbank.org/', indicator: 'SP.POP.TOTL', countries: list };
}

const FETCHERS = { fx, weather, news, crypto: cryptoPrices, macro };

async function get(kind, { maxAgeMs } = {}) {
  const fn = FETCHERS[kind];
  if (!fn) { const e = new Error('نوع بيانات غير معروف'); e.status = 404; throw e; }
  const fresh = cacheGet(kind, 'default');
  if (fresh && !fresh.stale && (!maxAgeMs || fresh.age_ms < maxAgeMs)) return { ...fresh, cached: true };
  try {
    const data = await fn();
    const value = { ...data, fetched_at: new Date().toISOString(), stale: false };
    cacheSet(kind, 'default', value);
    return { ...value, cached: false };
  } catch (e) {
    if (fresh) return { ...fresh, stale: true, cached: true, error: e.message };
    const err = new Error('تعذّر جلب البيانات الحية: ' + e.message);
    err.status = 502;
    throw err;
  }
}

module.exports = { get, PORTS, TTL };
