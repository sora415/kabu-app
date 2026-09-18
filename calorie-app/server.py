#!/usr/bin/env python3
"""写真からカロリーを推定する かんたんWebアプリのサーバー。

使い方（ローカル）:
  1) APIキーを用意   :  export ANTHROPIC_API_KEY="sk-ant-..."
  2) ライブラリを入れる:  pip install -r requirements.txt
  3) サーバーを起動   :  python3 server.py
  4) ブラウザで開く   :  http://localhost:8900

仕組み:
  ・画面（index.html）で写真を選ぶ → その画像をこのサーバーに送る
  ・サーバーが Claude（AI）に画像を見せて、食べ物とカロリーを推定してもらう
  ・結果（JSON）を画面に返して表示する
"""
import base64
import json
import os
import re
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

PORT = int(os.environ.get("PORT", 8900))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# 使うAIモデル。精度重視の既定値。
#   ・安く/速くしたい場合は "claude-sonnet-5" や "claude-haiku-4-5" に変更してもOK。
#   ・環境変数 CALORIE_MODEL でも上書きできる。
MODEL = os.environ.get("CALORIE_MODEL", "claude-opus-5")

# AIへの指示（日本語）。JSONだけを返すようにお願いする。
SYSTEM_PROMPT = """あなたは料理写真から栄養を推定する管理栄養士アシスタントです。
写真に写っている食べ物・飲み物を見て、日本の一般的な分量を前提に、
それぞれの推定カロリー(kcal)を見積もってください。

重要な注意:
- 写真だけで正確なカロリーは測れません。あくまで「目安の推定値」です。
- 分量が分からない時は、写真に写る器や食材の大きさから常識的に推測してください。
- 食べ物が写っていない場合は items を空にして note で説明してください。

必ず次の形式の JSON だけを出力してください（前後に文章を付けない）:
{
  "items": [
    {"name": "食品名", "quantity": "推定した分量（例: 1杯・約200g）", "calories": 整数のkcal}
  ],
  "total_calories": 合計kcalの整数,
  "confidence": "high" または "medium" または "low",
  "note": "補足コメント（誤差の理由や前提など。日本語で1〜2文）"
}"""


def analyze_image(image_b64: str, media_type: str) -> dict:
    """画像を Claude に渡してカロリー推定の結果(dict)を返す。"""
    import anthropic  # 必要なときだけ読み込む

    client = anthropic.Anthropic()  # APIキーは環境変数 ANTHROPIC_API_KEY から自動で読まれる

    response = client.messages.create(
        model=MODEL,
        max_tokens=1500,
        system=SYSTEM_PROMPT,
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": image_b64,
                    },
                },
                {"type": "text", "text": "この写真の食べ物のカロリーを推定してください。"},
            ],
        }],
    )

    # 返答のテキストを取り出す
    text = "".join(block.text for block in response.content if block.type == "text")

    # JSON部分を安全に取り出してパースする
    return _extract_json(text)


def _extract_json(text: str) -> dict:
    """テキストからJSON部分を取り出して dict にする。失敗時は分かりやすい形で返す。"""
    text = text.strip()
    # ```json ... ``` のようなコードブロックが付く場合を除去
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.MULTILINE).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # 最初の { から最後の } までを抜き出して再挑戦
        m = re.search(r"\{.*\}", text, flags=re.DOTALL)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                pass
    # それでもダメなら、そのままの文章を note に入れて返す
    return {"items": [], "total_calories": 0, "confidence": "low", "note": text}


class Handler(SimpleHTTPRequestHandler):
    """静的ファイルの配信 ＋ /api/analyze の受付。"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def _send_json(self, status: int, obj: dict):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/api/analyze":
            self.send_error(404, "Not Found")
            return

        # APIキーの確認（未設定だと使えない）
        if not os.environ.get("ANTHROPIC_API_KEY"):
            self._send_json(500, {
                "error": "APIキーが設定されていません。環境変数 ANTHROPIC_API_KEY を設定してください。"
            })
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length)
            data = json.loads(raw.decode("utf-8"))
            image = data.get("image", "")

            # 画像は "data:image/jpeg;base64,XXXX" の形式で送られてくる
            m = re.match(r"data:(image/[a-zA-Z0-9.+-]+);base64,(.*)$", image, flags=re.DOTALL)
            if not m:
                self._send_json(400, {"error": "画像の形式が正しくありません。"})
                return
            media_type, image_b64 = m.group(1), m.group(2)

            result = analyze_image(image_b64, media_type)
            self._send_json(200, result)
        except Exception as e:  # noqa: BLE001 - 初心者向けに分かりやすいエラーを返す
            self._send_json(500, {"error": f"解析中にエラーが発生しました: {e}"})


def main():
    print(f"カロリー推定アプリを起動しました → http://localhost:{PORT}")
    print(f"使用モデル: {MODEL}")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("⚠ 注意: 環境変数 ANTHROPIC_API_KEY が未設定です。写真の解析はできません。")
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
