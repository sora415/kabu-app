#!/usr/bin/env python3
"""株ウォッチリストを「独立したウィンドウのデスクトップアプリ」として起動する。
ブラウザもターミナルも使わず、macOSのネイティブウィンドウ(WKWebView)で表示する。
内部で既存の server.py をバックグラウンド起動し、画面とデータ取得をそのまま使う。
"""
import os
import sys
import threading
from http.server import ThreadingHTTPServer

# 同じフォルダの server.py を読み込む
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server


def start_background_server():
    # ポート0 = 空いているポートを自動で確保（他アプリと衝突しない）
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd.server_address[1]


def main():
    port = start_background_server()
    url = f"http://127.0.0.1:{port}"

    # 動作確認用（KABU_TEST=1 のときはウィンドウを開かずに応答だけ確認して終了）
    if os.environ.get("KABU_TEST"):
        import urllib.request
        print("PORT", port)
        print("STATUS", urllib.request.urlopen(url, timeout=5).status)
        return

    import webview
    webview.create_window(
        "株ウォッチリスト",
        url,
        width=1120,
        height=780,
        min_size=(720, 520),
    )
    webview.start()


if __name__ == "__main__":
    main()
