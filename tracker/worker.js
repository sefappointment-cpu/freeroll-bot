// Переадресация на покерные румы с учётом переходов и гео.
//   /r/<рум>?p=<id турнира>  → засчитать переход и перекинуть на сайт рума
//   /stats?key=<STATS_KEY>   → страница статистики
// IP-адреса не сохраняются. «Уникальные» считаются по хэшу, который меняется каждые сутки.

import ROOMS from "../rooms.json";

const BOT_UA = /bot|crawler|spider|preview|telegram|whatsapp|facebookexternalhit|slack|discord/i;
let tableReady = false;

async function ensureTable(db) {
  if (tableReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      room TEXT NOT NULL,
      post TEXT,
      country TEXT,
      city TEXT,
      device TEXT,
      visitor TEXT
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS clicks_ts ON clicks(ts)"),
  ]);
  tableReady = true;
}

function device(ua) {
  if (/iphone|ipad|ios/i.test(ua)) return "iOS";
  if (/android/i.test(ua)) return "Android";
  return "Компьютер";
}

async function visitorHash(ip, ua, salt) {
  const day = new Date().toISOString().slice(0, 10);
  const data = new TextEncoder().encode(`${ip}|${ua}|${day}|${salt}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function logClick(env, req, room, post) {
  const ua = req.headers.get("user-agent") || "";
  const ip = req.headers.get("cf-connecting-ip") || "";
  await ensureTable(env.DB);
  await env.DB.prepare(
    "INSERT INTO clicks (ts, room, post, country, city, device, visitor) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(
      Date.now(),
      room,
      post,
      req.cf?.country || "??",
      req.cf?.city || "",
      device(ua),
      await visitorHash(ip, ua, env.STATS_KEY || "salt")
    )
    .run();
}

// ---------------------------------------------------------------- stats page

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function flag(cc) {
  if (!/^[A-Z]{2}$/.test(cc || "")) return "🏳️";
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

// создаётся только при открытии статистики, чтобы не тратить время на запусках бота
let regionNames;
const countryName = (cc) => {
  try {
    if (regionNames === undefined) regionNames = new Intl.DisplayNames(["ru"], { type: "region" });
    return regionNames.of(cc) || cc;
  } catch {
    return cc;
  }
};

function table(title, head, rows, max) {
  const bar = (v) => `<div class="bar"><span style="width:${max ? Math.max(2, (v / max) * 100) : 0}%"></span></div>`;
  const body = rows.length
    ? rows.map((r) => `<tr>${r.cells.map((c) => `<td>${c}</td>`).join("")}<td class="num">${r.n}</td><td class="num muted">${r.u}</td><td class="w">${bar(r.n)}</td></tr>`).join("")
    : `<tr><td colspan="${head.length + 3}" class="muted">Пока нет данных</td></tr>`;
  return `<section><h2>${title}</h2><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}<th class="num">Переходы</th><th class="num">Уник.</th><th></th></tr></thead><tbody>${body}</tbody></table></section>`;
}

async function stats(env, url) {
  await ensureTable(env.DB);
  const days = url.searchParams.get("days") || "7";
  const since = days === "all" ? 0 : Date.now() - Number(days) * 86400000;
  const q = (sql) => env.DB.prepare(sql).bind(since).all().then((r) => r.results);

  const [tot] = await q("SELECT COUNT(*) n, COUNT(DISTINCT visitor) u FROM clicks WHERE ts >= ?");
  const rooms = await q("SELECT room, COUNT(*) n, COUNT(DISTINCT visitor) u FROM clicks WHERE ts >= ? GROUP BY room ORDER BY n DESC");
  const countries = await q("SELECT country, COUNT(*) n, COUNT(DISTINCT visitor) u FROM clicks WHERE ts >= ? GROUP BY country ORDER BY n DESC LIMIT 30");
  const cities = await q("SELECT country, city, COUNT(*) n, COUNT(DISTINCT visitor) u FROM clicks WHERE ts >= ? AND city != '' GROUP BY country, city ORDER BY n DESC LIMIT 20");
  const devices = await q("SELECT device, COUNT(*) n, COUNT(DISTINCT visitor) u FROM clicks WHERE ts >= ? GROUP BY device ORDER BY n DESC");
  const daysRows = await q("SELECT date(ts/1000,'unixepoch') d, COUNT(*) n, COUNT(DISTINCT visitor) u FROM clicks WHERE ts >= ? GROUP BY d ORDER BY d DESC LIMIT 60");
  const posts = await q("SELECT room, post, COUNT(*) n, COUNT(DISTINCT visitor) u FROM clicks WHERE ts >= ? AND post != '' GROUP BY room, post ORDER BY n DESC LIMIT 20");

  const mx = (rs) => Math.max(0, ...rs.map((r) => r.n));
  const key = encodeURIComponent(url.searchParams.get("key"));
  const periods = [["1", "Сутки"], ["7", "7 дней"], ["30", "30 дней"], ["all", "Всё время"]]
    .map(([v, l]) => `<a href="?key=${key}&days=${v}" class="${v === days ? "on" : ""}">${l}</a>`).join("");

  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Freeroll Clicks</title><style>
:root{--bg:#fafaf7;--fg:#1d1d1b;--muted:#8a8a83;--line:#e6e5df;--acc:#2f7d5b;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#8d8c86;--line:#2b2b28;--acc:#5fbf8f;--card:#1c1c1a}}
body{background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,sans-serif;margin:0;padding:24px 16px;max-width:880px;margin-inline:auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:0 0 8px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.periods{display:flex;gap:6px;flex-wrap:wrap;margin:14px 0 20px}.periods a{padding:6px 12px;border:1px solid var(--line);border-radius:99px;color:var(--fg);text-decoration:none}
.periods a.on{background:var(--acc);border-color:var(--acc);color:#fff}
.kpis{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:24px}.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
.kpi b{display:block;font-size:30px;font-variant-numeric:tabular-nums}.kpi span{color:var(--muted)}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:16px;overflow-x:auto}
table{width:100%;border-collapse:collapse}td,th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
th{font-weight:500;color:var(--muted);font-size:13px}tr:last-child td{border-bottom:0}
.num{text-align:right;font-variant-numeric:tabular-nums}.muted{color:var(--muted)}.w{width:40%;min-width:80px}
.bar{height:8px;background:var(--line);border-radius:4px;overflow:hidden}.bar span{display:block;height:100%;background:var(--acc)}
</style></head><body>
<h1>Переходы по румам</h1><div class="muted">Уникальные считаются в пределах суток</div>
<nav class="periods">${periods}</nav>
<div class="kpis"><div class="kpi"><b>${tot.n}</b><span>переходов</span></div><div class="kpi"><b>${tot.u}</b><span>уникальных</span></div></div>
${table("Румы", ["Рум"], rooms.map((r) => ({ cells: [esc(r.room)], n: r.n, u: r.u })), mx(rooms))}
${table("Страны", ["Страна"], countries.map((r) => ({ cells: [`${flag(r.country)} ${esc(countryName(r.country))}`], n: r.n, u: r.u })), mx(countries))}
${table("Города", ["Город"], cities.map((r) => ({ cells: [`${flag(r.country)} ${esc(r.city)}`], n: r.n, u: r.u })), mx(cities))}
${table("Устройства", ["Устройство"], devices.map((r) => ({ cells: [esc(r.device)], n: r.n, u: r.u })), mx(devices))}
${table("По дням", ["Дата"], daysRows.map((r) => ({ cells: [esc(r.d)], n: r.n, u: r.u })), mx(daysRows))}
${table("Лучшие посты", ["Рум", "Турнир"], posts.map((r) => ({ cells: [esc(r.room), `<a href="https://freerollpass.com/${encodeURIComponent(r.room)}-${encodeURIComponent(r.post)}" target="_blank" rel="noopener">#${esc(r.post)}</a>`], n: r.n, u: r.u })), mx(posts))}
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

// ---------------------------------------------------------------- feed (EU)

async function myColo() {
  try {
    const t = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text();
    return (t.match(/colo=(\w+)/) || [])[1] || "?";
  } catch {
    return "?";
  }
}

export class FeedFetcher {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req) {
    const page = Number(new URL(typeof req === "string" ? req : req.url).searchParams.get("page") || 1);
    const body =
      "Filter[pass][]=all&Filter[deposit][]=all&Filter[satellite][]=all" +
      "&Filter[exclusive_fr][]=all&Filter[type][]=all" +
      (page > 1 ? `&Filter[page]=${page}` : "");
    const upstream = await fetch("https://freerollpass.com/", {
      method: "POST",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "X-Requested-With": "XMLHttpRequest",
        "X-WINTER-REQUEST-HANDLER": "onFilterFreerolls",
        "X-WINTER-REQUEST-PARTIALS": "freerollList&loadmore&timeAjax",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Origin: "https://freerollpass.com",
        Referer: "https://freerollpass.com/",
        Cookie: "tz_auto=Europe%2FLisbon; hc_format=24",
      },
      body,
    });
    const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
    if (upstream.status !== 200) headers["x-feed-colo"] = await myColo();
    return new Response(await upstream.text(), { status: upstream.status, headers });
  }
}

// ---------------------------------------------------------------- bot
// Каждые 2 минуты (cron в wrangler.toml): забрать расписание через объект в Европе,
// найти турниры с паролем, до старта которых ≤ POST_AHEAD_MINUTES, и опубликовать.

// Сайт отдаёт время по Лиссабону (cookie tz_auto в FeedFetcher), в постах — по Нью-Йорку (ET)
const POST_TZ_LABEL = "ET";
const MAX_PAGES = 6;

async function fetchSchedule(env) {
  const stub = env.FEED.get(env.FEED.idFromName("weur-1"), { locationHint: "weur" });
  const chunks = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await stub.fetch(`https://feed.internal/?page=${page}`);
    const text = await r.text();
    if (r.status !== 200) {
      throw new Error(`сайт ответил ${r.status} (дата-центр ${r.headers.get("x-feed-colo") || "?"}): ${text.slice(0, 80)}`);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("сайт вернул не JSON: " + text.slice(0, 80));
    }
    chunks.push(data.freerollList || "");
    if (!String(data.loadmore || "").includes("loadNextPage")) break;
  }
  return chunks;
}

const decode = (s) =>
  String(s ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();

const pick = (re, s) => (s.match(re) || [])[1];

function parseSchedule(chunk) {
  const out = [];
  for (const li of chunk.split(/<li\s+class="row/).slice(1)) {
    const passM = li.match(/<div id="(\d+)" class="pt-1">([\s\S]*?)<\/div>/);
    if (!passM) continue;
    const [, id, passHtml] = passM;
    const passText = decode(passHtml).toLowerCase();
    let password = null;
    if (!passText.includes("will be available") && !passText.includes("not required")) {
      password = decode(pick(/fl-badge[^>]*>([\s\S]*?)<\/strong>/, passHtml)) || null;
    }
    const prizeHtml = pick(/c-yellow">([\s\S]*?)<\/div>/, li) || "";
    let prize = decode(prizeHtml);
    if (prizeHtml.includes("#bi-ticket")) prize = `${prize} tickets`;
    out.push({
      id,
      time: pick(/class="f-size-30-576-40">\s*(\d{1,2}:\d{2})\s*</, li),
      date: pick(/class="f-size-15-576-20">\s*(\d{2}\.\d{2}\.\d{4})\s*</, li),
      reg: pick(/Registration until <span[^>]*>\s*(\d{1,2}:\d{2})/, li),
      prize,
      roomSlug: pick(/class="title-room"><a href="https?:\/\/freerollpass\.com\/([a-z0-9]+)"/, li) || "",
      room: decode(pick(/class="title-room[^"]*">(?:<a [^>]*>)?\s*<div[^>]*><\/div>([^<]*)/, li)),
      name: decode(pick(/class="fl-text-name">([\s\S]*?)<\/span>/, li)),
      password,
    });
  }
  return out;
}

// Часовые пояса считаем по правилам перехода на летнее время без Intl:
// так запуск по расписанию укладывается в лимит процессорного времени бесплатного тарифа.
const H = 3600000;
// n-е (или последнее при n = -1) воскресенье месяца, в UTC-полночь
function nthSunday(y, month, n) {
  if (n === -1) {
    const last = new Date(Date.UTC(y, month + 1, 0));
    return Date.UTC(y, month, last.getUTCDate() - last.getUTCDay());
  }
  const first = new Date(Date.UTC(y, month, 1)).getUTCDay();
  return Date.UTC(y, month, 1 + ((7 - first) % 7) + 7 * (n - 1));
}
// Лиссабон (ЕС): UTC+1 с последнего воскресенья марта 01:00 UTC до последнего воскресенья октября 01:00 UTC
function lisbonOffset(ts) {
  const y = new Date(ts).getUTCFullYear();
  return ts >= nthSunday(y, 2, -1) + H && ts < nthSunday(y, 9, -1) + H ? H : 0;
}
// Нью-Йорк (США): EDT (UTC−4) со 2-го воскресенья марта 07:00 UTC до 1-го воскресенья ноября 06:00 UTC, иначе EST (UTC−5)
function newYorkOffset(ts) {
  const y = new Date(ts).getUTCFullYear();
  return ts >= nthSunday(y, 2, 2) + 7 * H && ts < nthSunday(y, 10, 1) + 6 * H ? -4 * H : -5 * H;
}

// «31.10.2026» + «17:00» во времени сайта (Лиссабон) → миллисекунды UTC
function siteTimeToUtc(date, time) {
  const [d, m, y] = date.split(".").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  return naive - lisbonOffset(naive - lisbonOffset(naive));
}

function withTimes(t) {
  if (!t.date || !t.time) return null;
  const start = siteTimeToUtc(t.date, t.time);
  let regEnd = start;
  if (t.reg) {
    regEnd = siteTimeToUtc(t.date, t.reg);
    if (regEnd < start) regEnd += 86400000; // регистрация через полночь
  }
  return { ...t, start, regEnd };
}

const htmlEsc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function formatPost(t, env, now) {
  const local = (ts) => new Date(ts + newYorkOffset(ts)); // «местное» время ET в полях UTC
  const startET = local(t.start);
  const dayKey = (d) => d.getUTCFullYear() * 10000 + d.getUTCMonth() * 100 + d.getUTCDate();
  const day = dayKey(startET) > dayKey(local(now)) ? "TOMORROW'S" : "TODAY'S";
  const h24 = startET.getUTCHours();
  const when = `${h24 % 12 || 12}:${String(startET.getUTCMinutes()).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
  let room = htmlEsc(t.room);
  const base = (env.TRACKER_URL || "").replace(/\/$/, "");
  if (room && base && ROOMS[t.roomSlug]) {
    room = `<a href="${base}/r/${t.roomSlug}?p=${t.id}">${room}</a>`;
  }
  const lines = [
    `🇺🇸 ${day} POKER FREEROLLS`,
    `🃏 Tournament: ${room ? `${room} – ` : ""}${htmlEsc(t.name)}`,
    `🕒 Time: ${when} ${POST_TZ_LABEL}`,
  ];
  if (t.prize) lines.push(`💰 Prize Pool: ${htmlEsc(t.prize)}`);
  lines.push(`🔑 Password: <code>${htmlEsc(t.password)}</code>`, "♠️ Good luck at the tables!");
  return lines.join("\n");
}

async function sendTelegram(env, text) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHANNEL, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`Telegram ${r.status}: ${(await r.text()).slice(0, 150)}`);
}

let botTablesReady = false;
async function ensureBotTables(db) {
  if (botTablesReady) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS posted (id TEXT PRIMARY KEY, start INTEGER, password TEXT, ts INTEGER)"),
    db.prepare("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)"),
  ]);
  botTablesReady = true;
}

async function runBot(env, { dryRun = false } = {}) {
  const log = [];
  const now = Date.now();
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHANNEL) throw new Error("не заданы TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL");
  await ensureBotTables(env.DB);

  const all = (await fetchSchedule(env)).flatMap(parseSchedule).map(withTimes).filter(Boolean);
  const ahead = Number(env.POST_AHEAD_MINUTES || 30) * 60000;
  const due = all
    .filter((t) => t.password && t.regEnd > now && t.start - now <= ahead)
    .sort((a, b) => a.start - b.start);
  log.push(`турниров на сайте: ${all.length}, с паролем: ${all.filter((t) => t.password).length}, подходят по времени: ${due.length}`);

  let posted = 0;
  for (const t of due) {
    if (dryRun) {
      const seen = await env.DB.prepare("SELECT 1 FROM posted WHERE id = ?").bind(t.id).first();
      log.push(`${seen ? "уже было" : "опубликовал бы"}: ${t.room} – ${t.name} (${t.date} ${t.time}) пароль ${t.password}`);
      continue;
    }
    // «бронируем» турнир до отправки, чтобы два запуска подряд не опубликовали его дважды
    const claim = await env.DB.prepare("INSERT OR IGNORE INTO posted (id, start, password, ts) VALUES (?, ?, ?, ?)")
      .bind(t.id, t.start, t.password, now).run();
    if (!claim.meta?.changes) continue;
    try {
      await sendTelegram(env, formatPost(t, env, now));
      posted++;
      log.push(`опубликовано: ${t.room} – ${t.name} (${t.date} ${t.time})`);
    } catch (e) {
      await env.DB.prepare("DELETE FROM posted WHERE id = ?").bind(t.id).run();
      log.push(`ошибка публикации ${t.id}: ${e.message}`);
    }
  }

  if (!dryRun) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM posted WHERE start < ?").bind(now - 7 * 86400000),
      env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('last_run', ?)")
        .bind(JSON.stringify({ at: new Date(now).toISOString(), posted, log })),
    ]);
  }
  return { posted, log };
}

// ---------------------------------------------------------------- router

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runBot(env).catch(async (e) => {
        console.error(e);
        try {
          await ensureBotTables(env.DB);
          await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('last_error', ?)")
            .bind(JSON.stringify({ at: new Date().toISOString(), error: String(e.message || e) })).run();
        } catch {}
      })
    );
  },

  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/r\/([a-z0-9]+)\/?$/);

    if (m) {
      const room = m[1];
      const target = ROOMS[room];
      if (!target) return new Response("Unknown room", { status: 404 });
      const post = (url.searchParams.get("p") || "").replace(/[^0-9]/g, "").slice(0, 12);
      if (!BOT_UA.test(req.headers.get("user-agent") || "")) {
        ctx.waitUntil(logClick(env, req, room, post).catch((e) => console.error(e)));
      }
      return new Response(null, {
        status: 302,
        headers: { location: target, "cache-control": "no-store", "referrer-policy": "no-referrer" },
      });
    }

    // Прокси для бота: забирает страницу расписания с freerollpass.com.
    // Запрос делает объект, закреплённый в Западной Европе: из США сайт
    // отвечает проверкой «Just a moment...», а из Европы пропускает.
    if (url.pathname === "/feed") {
      if (!env.STATS_KEY || url.searchParams.get("key") !== env.STATS_KEY) {
        return new Response("Forbidden", { status: 403 });
      }
      const page = Math.min(20, Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1));
      const stub = env.FEED.get(env.FEED.idFromName("weur-1"), { locationHint: "weur" });
      return stub.fetch(`https://feed.internal/?page=${page}`);
    }

    if (url.pathname === "/stats") {
      if (!env.STATS_KEY || url.searchParams.get("key") !== env.STATS_KEY) {
        return new Response("Forbidden", { status: 403 });
      }
      return stats(env, url);
    }

    // Проверка бота вручную:
    //   /bot?key=...           — состояние: последний запуск и последняя ошибка
    //   /bot?key=...&dry=1     — что бот опубликовал бы прямо сейчас (ничего не отправляет)
    //   /bot?key=...&run=1     — запустить бота сейчас (публикует, как по расписанию)
    if (url.pathname === "/bot") {
      if (!env.STATS_KEY || url.searchParams.get("key") !== env.STATS_KEY) {
        return new Response("Forbidden", { status: 403 });
      }
      const json = (o, status = 200) =>
        new Response(JSON.stringify(o, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });
      try {
        if (url.searchParams.get("dry") || url.searchParams.get("run")) {
          return json(await runBot(env, { dryRun: !url.searchParams.get("run") }));
        }
        await ensureBotTables(env.DB);
        const rows = (await env.DB.prepare("SELECT k, v FROM meta").all()).results;
        const meta = Object.fromEntries(rows.map((r) => [r.k, JSON.parse(r.v)]));
        const count = await env.DB.prepare("SELECT COUNT(*) n FROM posted").first();
        return json({ ...meta, posted_last_7_days: count?.n ?? 0 });
      } catch (e) {
        return json({ error: String(e.message || e) }, 500);
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
