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

let regionNames;
try { regionNames = new Intl.DisplayNames(["ru"], { type: "region" }); } catch { regionNames = null; }
const countryName = (cc) => { try { return regionNames?.of(cc) || cc; } catch { return cc; } };

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

// ---------------------------------------------------------------- router

export default {
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

    // Прокси для бота: забирает страницу расписания с freerollpass.com
    // (серверы GitHub сайт блокирует, а запросы из сети Cloudflare пропускает)
    if (url.pathname === "/feed") {
      if (!env.STATS_KEY || url.searchParams.get("key") !== env.STATS_KEY) {
        return new Response("Forbidden", { status: 403 });
      }
      const page = Math.min(20, Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1));
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
      return new Response(await upstream.text(), {
        status: upstream.status,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/stats") {
      if (!env.STATS_KEY || url.searchParams.get("key") !== env.STATS_KEY) {
        return new Response("Forbidden", { status: 403 });
      }
      return stats(env, url);
    }

    return new Response("Not found", { status: 404 });
  },
};

  },
};
