#!/bin/bash
# このファイルをダブルクリックすると株ウォッチリストが起動します。
# 止めるときは、開いたターミナルのウィンドウで Ctrl+C を押すか、ウィンドウを閉じてください。

cd "$(dirname "$0")"

# 1秒後にブラウザを自動で開く
( sleep 1; open "http://localhost:8800" ) &

echo "株ウォッチリストを起動します..."
python3 server.py
