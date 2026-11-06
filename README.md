# RecordStudio
1〜5台のカメラを同時収録するブラウザアプリ。白系の画面、PC直結カメラ、別端末のカメラ、WebRTCでの録画バイト転送に対応します。
## 起動
Node.js 22以上とcloudflaredを用意します。npm installは不要です。
`ip.example.txt`を`ip.txt`へコピーし、このPCの待受用IPv4アドレスをUTF-8で一行指定します。`192.168.1.10`などのLANアドレスと`127.0.0.1`を指定できます。ファイルが存在しない場合や、IPアドレスではない値は起動を拒否します。自動DNS解決で待受アドレスを決定しません。
`config.example.json`を`config.json`へコピーし、`appUrl`を使うGitHub PagesまたはSitesのHTTPS URLにします。cloudflaredがPATHにない場合は`cloudflared`に実行ファイルの絶対パスを指定します。
`node server.mjs`または`Start.cmd`で起動します。Node.jsの外部パッケージ依存はありません。
コンソールのAuthentication / QRリンクを開き、初回のローカル証明書を確認後、「収録画面を開く」を押します。カメラ端末ではQRを読み取り、カメラを追加します。
PCで保存先を選び「収録を開始」を押します。カメラは1台から使用できます。PC直結と別端末を合計して最大5台です。
送信クライアントは専用のcamera.htmlで、自分のカメラ映像と自分の録画状態だけを表示します。
## 保存
カメラ側のMediaRecorderで一度だけエンコードします。別端末はその出力バイトをreliable/ordered WebRTC DataChannelで転送し、PCブラウザが再エンコードせず書き込みます。Node.jsへ映像は送信しません。
PCのフォルダへ順次書き込む方式と、OPFSへWorkerから書き込む方式があります。OPFSのファイルは「保存済みを開く」から取り出せます。録画全体をBlob配列へ蓄積しません。送信窓512KiB、DataChannelパケット最大48KiB、各カメラの録画キュー24MiB、プレビューキュー2MiBを上限とし、書き込みが追いつかなければ停止して不完全として記録します。ブラウザ内部のエンコーダやOSのバッファはアプリから完全には制御できません。
各カメラの映像と`*_session.json`を保存します。MP4/WebMは実際に利用できる形式から選択します。最大画質はカメラの設定値と実際の解像度・fpsを画面で確認できます。USB帯域、端末の発熱、ブラウザのエンコーダにより同時に維持できる画質は異なります。
映像はカメラごとに別ファイルです。同じ開始時刻を各端末へ予約し、端末間の時計差と実際の開始時刻を記録します。ハードウェアによるフレーム同期は保証しません。
## 接続
Node.jsはTLS 1.3でip.txtに指定したアドレスへ待受します。認証・QRページだけは別ポートの127.0.0.1で待ち受け、Quick Tunnelには公開しません。Quick Tunnelは指定IPのシグナリング用ポートへ接続し、そのIPのSANを含めて生成した証明書をCAとして検証します。
URLのSHA-512トークン、QRの難読化、起動ごとの認証鍵・暗号鍵、nonceによる相互HMAC認証、方向別HKDF/AES-256-GCMを実装しています。typed-voice-serverとtyped-voiceの添付コードを参照し、RecordStudio用の通信ラベルと役割分離で実装しました。固定QR wrap鍵は公開難読化用で、認証の秘密は起動ごとの鍵です。
同じネットワーク内での直接通信が標準です。ネットワークを越える場合は`config.json`の`iceServers`へ使用するSTUN/TURNを明示してください。自動で第三者のSTUN/TURNを追加しません。TURNを設定した場合も映像通信はWebRTCのDTLSで暗号化され、Node.jsは中継しません。
## 配備
GitHub Actionsでpublicをdistへビルドし、GitHub Pagesへ配備します。サーバー配布ZIPもArtifactsへ出力します。npmのインストールは行いません。
詳しい通信仕様は[docs/protocol.md](docs/protocol.md)を参照してください。
