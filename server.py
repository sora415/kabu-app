#!/usr/bin/env python3
"""株ウォッチリスト用のかんたんローカルサーバー。
追加インストール不要（Python標準ライブラリのみ）。
使い方:  python3 server.py  → ブラウザで http://localhost:8800 を開く
"""
import json
import os
import re
import socket
import base64
import threading
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("PORT", 8800))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/"
TRENDING = "https://query1.finance.yahoo.com/v1/finance/trending/"
NEWS_SEARCH = "https://query1.finance.yahoo.com/v1/finance/search"
TDNET = "https://webapi.yanoshin.jp/webapi/tdnet/"  # 日本株の適時開示(IR)

# ======================================================================
# Web Push（B方式：アプリ／スマホを閉じていても届く本物の通知）
#   ・レーティング（アナリスト評価）と目標株価の変化を検知して通知する
#   ・購読情報・前回値はファイルに保存（Renderでは再デプロイで消えるが再購読で復活）
# ======================================================================
try:
    from pywebpush import webpush, WebPushException
    PUSH_AVAILABLE = True
except Exception:
    PUSH_AVAILABLE = False

SUBS_FILE = os.path.join(BASE_DIR, "subscriptions.json")
STATE_FILE = os.path.join(BASE_DIR, "rating_state.json")
VAPID_FILE = os.path.join(BASE_DIR, "vapid_keys.json")
CHECK_TOKEN = os.environ.get("CHECK_TOKEN", "")
CHECK_INTERVAL = int(os.environ.get("CHECK_INTERVAL", "1800"))  # 秒（既定30分）
TARGET_THRESHOLD = 0.005  # 目標株価がこの割合(0.5%)以上動いたら通知
_push_lock = threading.Lock()


def _b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def load_vapid():
    """VAPID鍵を環境変数→ファイル→自動生成の順で用意する。"""
    pub = os.environ.get("VAPID_PUBLIC")
    priv = os.environ.get("VAPID_PRIVATE")
    subject = os.environ.get("VAPID_SUBJECT", "mailto:kabu-app@example.com")
    if pub and priv:
        return {"public": pub, "private": priv, "subject": subject}
    if os.path.exists(VAPID_FILE):
        try:
            with open(VAPID_FILE, encoding="utf-8") as f:
                d = json.load(f)
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
        with open(VAPID_FILE, "w", encoding="utf-8") as f:
            json.dump(d, f)
        return d
    except Exception as e:
        print("VAPID生成に失敗:", e)
        return None


VAPID = load_vapid()


def _load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _save_json(path, obj):
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)
    except Exception as e:
        print("保存失敗", path, e)


def load_subs():
    return _load_json(SUBS_FILE, {})


def save_subs(subs):
    _save_json(SUBS_FILE, subs)


# Yahoo の crumb/cookie をモジュール側でも持つ（通知チェック用）
_push_session = {"opener": None, "crumb": None}


def push_yahoo_session():
    import http.cookiejar
    s = _push_session
    if s["opener"] and s["crumb"]:
        return s["opener"], s["crumb"]
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    opener.addheaders = [("User-Agent", "Mozilla/5.0")]
    for seed in ("https://fc.yahoo.com", "https://finance.yahoo.com"):
        try:
            opener.open(seed, timeout=10)
        except Exception:
            pass
        if len(cj):
            break
    crumb = opener.open(
        "https://query1.finance.yahoo.com/v1/test/getcrumb", timeout=10
    ).read().decode("utf-8").strip()
    if not crumb or "<" in crumb:
        raise RuntimeError("crumb invalid")
    s["opener"], s["crumb"] = opener, crumb
    return opener, crumb


def fetch_rating(symbol):
    """1銘柄のアナリスト評価・目標株価を取得。失敗時はNone。"""
    try:
        opener, crumb = push_yahoo_session()
        url = (
            "https://query1.finance.yahoo.com/v10/finance/quoteSummary/"
            f"{urllib.parse.quote(symbol)}?modules=financialData,price&crumb={urllib.parse.quote(crumb)}"
        )
        with opener.open(url, timeout=12) as resp:
            d = json.loads(resp.read().decode("utf-8"))
        res = (d.get("quoteSummary", {}).get("result") or [{}])[0]
        fd = res.get("financialData") or {}
        price = res.get("price") or {}

        def raw(node, key):
            v = node.get(key)
            return v.get("raw") if isinstance(v, dict) else v

        name = price.get("shortName") or price.get("longName") or symbol
        return {
            "symbol": symbol,
            "name": name,
            "recKey": raw(fd, "recommendationKey"),
            "recMean": raw(fd, "recommendationMean"),
            "target": raw(fd, "targetMeanPrice"),
            "current": raw(fd, "currentPrice"),
        }
    except Exception:
        return None


# レーティングキー（英語）→日本語ラベル
REC_LABELS = {
    "strong_buy": "強い買い",
    "buy": "買い",
    "hold": "中立",
    "underperform": "やや売り",
    "sell": "売り",
}


def _fmt_price(v):
    if v is None:
        return "—"
    try:
        return f"{round(float(v)):,}"
    except Exception:
        return str(v)


def build_change_message(old, new):
    """前回値(old)と今回値(new)を比べ、変化があれば通知文を返す。なければNone。"""
    parts = []
    # レーティング変化（recommendationKey か recommendationMean の0.2以上の変化）
    ok, nk = (old or {}).get("recKey"), new.get("recKey")
    om, nm = (old or {}).get("recMean"), new.get("recMean")
    rating_changed = False
    if ok and nk and ok != nk:
        rating_changed = True
    elif om is not None and nm is not None and abs(nm - om) >= 0.2:
        rating_changed = True
    if rating_changed:
        ol = REC_LABELS.get(ok, ok or "—")
        nl = REC_LABELS.get(nk, nk or "—")
        parts.append(f"評価 {ol}→{nl}")
    # 目標株価変化
    ot, ntg = (old or {}).get("target"), new.get("target")
    if ot and ntg and ot != 0 and abs(ntg - ot) / ot >= TARGET_THRESHOLD:
        arrow = "↑" if ntg > ot else "↓"
        parts.append(f"目標株価 {_fmt_price(ot)}→{_fmt_price(ntg)}{arrow}")
    if not parts:
        return None
    return " / ".join(parts)


def send_one_push(sub, payload):
    """1つの購読へ通知を送る。失効(404/410)ならFalseを返して呼び出し側で削除。"""
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
            return False  # 失効：削除対象
        print("push送信エラー:", e)
        return True
    except Exception as e:
        print("push送信エラー:", e)
        return True


def check_ratings():
    """全購読の監視銘柄を調べ、変化があれば通知を送る。"""
    if not (PUSH_AVAILABLE and VAPID):
        return {"checked": 0, "sent": 0, "note": "push未設定"}
    with _push_lock:
        subs = load_subs()
        state = _load_json(STATE_FILE, {})
    if not subs:
        return {"checked": 0, "sent": 0}

    # 監視対象の全銘柄を集める
    all_syms = set()
    for info in subs.values():
        for s in info.get("symbols", []):
            all_syms.add(s)

    # 各銘柄の最新レーティングを取得し、変化メッセージを作る
    sym_messages = {}   # symbol -> (message, name)
    new_state = dict(state)
    for sym in all_syms:
        r = fetch_rating(sym)
        if not r:
            continue
        old = state.get(sym)
        snapshot = {"recKey": r["recKey"], "recMean": r["recMean"], "target": r["target"]}
        if old is not None:
            msg = build_change_message(old, r)
            if msg:
                sym_messages[sym] = (msg, r["name"])
        new_state[sym] = snapshot  # 初回はベースライン保存のみ（通知しない）

    # 変化があった銘柄について、その銘柄を監視している購読へ送信
    sent = 0
    dead = []
    for endpoint, info in subs.items():
        for sym in info.get("symbols", []):
            if sym in sym_messages:
                msg, name = sym_messages[sym]
                payload = {
                    "title": f"📊 {name}",
                    "body": msg,
                    "symbol": sym,
                    "tag": "rating-" + sym,
                }
                ok = send_one_push(info["sub"], payload)
                if ok:
                    sent += 1
                else:
                    dead.append(endpoint)
                    break

    # 後始末（失効した購読を削除、状態を保存）
    with _push_lock:
        subs2 = load_subs()
        for ep in dead:
            subs2.pop(ep, None)
        save_subs(subs2)
        _save_json(STATE_FILE, new_state)
    return {"checked": len(all_syms), "sent": sent}


def push_background_loop():
    """定期的にレーティングをチェック（サーバーが起きている間だけ動く）。"""
    while True:
        time.sleep(CHECK_INTERVAL)
        try:
            check_ratings()
        except Exception as e:
            print("定期チェック失敗:", e)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def log_message(self, *args):
        pass  # ログを静かに

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/quote":
            self.handle_quote(parse_qs(parsed.query))
            return
        if parsed.path == "/api/trending":
            self.handle_trending(parse_qs(parsed.query))
            return
        if parsed.path == "/api/search":
            self.handle_search(parse_qs(parsed.query))
            return
        if parsed.path == "/api/earnings":
            self.handle_earnings(parse_qs(parsed.query))
            return
        if parsed.path == "/api/quotes":
            self.handle_quotes(parse_qs(parsed.query))
            return
        if parsed.path == "/api/news":
            self.handle_news(parse_qs(parsed.query))
            return
        if parsed.path == "/api/ir":
            self.handle_ir(parse_qs(parsed.query))
            return
        if parsed.path == "/api/kabutan":
            self.handle_kabutan(parse_qs(parsed.query))
            return
        if parsed.path == "/api/push/publicKey":
            self.send_json({"key": VAPID["public"] if VAPID else None,
                            "available": bool(PUSH_AVAILABLE and VAPID)})
            return
        if parsed.path == "/api/push/check":
            q = parse_qs(parsed.query)
            if CHECK_TOKEN and (q.get("token") or [""])[0] != CHECK_TOKEN:
                self.send_json({"error": "forbidden"}, 403)
                return
            self.send_json(check_ratings())
            return
        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/push/subscribe":
            self.handle_subscribe()
            return
        if parsed.path == "/api/push/unsubscribe":
            self.handle_unsubscribe()
            return
        if parsed.path == "/api/push/test":
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

    def handle_subscribe(self):
        body = self.read_json_body()
        sub = body.get("subscription")
        symbols = [s for s in (body.get("symbols") or []) if isinstance(s, str)]
        if not sub or not sub.get("endpoint"):
            self.send_json({"error": "subscription required"}, 400)
            return
        with _push_lock:
            subs = load_subs()
            subs[sub["endpoint"]] = {"sub": sub, "symbols": symbols,
                                     "ts": int(time.time())}
            save_subs(subs)
        self.send_json({"ok": True, "count": len(symbols)})

    def handle_unsubscribe(self):
        body = self.read_json_body()
        ep = (body.get("endpoint") or
              (body.get("subscription") or {}).get("endpoint"))
        if not ep:
            self.send_json({"error": "endpoint required"}, 400)
            return
        with _push_lock:
            subs = load_subs()
            existed = subs.pop(ep, None) is not None
            save_subs(subs)
        self.send_json({"ok": True, "removed": existed})

    def handle_push_test(self):
        """購読確認用：自分宛にテスト通知を送る。"""
        body = self.read_json_body()
        sub = body.get("subscription")
        if not sub:
            # endpoint指定でも可
            ep = body.get("endpoint")
            with _push_lock:
                subs = load_subs()
            sub = (subs.get(ep, {}) or {}).get("sub") if ep else None
        if not sub:
            self.send_json({"error": "subscription required"}, 400)
            return
        payload = {"title": "🔔 通知テスト",
                   "body": "株アプリの通知が有効になりました。",
                   "tag": "test"}
        ok = send_one_push(sub, payload)
        self.send_json({"ok": ok})

    def handle_kabutan(self, query):
        # 株探(kabutan.jp)の値上がり率/値下がり率ランキングを取得して整形して返す。
        # dir=up → 値上がり率(mode=2_1), dir=down → 値下がり率(mode=2_2)
        direction = (query.get("dir") or ["up"])[0]
        mode = "2_2" if direction == "down" else "2_1"
        url = f"https://kabutan.jp/warning/?mode={mode}"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                html = resp.read().decode("utf-8", errors="replace")
        except Exception as e:
            self.send_json({"error": f"株探の取得に失敗しました: {e}", "rows": []}, 502)
            return
        rows = []
        for tr in re.findall(r"<tr>(.*?)</tr>", html, re.S):
            tds = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S)
            cells = [re.sub(r"\s+", " ", re.sub("<.*?>", "", c)).strip() for c in tds]
            # データ行はコード(3〜4桁＋任意の英字1)で始まる
            if len(cells) >= 9 and re.match(r"^\d{3,4}[A-Z]?$", cells[0]):
                code = cells[0]
                name = cells[1]
                market = cells[2]
                price = cells[5]
                change_yen = cells[7]
                change_pct = cells[8]
                m = re.search(r"-?[\d.]+", change_pct.replace(",", ""))
                pct_val = float(m.group()) if m else None
                rows.append({
                    "code": code, "name": name, "market": market,
                    "price": price, "changeYen": change_yen,
                    "changePct": change_pct, "pctVal": pct_val,
                })
            if len(rows) >= 30:
                break
        self.send_json({"dir": direction, "rows": rows})

    def handle_trending(self, query):
        # 今注目されている銘柄（Yahoo Finance のトレンド）を返す。毎回ライブ取得＝毎日自動で入れ替わる。
        region = re.sub(r"[^A-Za-z]", "", (query.get("region") or ["US"])[0]) or "US"
        try:
            count = max(1, min(30, int((query.get("count") or ["20"])[0])))
        except ValueError:
            count = 20
        url = f"{TRENDING}{region}?count={count}"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            results = data.get("finance", {}).get("result", []) or []
            quotes = results[0].get("quotes", []) if results else []
            symbols = [q.get("symbol") for q in quotes if q.get("symbol")]
            self.send_json({"region": region, "symbols": symbols})
        except Exception:
            # 取得できなくてもアプリは止めない（空で返す）
            self.send_json({"region": region, "symbols": []})

    def translate_ja(self, texts):
        """Google Translate 無料エンドポイントで日本語に翻訳（改行区切りバッチ）。"""
        if not texts:
            return texts
        joined = "\n".join(texts)
        url = (
            "https://translate.googleapis.com/translate_a/single"
            "?client=gtx&sl=auto&tl=ja&dt=t&q=" + urllib.parse.quote(joined)
        )
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            translated = "".join(s[0] for s in data[0] if s and s[0])
            parts = [p.strip() for p in translated.split("\n") if p.strip()]
            if len(parts) == len(texts):
                return parts
            # 件数がずれた場合は合わせる（残りは原文のまま）
            out = list(texts)
            for i, p in enumerate(parts):
                if i < len(out):
                    out[i] = p
            return out
        except Exception:
            return texts  # 翻訳失敗時は原文を返す

    def fetch_news_for_query(self, q, count=20):
        """Yahoo Finance search API からニュースを取得して正規化リストを返す。"""
        url = (
            f"{NEWS_SEARCH}?q={urllib.parse.quote(q)}"
            f"&newsCount={count}&lang=en-US&region=US"
            f"&enableFuzzyQuery=false&enableCb=false&enableNavLinks=false"
        )
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        items = []
        for n in data.get("news", []) or []:
            thumb = ""
            if n.get("thumbnail"):
                resols = n["thumbnail"].get("resolutions", []) or []
                if resols:
                    thumb = min(resols, key=lambda r: r.get("width", 9999)).get("url", "")
            items.append({
                "uuid": n.get("uuid", ""),
                "title": n.get("title", ""),
                "publisher": n.get("publisher", ""),
                "link": n.get("link", ""),
                "time": n.get("providerPublishTime", 0),
                "thumb": thumb,
            })
        return items

    # ページごとに銘柄・テーマを変えて多様な記事を取得（各ページ複数クエリを集約）
    US_NEWS_PAGES = [
        ["stock market S&P 500 NASDAQ"],           # p0: 全般
        ["AAPL", "MSFT", "NVDA"],                  # p1: 大型テック
        ["TSLA", "AMZN", "META"],                  # p2: 消費者テック
        ["JPM", "GS", "BAC"],                      # p3: 金融
        ["XOM", "CVX", "oil energy"],              # p4: エネルギー
        ["MRNA", "PFE", "JNJ"],                    # p5: ヘルスケア
        ["BTC-USD", "COIN", "ETH-USD"],            # p6: 仮想通貨
        ["INTC", "AMD", "ASML"],                   # p7: 半導体
        ["AMZN", "SHOP", "WMT"],                   # p8: 小売
        ["Federal Reserve inflation interest rates"], # p9: マクロ
    ]
    JP_NEWS_QUERIES = [
        ["^N225"],
        ["7203.T", "9984.T", "6758.T"],
        ["8035.T", "6861.T", "8306.T"],
        ["7974.T", "4502.T", "8058.T"],
        ["^N225"],   # 5ページ以降は先頭に戻る
    ]

    def handle_news(self, query):
        region = re.sub(r"[^A-Za-z]", "", (query.get("region") or ["US"])[0]) or "US"
        try:
            page = max(0, min(20, int((query.get("page") or ["0"])[0])))
        except (ValueError, TypeError):
            page = 0
        try:
            if region == "JP":
                queries = self.JP_NEWS_QUERIES[page % len(self.JP_NEWS_QUERIES)]
                seen, items = set(), []
                for q in queries:
                    try:
                        for item in self.fetch_news_for_query(q, count=10):
                            uid = item["uuid"] or item["title"]
                            if uid not in seen:
                                seen.add(uid)
                                items.append(item)
                    except Exception:
                        pass
                items.sort(key=lambda x: x["time"], reverse=True)
                items = items[:20]
            else:
                queries = self.US_NEWS_PAGES[page % len(self.US_NEWS_PAGES)]
                seen, items = set(), []
                for q in queries:
                    try:
                        for item in self.fetch_news_for_query(q, count=10):
                            uid = item["uuid"] or item["title"]
                            if uid not in seen:
                                seen.add(uid)
                                items.append(item)
                    except Exception:
                        pass
                items.sort(key=lambda x: x["time"], reverse=True)
                items = items[:20]

            # タイトルを日本語に翻訳
            titles = [item["title"] for item in items]
            translated = self.translate_ja(titles)
            for item, t in zip(items, translated):
                item["title"] = t
            self.send_json({"region": region, "items": items, "page": page})
        except Exception as e:
            self.send_json({"region": region, "items": [], "error": str(e)})

    # 適時開示(IR)のタイトルから「重要そうな種類」を判定する。該当しなければ None。
    IR_RULES = [
        (("上方修正",), "上方修正"),
        (("下方修正",), "下方修正"),
        (("業績予想", "予想の修正", "配当予想", "業績予想及び"), "業績・予想修正"),
        (("決算短信", "四半期報告", "中間決算"), "決算"),
        (("増配", "復配"), "増配"),
        (("減配", "無配"), "減配"),
        (("配当",), "配当"),
        (("自己株式", "自社株"), "自己株買い"),
        (("株式分割",), "株式分割"),
        (("株式併合",), "株式併合"),
        (("公開買付", "ＴＯＢ", "TOB"), "TOB"),
        (("ＭＢＯ", "MBO"), "MBO"),
        (("買収", "合併", "経営統合", "子会社化", "株式取得", "完全子会社"), "M&A"),
        (("資本提携", "業務提携", "業務・資本提携", "資本業務提携"), "提携"),
        (("減損", "特別損失"), "特別損失"),
        (("第三者割当", "新株式発行", "募集株式", "増資"), "増資"),
    ]

    def extract_pdf_url(self, url):
        """yanoshinのリダイレクトURLから直接のtdnet URLを取り出す。"""
        if not url:
            return ""
        # https://webapi.yanoshin.jp/rd.php?https://... → https://...
        m = re.search(r'rd\.php\?(https?://.+)', url)
        if m:
            return m.group(1)
        return url

    def ir_category(self, title):
        for keywords, label in self.IR_RULES:
            if any(k in title for k in keywords):
                return label
        return None

    def parse_jst(self, s):
        # "2026-06-04 20:00:00"（JST）を UNIX秒に変換
        try:
            dt = datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
            dt = dt.replace(tzinfo=timezone(timedelta(hours=9)))
            return int(dt.timestamp())
        except Exception:
            return 0

    def handle_ir(self, query):
        important_only = (query.get("important") or ["0"])[0] == "1"
        code = re.sub(r"[^0-9]", "", (query.get("code") or [""])[0])
        try:
            limit = max(1, min(100, int((query.get("limit") or ["60"])[0])))
        except (ValueError, TypeError):
            limit = 60
        path = f"list/{code}.json" if code else "list/recent.json"
        url = f"{TDNET}{path}?limit={limit}"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urllib.request.urlopen(req, timeout=12) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            items = []
            for entry in data.get("items", []) or []:
                t = entry.get("Tdnet", {}) or {}
                title = t.get("title", "") or ""
                cat = self.ir_category(title)
                important = cat is not None
                if important_only and not important:
                    continue
                raw_code = re.sub(r"[^0-9]", "", t.get("company_code", "") or "")
                code4 = raw_code[:4] if len(raw_code) >= 4 else raw_code
                items.append({
                    "id": t.get("id", ""),
                    "code": code4,
                    "company": t.get("company_name", ""),
                    "title": title,
                    "time": self.parse_jst(t.get("pubdate", "")),
                    "pdf": self.extract_pdf_url(t.get("document_url", "")),
                    "market": t.get("markets_string", ""),
                    "important": important,
                    "category": cat or "",
                })
            self.send_json({"items": items})
        except Exception as e:
            self.send_json({"items": [], "error": str(e)})

    # Yahoo の取引所コード → 表示名
    EXCH_DISP = {
        "JPX": "東証", "TYO": "東証", "NYQ": "NYSE", "NMS": "NASDAQ", "NGM": "NASDAQ",
        "NCM": "NASDAQ", "PCX": "NYSE Arca", "ASE": "NYSE American", "LSE": "London",
        "HKG": "香港", "SHH": "上海", "SHZ": "深圳", "TOR": "Toronto", "PNK": "OTC",
    }

    def _search_via_search(self, q):
        """英語名・コード向け：v1/finance/search を使う。"""
        url = (
            f"{NEWS_SEARCH}?q={urllib.parse.quote(q)}"
            f"&quotesCount=8&newsCount=0&listsCount=0&enableFuzzyQuery=false"
        )
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        out = []
        for it in data.get("quotes", []) or []:
            sym = it.get("symbol")
            if not sym:
                continue
            name = it.get("longname") or it.get("shortname") or it.get("longName") or ""
            out.append({
                "symbol": sym,
                "name": name,
                "exch": it.get("exchDisp") or it.get("exchange") or "",
                "type": it.get("quoteType") or it.get("typeDisp") or "",
            })
        return out

    def _search_via_lookup(self, q):
        """日本語名向け：v1/finance/lookup を使う（search は日本語を弾くため）。"""
        url = (
            "https://query1.finance.yahoo.com/v1/finance/lookup"
            f"?query={urllib.parse.quote(q)}&type=all&count=8&lang=ja-JP&region=JP"
        )
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        result = (data.get("finance", {}).get("result") or [])
        docs = result[0].get("documents", []) if result else []
        out = []
        for doc in docs:
            sym = doc.get("symbol")
            if not sym:
                continue
            name = doc.get("longName") or doc.get("shortName") or ""
            exch = doc.get("exchange") or ""
            out.append({
                "symbol": sym,
                "name": name,
                "exch": self.EXCH_DISP.get(exch, exch),
                "type": (doc.get("quoteType") or "").upper(),
            })
        return out

    def handle_search(self, query):
        """銘柄名・コードの候補を返す（オートコンプリート用）。
        英数字クエリは search、日本語など非ASCIIは lookup を使う。"""
        q = (query.get("q") or [""])[0].strip()
        if not q:
            self.send_json({"quotes": []})
            return
        is_ascii = all(ord(ch) < 128 for ch in q)
        try:
            if is_ascii:
                out = self._search_via_search(q)
                if not out:
                    out = self._search_via_lookup(q)
            else:
                out = self._search_via_lookup(q)
            self.send_json({"quotes": out})
        except Exception as e:
            self.send_json({"quotes": [], "error": str(e)})

    # Yahoo の crumb（認証トークン）をプロセス内でキャッシュ
    _crumb_cache = {"crumb": None, "opener": None}

    def get_yahoo_session(self):
        """quoteSummary などに必要な cookie + crumb を取得（キャッシュ）。"""
        import http.cookiejar
        c = Handler._crumb_cache
        if c["crumb"] and c["opener"]:
            return c["opener"], c["crumb"]
        cj = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
        opener.addheaders = [("User-Agent", "Mozilla/5.0")]
        # cookie を取得（404を返すが、その応答でCookieはセットされる）
        for seed in ("https://fc.yahoo.com", "https://finance.yahoo.com"):
            try:
                opener.open(seed, timeout=10)
            except Exception:
                pass
            if len(cj):
                break
        crumb = opener.open(
            "https://query1.finance.yahoo.com/v1/test/getcrumb", timeout=10
        ).read().decode("utf-8").strip()
        if not crumb or "<" in crumb:
            raise RuntimeError("crumb invalid")
        c["opener"], c["crumb"] = opener, crumb
        return opener, crumb

    def handle_earnings(self, query):
        """指定銘柄群の次回決算予定日を返す（決算カレンダー用）。"""
        raw = (query.get("symbols") or [""])[0]
        syms = [s.strip() for s in raw.split(",") if s.strip()][:40]
        if not syms:
            self.send_json({"items": []})
            return
        items = []
        try:
            opener, crumb = self.get_yahoo_session()
        except Exception as e:
            self.send_json({"items": [], "error": f"crumb取得失敗: {e}"})
            return
        for sym in syms:
            try:
                url = (
                    "https://query1.finance.yahoo.com/v10/finance/quoteSummary/"
                    f"{urllib.parse.quote(sym)}?modules=calendarEvents&crumb={urllib.parse.quote(crumb)}"
                )
                with opener.open(url, timeout=10) as resp:
                    d = json.loads(resp.read().decode("utf-8"))
                res = (d.get("quoteSummary", {}).get("result") or [{}])[0]
                ev = (res.get("calendarEvents") or {}).get("earnings") or {}
                dates = ev.get("earningsDate") or []
                ts = None
                if dates:
                    first = dates[0]
                    ts = first.get("raw") if isinstance(first, dict) else first
                items.append({
                    "symbol": sym,
                    "earningsTimestamp": ts,
                    "isEstimate": bool(ev.get("isEarningsDateEstimate")),
                })
            except Exception:
                items.append({"symbol": sym, "earningsTimestamp": None})
        self.send_json({"items": items})

    def handle_quotes(self, query):
        """複数銘柄をまとめて取得（時価総額つき）。NASDAQの寄与度・ヒートマップ用。"""
        raw = (query.get("symbols") or [""])[0]
        syms = [s.strip() for s in raw.split(",") if s.strip()][:120]
        if not syms:
            self.send_json({"quotes": []})
            return
        try:
            opener, crumb = self.get_yahoo_session()
        except Exception as e:
            self.send_json({"quotes": [], "error": f"crumb取得失敗: {e}"})
            return
        out = []
        # v7のbatch quoteは一度に多数取得できる。50件ずつに分割。
        for i in range(0, len(syms), 50):
            chunk = syms[i:i + 50]
            url = (
                "https://query1.finance.yahoo.com/v7/finance/quote"
                f"?symbols={urllib.parse.quote(','.join(chunk))}&crumb={urllib.parse.quote(crumb)}"
            )
            try:
                with opener.open(url, timeout=12) as resp:
                    d = json.loads(resp.read().decode("utf-8"))
                for q in (d.get("quoteResponse", {}).get("result") or []):
                    # 配当利回り：trailingAnnualDividendYield は小数(0.025=2.5%)。
                    # dividendYield は環境により%表記のことがあるので前者を優先。
                    dy = q.get("trailingAnnualDividendYield")
                    if dy is None:
                        dy = q.get("dividendYield")
                    out.append({
                        "symbol": q.get("symbol"),
                        "name": q.get("shortName") or q.get("longName") or q.get("symbol"),
                        "price": q.get("regularMarketPrice"),
                        "changePct": q.get("regularMarketChangePercent"),
                        "change": q.get("regularMarketChange"),
                        "marketCap": q.get("marketCap"),
                        "currency": q.get("currency", ""),
                        "per": q.get("trailingPE"),
                        "pbr": q.get("priceToBook"),
                        "divYield": dy,
                        "volume": q.get("regularMarketVolume"),
                    })
            except Exception:
                pass
        self.send_json({"quotes": out})

    def handle_quote(self, query):
        symbol = (query.get("symbol") or [""])[0].strip()
        explicit_range = bool(query.get("range"))
        rng = (query.get("range") or ["1mo"])[0]
        interval = (query.get("interval") or ["1d"])[0]
        if not symbol:
            self.send_json({"error": "symbol is required"}, 400)
            return
        # range指定なし＝価格表示用(ウォッチリスト/ヒートマップ/指数/ランキング)。
        # 「正規終値(regularMarketPrice) vs 前日終値(chartPreviousClose)」で前日比を出す。
        # ※時間外(プレ/アフター)を含めると当日比が水増しされてランキングが狂うため除外する。
        prepost = "true" if explicit_range else "false"
        if not explicit_range:
            rng, interval = "1d", "2m"
        url = f"{YAHOO}{urllib.parse.quote(symbol)}?range={rng}&interval={interval}&includePrePost={prepost}"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            self.send_json(self.simplify(symbol, data, interval))
        except urllib.error.HTTPError as e:
            self.send_json({"error": f"取得失敗 ({e.code}) 銘柄コードを確認してください"}, 502)
        except Exception as e:
            self.send_json({"error": f"通信エラー: {e}"}, 502)

    def simplify(self, symbol, data, interval="1d"):
        try:
            result = data["chart"]["result"][0]
            meta = result["meta"]
            timestamps = result.get("timestamp", []) or []
            q = (result.get("indicators", {}).get("quote", [{}]) or [{}])[0]
            opens = q.get("open") or []
            highs = q.get("high") or []
            lows = q.get("low") or []
            closes = q.get("close") or []
            volumes = q.get("volume") or []
            # ローソク足用に整列したOHLCVを作る（終値がNoneの足は除外）。
            candles = []
            for i in range(len(timestamps)):
                c = closes[i] if i < len(closes) else None
                if c is None:
                    continue
                o = opens[i] if i < len(opens) and opens[i] is not None else c
                h = highs[i] if i < len(highs) and highs[i] is not None else c
                l = lows[i] if i < len(lows) and lows[i] is not None else c
                v = volumes[i] if i < len(volumes) and volumes[i] is not None else 0
                candles.append({
                    "t": timestamps[i],
                    "o": round(float(o), 4), "h": round(float(h), 4),
                    "l": round(float(l), 4), "c": round(float(c), 4),
                    "v": int(v),
                })
            points = [k["c"] for k in candles]
            ts_clean = [k["t"] for k in candles]
            reg_price = meta.get("regularMarketPrice")
            prev_close = meta.get("chartPreviousClose") or meta.get("previousClose")
            if interval == "1d":
                # 日足チャート: チャート内の整合のため終値ベース(分割調整済みで揃う)。
                price = points[-1] if points else reg_price
                prev = points[-2] if len(points) >= 2 else prev_close
            else:
                # 日中足/ダッシュボード: Yahoo公式の正規終値 vs 前日終値で「前日比」を出す。
                # 時間外の最終足は使わない(夜間の値で当日比が水増しされるのを防ぐ)。
                price = reg_price if reg_price is not None else (points[-1] if points else None)
                prev = prev_close
            change = None
            change_pct = None
            if price is not None and prev:
                change = price - prev
                change_pct = change / prev * 100
            return {
                "symbol": symbol,
                "name": meta.get("longName") or meta.get("shortName") or symbol,
                "type": meta.get("instrumentType"),
                "currency": meta.get("currency", ""),
                "price": price,
                "previousClose": prev,
                "change": change,
                "changePct": change_pct,
                "timestamps": ts_clean,
                "closes": points,
                "candles": candles,
            }
        except (KeyError, IndexError, TypeError):
            return {"error": "データ形式が想定外でした", "symbol": symbol}

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
    host_name = socket.gethostname().replace(".local", "")
    print(f"株ウォッチリストを起動しました")
    print(f"  PC:           http://localhost:{PORT}")
    print(f"  スマホ(固定): http://{host_name}.local:{PORT}  ← おすすめ・変わらない")
    print(f"  スマホ(IP):   http://{local_ip}:{PORT}  ← 同じWi-Fiで開く")
    print("止めるには Ctrl+C を押してください")
    if PUSH_AVAILABLE and VAPID:
        print("  通知(Web Push): 有効")
        threading.Thread(target=push_background_loop, daemon=True).start()
    else:
        print("  通知(Web Push): 無効（pywebpush未インストール）")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
