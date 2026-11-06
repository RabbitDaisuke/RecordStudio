# 動作確認 2026-11-06
## 配備
GitHub Pages: https://rabbitdaisuke.github.io/RecordStudio/
アクティブ配備: https://recordstudio-rabbit.daisukedaisuke389137.chatgpt.site/
GitHub Actionsの初回run 42202345471と修正版run 42203621261は、build/deployとも成功しました。
## 使用環境
利用者のWindows上のChromeをローカルMCP経由で操作。カメラはOBS Virtual Cameraの固定映像。クラウドブラウザのカメラや架空のカメラ入力で実測した結果ではありません。
## OBS 1系統
1920×1080、約30fps、H.264/MP4、約37.93秒、6065486byte。保存byte一致、ファイルからの動画デコード成功、ライブ表示1739フレームでドロップ0、終了時の録画キュー0byte。
## OBS 5系統
同一OBSカメラを5系統として開き、1920×1080、約30fps、約61.77秒を同時収録。5本とも9639864byte、ファイルからの動画デコード成功、セッションcomplete。5系統すべて録画キュー0byte。ライブ表示は各約1900フレーム中0〜1フレームのドロップ。
5秒間隔のJS heap標本は約1.08〜1.91MBの間で増減し、保存動画合計約48.2MBに比例する増加は観測しませんでした。GPUやブラウザ全体の使用量は未計測です。
## OBS→WebRTC→保存
実際のCapture、Peer、受信・保存・停止処理を使用し、同じローカルChrome内の2つのRTCPeerConnection間でOBSのH.264/MP4を転送。送信側録画バイト、受信保存、ACKは32400119byteで一致。送信側と受信ファイルのSHA-256が一致。プレビュー1920×1080、269フレームを表示、終了時の転送待ち0byte、senderの終了状態idle、処理エラーなし。
この検証ではシグナリング交換を検証用の直接経路で実行しており、実trycloudflareや別端末間での接続確認とは区別します。
## 通信・暗号
Node.js TLSサーバーに証明書を信頼したクライアントで接続成功。127.0.0.1 SAN、証明書の自己署名検証、URLトークンなしのソケット切断、相互HMAC認証、HKDF/AES-GCMの暗号化設定・poll応答、同じフレームのリプレイ切断を実動確認。
別の実WebRTC DataChannel経由で3145765byteをOPFSへ書き、ACK・保存サイズ・SHA-256一致を確認。
## QR
547文字のURLをversion16/L/mask0で生成し、ReportLabの独立したQRエンコーダの全6561モジュールと一致しました。
## 未確認範囲
物理カメラ5台のUSB帯域、別端末5台の無線帯域、長時間の発熱・ストレージ満了、実trycloudflareを通すQR認証と別ブラウザ端末からの接続は未確認です。利用者側のサーバー起動を通信フォルダの新規ファイルで依頼しています。
