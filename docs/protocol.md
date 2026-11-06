# RecordStudio 通信仕様 v1
## 役割
receiverは収録PCのブラウザ1つ、senderはカメラ端末のブラウザ最大5つ。PC直結カメラと合計で最大5系統。Node.jsは認証・QR・シグナリングだけを担当し、録画データを受け取りません。
## 配布と接続先
GitHub Pages/Sitesは静的publicを配信します。Node.jsの`ip.txt`は必須、値は`127.0.0.1`に限定。config.jsonにHTTPSのappUrl、port、cloudflared、iceServersを指定します。許可する追加のUIオリジンはallowedAppOrigins配列で明示します。
シグナリングTLSはport、ローカル認証TLSはport+1。各起動で別々の64byte乱数をSHA-512へ通して128桁hexのURLトークンを生成します。シグナリングURLは`https://<random>.trycloudflare.com/<token>`。ローカル認証URLは`https://127.0.0.1:<port+1>/<admin-token>/`。
トークン不一致、未許可Origin、未知経路、壊れた認証はNode.jsのrequest.socket.destroy()で切断します。trycloudflareの向こうのクライアントとCloudflare edge間のTCPを、Node.jsから直接強制切断することはできません。Cloudflare側では502等に変換される場合があります。
## QRと鍵
receiver用とsender用に、互いに独立した32byte authKeyと32byte encryptionKeyを起動ごとに生成します。senderの鍵だけではreceiverとして認証できません。
QRの内容は静的ページURLの`#pair=<wrapped>`。フラグメントはWebサイトへのHTTPリクエストには含まれず、読み取り後にhistoryから消去します。localStorageへ秘密値は保存しません。
wrapの平文はJSON `{v:1,u:<endpoint>,a:<base64url authKey>,e:<base64url encryptionKey>,r:<role>}`。ランダム12byte IV、AES-256-GCM、AAD `RSKEY1`、16byte tagで包みbase64url化します。固定wrap鍵はtyped-voiceの形式を参考にした難読化であり、秘密保持の根拠にはしません。QRや接続URLを持つ人は、その役割で参加できるため取り扱いは接続キーと同等です。
## 認証
POST `<endpoint>/hello`へroleと32byte clientNonce。サーバーは20秒有効のランダムsessionId、32byte serverNonce、serverProofを返します。proof入力は`recordstudio/v1/<server|client>\n<role>\n`のUTF-8とclientNonce、serverNonceの連結。HMAC-SHA-256(authKey,input)を相互に検証します。
POST `<endpoint>/auth`へsessionIdとclientProof。成功時だけ参加を登録し、暗号化された設定を返します。未認証状態の保持は最大32件、認証済み最大8件、receiver1件、sender5件。未認証20秒、認証済み30秒の無通信で破棄します。
saltはclientNonceとserverNonceの連結。HKDF-SHA-256(encryptionKey,salt,info)で32byteの方向別鍵と4byteのnonce prefixを生成します。infoは`recordstudio/v1/c2s/key`、`s2c/key`、`c2s/nonce`、`s2c/nonce`。
## 暗号化シグナリング
POST `<endpoint>/rpc`はJSON `{id,frame}`。frameはbase64url(12byte header || ciphertext || 16byte GCM tag)。headerはbyte0=1、byte1〜3=0、byte4〜11=uint64BE連番。IVは方向別4byte prefixと8byte連番、AADはheader。送受信の連番は別々に0から開始し、順序不一致はセッションを破棄します。認証応答はs2cの0番、最初のrpc応答はs2cの1番です。
平文メッセージはpoll、signal(to,data)、leave。signal.dataはoffer、answer、iceだけで、最大120000文字。受信待ち最大128件、pollで最大64件を取得します。ブラウザは350ms間隔でpollし、各クライアントのRPCは直列化します。リクエスト上限160KiB、TLSのみ、CORSはconfigのUIオリジンに限定、Refererを送らずCookieを使いません。
ブラウザ同士のSDP fingerprintはこの認証済み経路で交換し、WebRTCがDTLSの鍵を確立します。公開tunnelにSDPやICEを平文で送信しません。WebRTCのメディア転送にはNode.js/Quick Tunnelを使いません。
## DataChannel
ラベル`recordstudio-v1`、ordered=true、maxRetransmits/maxPacketLifeTime指定なし。確実配送と順序を使用します。制御メッセージはJSON文字列、最大64KiB。request/replyでprepare、start、stop、pingを実行します。
バイナリは12byte headerと録画バイト。uint32BE magic=0x52530101、uint32BE seq=接続単位で0から、uint32BE length=payload長。payloadは最大48KiBかSCTP maxMessageSize-12の小さい方。受信順序と長さを検証し、ディスクwrite完了後にack(bytes=接続単位の累積書込済みbyte)を返します。
送信済み−ack済みは最大512KiB。DataChannelのbufferedAmountも512KiB未満を確認します。15秒応答がなければ停止します。MediaRecorderは500ms timesliceで出力し、イベントのBlobは64KiBずつ転送・保存。24MiBを超える録画キューは停止し、未保存分を破棄して不完全として報告します。無限待ちのため録画を一時停止して時間を詰める処理はしません。
prepareの応答に実際のmime/settings/bitrate。receiverは保存先を作成してから全カメラへ共通start時刻を送ります。pingの最小RTT標本から時計差を推定します。stopはMediaRecorderの最終dataavailableと送信キュー、ディスクackまで待ってからbytes/failedを返します。receiverはstopのbytesと当該ファイルbyteを比較し、一致しなければ不完全とします。
プレビューは受信した同じバイトをMediaSourceへ追加するだけで、保存の再エンコードは行いません。プレビューが未対応または2MiBの上限を超えたらプレビューのみを閉じます。
## 保存と回復
File System Access APIでは使用者の選択したフォルダへ逐次writeし、停止時にcloseします。閉じる前のブラウザ異常終了ではファイルのコミットが完了しないことがあります。長時間運用で異常終了への回復を重視する場合はブラウザ内保存を使用します。
ブラウザ内保存はOPFS専用WorkerのSyncAccessHandleでwriteし、2MiBごととclose時にflushします。次回起動時に「保存済みを開く」からファイルを列挙・ダウンロードできます。保存領域を消去するとファイルも消えるため、収録後は取り出してください。
開始情報と終了情報は別名JSONで保存します。切断、保存失敗、容量不足、転送不一致はincomplete。ハードウェア同期、完全無圧縮、任意カメラ5台での4K/120fps維持は保証しません。実測設定、時計差、開始時刻、保存byteをセッションJSONへ保存します。
