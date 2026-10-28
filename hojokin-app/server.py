#!/usr/bin/env python3
"""補助金ウォッチ用のかんたんサーバー（標準ライブラリのみ）。

できること:
  1. 補助金エントリの保存（名称・対象者・上限額・締切・公式リンク・3行要約・確認日）
  2. 情報源(公式ページ)を定期的に見にいって「補助金っぽい新着リンク」を検知
  3. 締切が近いエントリをプッシュ通知で知らせる
  4. 週次レポートの文章を自動で下書き

使い方:  python3 server.py  → ブラウザで http://localhost:8810 を開く
"""
import json
import os
import re
import html
import socket
import base64
import threading
import time
import uuid
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta, date
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, urljoin

PORT = int(os.environ.get("PORT", 8810))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
JST = timezone(timedelta(hours=9))

# ======================================================================
# 保存ファイル（公開リポジトリには上げない＝.gitignore 済み）
# ======================================================================
SUBSIDIES_FILE = os.path.join(BASE_DIR, "subsidies.json")      # 登録済み補助金
SOURCES_FILE = os.path.join(BASE_DIR, "sources.json")          # 監視する情報源
NEW_ITEMS_FILE = os.path.join(BASE_DIR, "new_items.json")      # 検知した未確認の新着
SRC_STATE_FILE = os.path.join(BASE_DIR, "source_state.json")   # 情報源ごとの既読リンク
REMINDED_FILE = os.path.join(BASE_DIR, "reminded.json")        # 締切通知の送信済み記録
SUBS_FILE = os.path.join(BASE_DIR, "subscriptions.json")       # プッシュ購読
VAPID_FILE = os.path.join(BASE_DIR, "vapid_keys.json")         # 通知の鍵

CHECK_TOKEN = os.environ.get("CHECK_TOKEN", "")
CHECK_INTERVAL = int(os.environ.get("CHECK_INTERVAL", "3600"))  # 秒（既定1時間）
# 締切まで何日になったら通知するか（近い順）
REMIND_DAYS = [14, 7, 3, 1]
# 新着リンクとして拾うキーワード（アンカー文字にこれが含まれたら候補）
SOURCE_KEYWORDS = [
    "補助", "助成", "支援金", "給付", "交付", "融資", "補助金",
    "事業者", "創業", "起業", "農業", "農家", "就農",
    "飲食", "宿泊", "観光", "商工", "販路", "設備",
]

# 最初から入れておく情報源（淡路島の農業・飲食・宿泊むけ）。画面から自由に追加・削除できる。
DEFAULT_SOURCES = [
    {"name": "洲本市 事業者向け情報", "url": "https://www.city.sumoto.lg.jp/life/2/"},
    {"name": "淡路市 公式サイト", "url": "https://www.city.awaji.lg.jp/"},
    {"name": "南あわじ市 公式サイト", "url": "https://www.city.minamiawaji.hyogo.jp/"},
    {"name": "兵庫県 公式サイト", "url": "https://web.pref.hyogo.lg.jp/"},
]

try:
    from pywebpush import webpush, WebPushException
    PUSH_AVAILABLE = True
except Exception:
    PUSH_AVAILABLE = False

_lock = threading.Lock()


# ======================================================================
# ちいさな保存ユーティリティ
# ======================================================================
def _load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _save_json(path, obj):
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print("保存失敗", path, e)


def load_sources():
    src = _load_json(SOURCES_FILE, None)
    if src is None:  # 初回は既定の情報源を書き込む
        _save_json(SOURCES_FILE, DEFAULT_SOURCES)
        return list(DEFAULT_SOURCES)
    return src


def today_jst():
    return datetime.now(JST).date()


def _b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


# ======================================================================
# Web Push（アプリ／スマホを閉じていても届く通知）── 株アプリと同じ仕組み
# ======================================================================
def load_vapid():
    pub = os.environ.get("VAPID_PUBLIC")
    priv = os.environ.get("VAPID_PRIVATE")
    subject = os.environ.get("VAPID_SUBJECT", "mailto:hojokin-app@example.com")
    if pub and priv:
        return {"public": pub, "private": priv, "subject": subject}
    if os.path.exists(VAPID_FILE):
        try:
            d = _load_json(VAPID_FILE, {})
            d.setdefault("subject", subject)
            return d
        except Exception:
            pass
    if not PUSH_AVAILABLE:
        return None
    try:
        from py_vapid import Vapid01
        from cryptography.hazmat.primitives import serialization
        v = Vapid01()
        v.generate_keys()
        pk = v.private_key
        priv_bytes = pk.private_numbers().private_value.to_bytes(32, "big")
        pub_bytes = pk.public_key().public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
        d = {"public": _b64u(pub_bytes), "private": _b64u(priv_bytes), "subject": subject}
        _save_json(VAPID_FILE, d)
        return d
    except Exception as e:
        print("VAPID生成に失敗:", e)
        return None


VAPID = load_vapid()


def load_subs():
    return _load_json(SUBS_FILE, {})


def save_subs(subs):
    _save_json(SUBS_FILE, subs)


def send_one_push(sub, payload):
    """1つの購読へ通知。失効(404/410)ならFalse（削除対象）。"""
    if not (PUSH_AVAILABLE and VAPID):
        return True
    try:
        webpush(
            subscription_info=sub,
            data=json.dumps(payload, ensure_ascii=False),
            vapid_private_key=VAPID["private"],
            vapid_claims={"sub": VAPID["subject"]},
            timeout=10,
        )
        return True
    except WebPushException as e:
        code = getattr(getattr(e, "response", None), "status_code", None)
        if code in (404, 410):
            return False
        print("push送信エラー:", e)
        return True
    except Exception as e:
        print("push送信エラー:", e)
        return True


def broadcast_push(payload):
    """全購読へ同じ通知を送る。失効した購読は掃除する。"""
    if not (PUSH_AVAILABLE and VAPID):
        return 0
    with _lock:
        subs = load_subs()
    sent, dead = 0, []
    for endpoint, info in subs.items():
        ok = send_one_push(info["sub"], payload)
        if ok:
            sent += 1
        else:
            dead.append(endpoint)
    if dead:
        with _lock:
            subs2 = load_subs()
            for ep in dead:
                subs2.pop(ep, None)
            save_subs(subs2)
    return sent


# ======================================================================
# 情報源チェック：公式ページの新着「補助金っぽいリンク」を検知
# ======================================================================
def fetch_links(url):
    """ページを取得し、(表示文, リンク先URL) の一覧を返す。"""
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read()
    # 文字コードは utf-8 を基本に、だめなら代替
    text = raw.decode("utf-8", "replace")
    links = []
    seen = set()
    for m in re.finditer(r'<a\s[^>]*href="([^"#]+)"[^>]*>(.*?)</a>', text, re.I | re.S):
        href = m.group(1).strip()
        label = html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", m.group(2)))).strip()
        if not label or len(label) < 4:
            continue
        full = urljoin(url, href)
        if full in seen:
            continue
        seen.add(full)
        links.append((label, full))
    return links


def check_sources(notify=True):
    """全情報源を見にいって、新着の補助金っぽいリンクを new_items に貯める。"""
    with _lock:
        sources = load_sources()
        state = _load_json(SRC_STATE_FILE, {})
        new_items = _load_json(NEW_ITEMS_FILE, [])

    known_item_urls = {it["url"] for it in new_items}
    added = []
    for src in sources:
        url = src.get("url")
        if not url:
            continue
        try:
            links = fetch_links(url)
        except Exception as e:
            print("取得失敗", url, e)
            continue
        # このページで見えた補助金っぽいリンク
        candidates = [(label, full) for (label, full) in links
                      if any(k in label for k in SOURCE_KEYWORDS)]
        prev_seen = set(state.get(url, []))
        if not prev_seen:
            # 初回はベースラインとして記録だけ（大量通知を防ぐ）
            state[url] = [full for (_, full) in candidates]
            continue
        for label, full in candidates:
            if full in prev_seen or full in known_item_urls:
                continue
            added.append({
                "id": uuid.uuid4().hex[:12],
                "title": label[:120],
                "url": full,
                "sourceName": src.get("name", url),
                "foundOn": today_jst().isoformat(),
            })
            known_item_urls.add(full)
        # 既読リンクを更新
        state[url] = sorted(prev_seen | {full for (_, full) in candidates})

    if added:
        new_items = added + new_items
    with _lock:
        _save_json(SRC_STATE_FILE, state)
        _save_json(NEW_ITEMS_FILE, new_items)

    if notify and added and (PUSH_AVAILABLE and VAPID):
        head = added[0]["title"]
        more = f" ほか{len(added) - 1}件" if len(added) > 1 else ""
        broadcast_push({
            "title": "🆕 新着の補助金かも",
            "body": head + more,
            "tag": "new-items",
            "url": "./index.html?tab=new",
        })
    return {"added": len(added)}


# ======================================================================
# 締切リマインド：締切が近いエントリを通知
# ======================================================================
def check_deadlines(notify=True):
    with _lock:
        subsidies = _load_json(SUBSIDIES_FILE, [])
        reminded = _load_json(REMINDED_FILE, {})
    today = today_jst()
    fired = 0
    for s in subsidies:
        dl = (s.get("deadline") or "").strip()
        if not dl:
            continue
        try:
            d = date.fromisoformat(dl)
        except Exception:
            continue
        days_left = (d - today).days
        if days_left < 0:
            continue
        # まだ通知していない「しきい値」のうち、今日以下で最も近いものを通知
        done = set(reminded.get(s["id"], []))
        due = [t for t in REMIND_DAYS if t not in done and days_left <= t]
        if not due:
            continue
        threshold = min(due)  # 一番近いしきい値で1回だけ
        if notify and (PUSH_AVAILABLE and VAPID):
            when = "本日締切" if days_left == 0 else f"あと{days_left}日"
            broadcast_push({
                "title": f"⏰ 締切が近い補助金（{when}）",
                "body": s.get("name", "（名称未設定）"),
                "tag": "deadline-" + s["id"],
                "url": "./index.html",
            })
        done.add(threshold)
        reminded[s["id"]] = sorted(done)
        fired += 1
    with _lock:
        _save_json(REMINDED_FILE, reminded)
    return {"reminded": fired}


def run_all_checks(notify=True):
    r1 = check_sources(notify=notify)
    r2 = check_deadlines(notify=notify)
    return {"sources": r1, "deadlines": r2}


def background_loop():
    while True:
        time.sleep(CHECK_INTERVAL)
        try:
            run_all_checks(notify=True)
        except Exception as e:
            print("定期チェック失敗:", e)


# ======================================================================
# 週次レポートの文章を下書き
# ======================================================================
def build_report():
    with _lock:
        subsidies = _load_json(SUBSIDIES_FILE, [])
    today = today_jst()
    week_ago = today - timedelta(days=7)

    def parse_dl(s):
        try:
            return date.fromisoformat(s["deadline"])
        except Exception:
            return None

    # 今週 確認・登録したもの
    recent = [s for s in subsidies
              if (s.get("checkedOn") or "") >= week_ago.isoformat()]
    # 締切が30日以内に迫っているもの（締切順）
    upcoming = []
    for s in subsidies:
        d = parse_dl(s)
        if d and 0 <= (d - today).days <= 30:
            upcoming.append((d, s))
    upcoming.sort(key=lambda x: x[0])

    lines = []
    lines.append(f"【補助金ウォッチ 週次レポート】{today.isoformat()}")
    lines.append("")
    lines.append("■ 今週あたらしく確認した補助金")
    if recent:
        for s in recent:
            lines.append(f"・{s.get('name','（名称未設定）')}"
                         f"（締切 {s.get('deadline') or '未定'} / 上限 {s.get('maxAmount') or '—'}）")
            if s.get("url"):
                lines.append(f"  {s['url']}")
    else:
        lines.append("・（今週の新規確認はありません）")
    lines.append("")
    lines.append("■ 締切が30日以内（締切が近い順）")
    if upcoming:
        for d, s in upcoming:
            days = (d - today).days
            when = "本日締切" if days == 0 else f"あと{days}日"
            lines.append(f"・[{when}] {s.get('name','（名称未設定）')}"
                         f"（締切 {s['deadline']} / 対象 {s.get('target') or '—'}）")
            if s.get("url"):
                lines.append(f"  {s['url']}")
    else:
        lines.append("・（30日以内の締切はありません）")
    lines.append("")
    lines.append("※ 金額・締切は必ず公式ページで最終確認してください。")
    return "\n".join(lines)


# ======================================================================
# 公式ページから3行要約の「下書き」を作る（あくまで下書き、人が直す前提）
# ======================================================================
def draft_summary(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            text = resp.read().decode("utf-8", "replace")
    except Exception as e:
        return {"error": f"ページを取得できませんでした: {e}"}
    title = ""
    m = re.search(r"<title[^>]*>(.*?)</title>", text, re.I | re.S)
    if m:
        title = html.unescape(re.sub(r"\s+", " ", m.group(1))).strip()
    desc = ""
    m = re.search(r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']+)', text, re.I)
    if m:
        desc = html.unescape(m.group(1)).strip()
    # 本文からそれっぽい段落を少し拾う
    body = re.sub(r"(?is)<(script|style|nav|header|footer)[^>]*>.*?</\1>", " ", text)
    body = html.unescape(re.sub(r"<[^>]+>", " ", body))
    body = re.sub(r"\s+", " ", body).strip()
    snippet = body[:200]
    draft = title
    if desc:
        draft += "\n" + desc
    elif snippet:
        draft += "\n" + snippet
    return {"draft": draft.strip(), "title": title}


# ======================================================================
# HTTPハンドラ
# ======================================================================
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def log_message(self, *args):
        pass

    def end_headers(self):
        try:
            parsed = urlparse(self.path)
            path = parsed.path
            if not path.startswith("/api/"):
                ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
                if "v=" in parsed.query and ext in ("js", "css"):
                    self.send_header("Cache-Control", "public, max-age=31536000, immutable")
                elif path in ("/", "") or ext == "html" or path.endswith(("sw.js", "manifest.json")):
                    self.send_header("Cache-Control", "no-cache")
                elif ext in ("png", "jpg", "jpeg", "webp", "svg", "ico"):
                    self.send_header("Cache-Control", "public, max-age=604800")
        except Exception:
            pass
        super().end_headers()

    # ---- GET ----
    def do_GET(self):
        parsed = urlparse(self.path)
        p, q = parsed.path, parse_qs(parsed.query)
        if p == "/api/subsidies":
            with _lock:
                self.send_json(_load_json(SUBSIDIES_FILE, []))
            return
        if p == "/api/sources":
            with _lock:
                self.send_json(load_sources())
            return
        if p == "/api/new-items":
            with _lock:
                self.send_json(_load_json(NEW_ITEMS_FILE, []))
            return
        if p == "/api/report":
            self.send_json({"text": build_report()})
            return
        if p == "/api/draft":
            url = (q.get("url") or [""])[0]
            if not url:
                self.send_json({"error": "url required"}, 400)
                return
            self.send_json(draft_summary(url))
            return
        if p == "/api/check":
            if CHECK_TOKEN and (q.get("token") or [""])[0] != CHECK_TOKEN:
                self.send_json({"error": "forbidden"}, 403)
                return
            self.send_json(run_all_checks(notify=True))
            return
        if p == "/api/push/publicKey":
            self.send_json({"key": VAPID["public"] if VAPID else None,
                            "available": bool(PUSH_AVAILABLE and VAPID)})
            return
        super().do_GET()

    # ---- POST ----
    def do_POST(self):
        parsed = urlparse(self.path)
        p = parsed.path
        if p == "/api/subsidies":
            self.handle_save_subsidy()
            return
        if p == "/api/subsidies/delete":
            self.handle_delete_subsidy()
            return
        if p == "/api/sources":
            self.handle_save_sources()
            return
        if p == "/api/new-items/dismiss":
            self.handle_dismiss_item()
            return
        if p == "/api/push/subscribe":
            self.handle_subscribe()
            return
        if p == "/api/push/unsubscribe":
            self.handle_unsubscribe()
            return
        if p == "/api/push/test":
            self.handle_push_test()
            return
        self.send_json({"error": "not found"}, 404)

    def read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length else b""
            return json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            return {}

    # ---- 補助金エントリの保存・削除 ----
    def handle_save_subsidy(self):
        body = self.read_json_body()
        name = (body.get("name") or "").strip()
        url = (body.get("url") or "").strip()
        if not name:
            self.send_json({"error": "名称は必須です"}, 400)
            return
        if not url:
            self.send_json({"error": "公式リンクは必須です（信用のため）"}, 400)
            return
        entry = {
            "id": body.get("id") or uuid.uuid4().hex[:12],
            "name": name,
            "target": (body.get("target") or "").strip(),
            "maxAmount": (body.get("maxAmount") or "").strip(),
            "deadline": (body.get("deadline") or "").strip(),
            "url": url,
            "summary": (body.get("summary") or "").strip(),
            "category": (body.get("category") or "その他").strip(),
            "checkedOn": (body.get("checkedOn") or today_jst().isoformat()).strip(),
            "note": (body.get("note") or "").strip(),
        }
        with _lock:
            items = _load_json(SUBSIDIES_FILE, [])
            for i, it in enumerate(items):
                if it.get("id") == entry["id"]:
                    items[i] = entry
                    break
            else:
                items.append(entry)
            _save_json(SUBSIDIES_FILE, items)
        self.send_json({"ok": True, "entry": entry})

    def handle_delete_subsidy(self):
        body = self.read_json_body()
        _id = body.get("id")
        with _lock:
            items = _load_json(SUBSIDIES_FILE, [])
            items = [it for it in items if it.get("id") != _id]
            _save_json(SUBSIDIES_FILE, items)
        self.send_json({"ok": True})

    # ---- 情報源の保存 ----
    def handle_save_sources(self):
        body = self.read_json_body()
        sources = body.get("sources")
        if not isinstance(sources, list):
            self.send_json({"error": "sources(list) required"}, 400)
            return
        clean = []
        for s in sources:
            url = (s.get("url") or "").strip()
            if not url:
                continue
            clean.append({"name": (s.get("name") or url).strip(), "url": url})
        with _lock:
            _save_json(SOURCES_FILE, clean)
        self.send_json({"ok": True, "count": len(clean)})

    # ---- 新着の確認済み（消す）----
    def handle_dismiss_item(self):
        body = self.read_json_body()
        _id = body.get("id")
        with _lock:
            items = _load_json(NEW_ITEMS_FILE, [])
            items = [it for it in items if it.get("id") != _id]
            _save_json(NEW_ITEMS_FILE, items)
        self.send_json({"ok": True})

    # ---- プッシュ購読（株アプリと同じ）----
    def handle_subscribe(self):
        body = self.read_json_body()
        sub = body.get("subscription")
        if not sub or not sub.get("endpoint"):
            self.send_json({"error": "subscription required"}, 400)
            return
        with _lock:
            subs = load_subs()
            subs[sub["endpoint"]] = {"sub": sub, "ts": int(time.time())}
            save_subs(subs)
        self.send_json({"ok": True})

    def handle_unsubscribe(self):
        body = self.read_json_body()
        ep = (body.get("endpoint") or (body.get("subscription") or {}).get("endpoint"))
        if not ep:
            self.send_json({"error": "endpoint required"}, 400)
            return
        with _lock:
            subs = load_subs()
            existed = subs.pop(ep, None) is not None
            save_subs(subs)
        self.send_json({"ok": True, "removed": existed})

    def handle_push_test(self):
        body = self.read_json_body()
        sub = body.get("subscription")
        if not sub:
            self.send_json({"error": "subscription required"}, 400)
            return
        ok = send_one_push(sub, {"title": "🔔 通知テスト",
                                 "body": "補助金ウォッチの通知が有効になりました。",
                                 "tag": "test"})
        self.send_json({"ok": ok})

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
    except Exception:
        local_ip = "127.0.0.1"
    print("補助金ウォッチを起動しました")
    print(f"  PC:         http://localhost:{PORT}")
    print(f"  スマホ(IP): http://{local_ip}:{PORT}  ← 同じWi-Fiで開く")
    print("止めるには Ctrl+C を押してください")
    # 情報源ファイルが無ければ既定を書き出しておく
    load_sources()
    if PUSH_AVAILABLE and VAPID:
        print("  通知(Web Push): 有効")
        threading.Thread(target=background_loop, daemon=True).start()
    else:
        print("  通知(Web Push): 無効（pywebpush未インストール／ローカルは通知なしでも動きます）")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
