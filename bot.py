"""
Freeroll password bot: забирает расписание с freerollpass.com и публикует
в Telegram-канал фрироллы с паролями (каждый турнир — один раз).

Запуск: python bot.py           — обычный прогон (публикует новое)
        python bot.py --dry-run — только показать, что было бы опубликовано
"""
import html
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup
from curl_cffi import requests as cffi_requests

BASE = "https://freerollpass.com/"
TZ_NAME = os.getenv("TZ_NAME", "Europe/Lisbon")
TZ = ZoneInfo(TZ_NAME)
STATE_FILE = Path(os.getenv("STATE_FILE", "state.json"))
MAX_PAGES = 10
# Публиковать за N минут до старта (если регистрация ещё открыта — и позже)
POST_AHEAD_MINUTES = float(os.getenv("POST_AHEAD_MINUTES", "30"))
# Пропускать фрироллы только для депозитчиков (1 = пропускать)
SKIP_DEPOSIT_ONLY = os.getenv("SKIP_DEPOSIT_ONLY", "0") == "1"

# Сервис учёта переходов (tracker/), например https://freeroll-go.<имя>.workers.dev
TRACKER_URL = os.getenv("TRACKER_URL", "").rstrip("/")
_rooms_file = Path(__file__).with_name("rooms.json")
ROOMS = json.loads(_rooms_file.read_text(encoding="utf-8")) if _rooms_file.exists() else {}

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
CHANNEL = os.getenv("TELEGRAM_CHANNEL", "")  # @username канала или -100...

FILTER = (
    "Filter[pass][]=all&Filter[deposit][]=all&Filter[satellite][]=all"
    "&Filter[exclusive_fr][]=all&Filter[type][]=all"
)
# User-Agent и прочие «браузерные» заголовки подставляет curl_cffi (impersonate)
HEADERS = {
    "Accept": "*/*",
    "X-Requested-With": "XMLHttpRequest",
    "X-WINTER-REQUEST-HANDLER": "onFilterFreerolls",
    "X-WINTER-REQUEST-PARTIALS": "freerollList&loadmore&timeAjax",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "Origin": "https://freerollpass.com",
    "Referer": BASE,
}

NO_PASS_MARKERS = ("not required", "не требуется")


# ---------------------------------------------------------------- fetching

def fetch_pages() -> list[str]:
    # Сайт за Cloudflare: обычный python-requests получает 403, поэтому
    # притворяемся браузером Chrome (TLS-отпечаток + заголовки).
    s = cffi_requests.Session(impersonate="chrome")
    s.cookies.set("tz_auto", TZ_NAME, domain="freerollpass.com")
    s.cookies.set("hc_format", "24", domain="freerollpass.com")
    r = s.get(BASE, timeout=30)
    print(f"Главная страница: статус {r.status_code}")
    if r.status_code == 403:
        raise RuntimeError("Сайт отказал в доступе (403): защита Cloudflare блокирует этот сервер.")
    time.sleep(1)

    chunks = []
    for page in range(1, MAX_PAGES + 1):
        body = FILTER + (f"&Filter[page]={page}" if page > 1 else "")
        r = s.post(BASE, headers=HEADERS, data=body, timeout=30)
        if r.status_code == 403:
            raise RuntimeError("Сайт отказал в доступе (403) на запросе списка.")
        r.raise_for_status()
        try:
            data = r.json()
        except ValueError:
            raise RuntimeError(
                f"Сайт вернул не JSON (статус {r.status_code}). "
                "Возможно, сработала защита Cloudflare."
            )
        if page == 1:
            tz_label = BeautifulSoup(data.get("timeAjax", ""), "html.parser").get_text(" ", strip=True)
            print(f"Часовой пояс на сайте: {tz_label or '?'}")
        chunks.append(data.get("freerollList", ""))
        if "loadNextPage" not in data.get("loadmore", ""):
            break
        time.sleep(1.5)
    return chunks


# ---------------------------------------------------------------- parsing

def _text(el) -> str:
    if not el:
        return ""
    t = el.get_text(" ", strip=True)
    return re.sub(r"\s+([.,;:!?])", r"\1", re.sub(r"\s+", " ", t))


def parse(chunk: str) -> list[dict]:
    soup = BeautifulSoup(chunk, "html.parser")
    out = []
    for li in soup.select("li.bg-list"):
        pass_div = li.select_one("div.pt-1[id]")
        if not pass_div:
            continue
        fid = pass_div["id"]
        left = li.select_one("div.col-4")
        time_s = _text(left.select_one(".f-size-30-576-40")) if left else ""
        date_s = _text(left.select_one(".f-size-15-576-20")) if left else ""
        reg_el = left.select_one(".f-size-11 span") if left else None
        prize_el = left.select_one(".c-yellow") if left else None
        prize = _text(prize_el)
        if prize_el is not None and "#bi-ticket" in str(prize_el):
            prize = f"{prize} tickets"

        badge = pass_div.select_one("strong.fl-badge")
        pass_text = _text(pass_div)
        password = None
        pending_at = None
        if "will be available" in pass_text.lower():
            pending_at = _text(badge)
        elif badge and not any(m in pass_text.lower() for m in NO_PASS_MARKERS):
            password = _text(badge)

        # условия — блоки с иконкой под паролем
        notes = [_text(d.select_one(".d-table")) for d in pass_div.find_next_siblings("div", class_="pt-1")]
        notes = [n for n in notes if n]

        ribbon = _text(li.select_one(".ribbon span"))
        name_link = li.select_one(".fl-text-name")
        room_a = li.select_one(".title-room a[href]")
        out.append({
            "id": fid,
            "room": _text(li.select_one(".title-room")),
            "room_slug": room_a["href"].rstrip("/").rsplit("/", 1)[-1] if room_a else "",
            "name": _text(name_link),
            "date": date_s,
            "time": time_s,
            "reg_until": _text(reg_el),
            "prize": prize,
            "password": password,
            "pending_at": pending_at,
            "notes": notes,
            "ribbon": ribbon,
        })
    return out


def start_dt(t: dict):
    try:
        return datetime.strptime(f"{t['date']} {t['time']}", "%d.%m.%Y %H:%M").replace(tzinfo=TZ)
    except ValueError:
        return None


def reg_end_dt(t: dict):
    st = start_dt(t)
    if not st or not t["reg_until"]:
        return st
    try:
        hh, mm = map(int, t["reg_until"].split(":"))
    except ValueError:
        return st
    end = st.replace(hour=hh, minute=mm)
    if end < st:  # регистрация переходит через полночь
        end += timedelta(days=1)
    return end


def is_deposit_only(t: dict) -> bool:
    blob = " ".join(t["notes"]).lower() + " " + t["ribbon"].lower()
    return "deposit" in blob and "no deposit" not in blob


# ---------------------------------------------------------------- telegram

POST_TZ = ZoneInfo(os.getenv("POST_TZ", "America/New_York"))
POST_TZ_LABEL = os.getenv("POST_TZ_LABEL", "ET")


def format_post(t: dict) -> str:
    e = html.escape
    st = start_dt(t)
    if st:
        local = st.astimezone(POST_TZ)
        today = datetime.now(POST_TZ).date()
        day = "TODAY'S" if local.date() <= today else "TOMORROW'S"
        when = local.strftime("%I:%M %p").lstrip("0") + f" {POST_TZ_LABEL}"
    else:
        day, when = "TODAY'S", f"{t['time']}"
    room = e(t["room"])
    if room and TRACKER_URL and t.get("room_slug") in ROOMS:
        room = f'<a href="{TRACKER_URL}/r/{t["room_slug"]}?p={t["id"]}">{room}</a>'
    title = f"{room} – {e(t['name'])}" if room else e(t["name"])
    lines = [
        f"🇺🇸 {day} POKER FREEROLLS",
        f"🃏 Tournament: {title}",
        f"🕒 Time: {when}",
    ]
    if t["prize"]:
        lines.append(f"💰 Prize Pool: {e(t['prize'])}")
    lines += [
        f"🔑 Password: <code>{e(t['password'])}</code>",
        "♠️ Good luck at the tables!",
    ]
    return "\n".join(lines)


def send(text: str) -> None:
    r = requests.post(
        f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
        json={
            "chat_id": CHANNEL,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        },
        timeout=30,
    )
    if r.status_code == 429:
        wait = r.json().get("parameters", {}).get("retry_after", 5)
        time.sleep(wait + 1)
        return send(text)
    if not r.ok:
        raise RuntimeError(f"Telegram: {r.status_code} {r.text}")


# ---------------------------------------------------------------- state

def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    return {"posted": {}}


def save_state(state: dict) -> None:
    cutoff = (datetime.now(TZ) - timedelta(days=3)).isoformat()
    state["posted"] = {k: v for k, v in state["posted"].items() if v.get("start", "") >= cutoff}
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")


# ---------------------------------------------------------------- main

def main(dry_run: bool = False) -> None:
    if not dry_run and not (BOT_TOKEN and CHANNEL):
        sys.exit("Нужны переменные TELEGRAM_BOT_TOKEN и TELEGRAM_CHANNEL")

    tournaments = {}
    for chunk in fetch_pages():
        for t in parse(chunk):
            tournaments[t["id"]] = t
    print(f"Турниров на сайте: {len(tournaments)}")

    state = load_state()
    now = datetime.now(TZ)
    to_post = []
    for t in tournaments.values():
        if not t["password"] or t["id"] in state["posted"]:
            continue
        st, end = start_dt(t), reg_end_dt(t)
        if not st or (end and end <= now):
            continue
        if st - now > timedelta(minutes=POST_AHEAD_MINUTES):
            continue
        if SKIP_DEPOSIT_ONLY and is_deposit_only(t):
            continue
        to_post.append(t)

    to_post.sort(key=lambda t: start_dt(t))
    print(f"К публикации: {len(to_post)}")
    for t in to_post:
        text = format_post(t)
        if dry_run:
            print("-" * 40 + "\n" + text)
            continue
        send(text)
        state["posted"][t["id"]] = {"start": start_dt(t).isoformat(), "password": t["password"]}
        time.sleep(3)

    if not dry_run:
        save_state(state)


if __name__ == "__main__":
    main(dry_run="--dry-run" in sys.argv)
