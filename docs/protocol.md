# RecordStudio 通信仕様 v1
## 役割
receiverは収録PCのブラウザ1つ、senderはカメラ端末のブラウザ最大5つ。PC直結カメラと合計で最大5系統。Node.jsは認証・QR・シグナリングだけを担当し、録画データを受け取りません。
## 配布と接続先
標準ではNode.jsがpublicの静的HTML/JS/CSSも配信します。trycloudflareの`/<SHA-512 code>/app/`以下で提供し、全ファイルにURLコードを必須とします。ファイル名は固定の許可リストで、任意のローカルファイルは配信しません。appUrlを指定する場合はGitHub Pages/Sites等の静的配信も使用できます。
`ip.txt`は必須。Node.jsと同じPCで動作する収録ブラウザのLAN IPv4アドレスを一行指定します。Node.jsの待受アドレスではありません。この値は認証後の暗号化設定で両ブラウザへ渡し、ブラウザのICE host候補のアドレス解決に使用します。config.jsonにport、cloudflaredを指定します。STUN/TURNは使用しません。許可する追加のUIオリジンはallowedAppOrigins配列で明示します。
シグナリングTLSは127.0.0.1のport、ローカル認証TLSは127.0.0.1のport+1。Quick Tunnelは127.0.0.1のシグナリングポートだけへTLS接続します。映像転送にNode.jsやQuick Tunnelは使用しません。初回だけcrypto.randomBytes(1024)でseedを作り、.runtime/authentication.jsonにseedと整合性確認用SHA-256を保存します。時刻やMath.randomをseedにしません。URL認証コードはSHA-512(seed)の128桁hexです。SHA-256へ短縮しません。既存seedを読み込むのでセッション・プロセス再起動をまたいで同じコードを使います。シグナリングURLは`https://<random>.trycloudflare.com/<token>`。ローカル認証URLは`https://127.0.0.1:<port+1>/<admin-token>/`。Quick Tunnelのホスト名は再起動で変わることがありますが、認証コードは変えません。
トークン不一致、未許可Origin、未知経路、壊れた認証はNode.jsのrequest.socket.destroy()で切断します。trycloudflareの向こうのクライアントとCloudflare edge間のTCPを、Node.jsから直接強制切断することはできません。Cloudflare側では502等に変換される場合があります。
## QRと鍵
receiver用とsender用の32byte authKeyと32byte encryptionKeyは、保存した1024byte seedを鍵とするHMAC-SHA-256と用途別ラベルから復元します。URLへ出すSHA-512値からこれらの鍵を復元することはできません。senderの鍵だけではreceiverとして認証できません。セッションnonceと方向別セッション鍵は接続ごとに生成します。
QRとコピーする接続URLの内容は`https://<random>.trycloudflare.com/<SHA-512 token>/connect/<role>#pair=rsk2.<key>.<payload>`。QRもURL手動入力も同じ入口を使います。Node.jsがURLトークンを検証後、秘密値を含まない接続HTMLで静的クライアントへ移動します。フラグメントはトンネルや静的サイトへのHTTPリクエストには含まれず、クライアントで読み取った後historyから消去します。localStorageへ秘密値は保存しません。
payloadの平文はJSON `{v:1,u:<endpoint>,a:<base64url authKey>,e:<base64url encryptionKey>,r:<role>}`。招待ごとにランダム32byte wrap鍵と12byte IVを生成し、AES-256-GCM、AAD `RecordStudio invitation v2`、16byte tagで包みます。wrap鍵も招待のフラグメントに入るため、招待の所持自体が権限です。ソースに共通の秘密鍵や認証コードを埋め込みません。招待は同一公開origin内で固定し、QRを数秒ごとに変更しません。
URLコードは128桁hexの形式を検査後、64byte同士をtimingSafeEqualで比較します。接続最大40、TLSとHTTPヘッダの期限5秒、要求の期限12秒、ヘッダ4KiB、body160KiB、認証待ち32を上限とします。10秒ごとに送信元300要求・HELLO8件・認証失敗8件、全体600要求までとし、超過時はソケットを切断します。送信元の保持は1024件まで。認証失敗で制限済みの送信元は全体予算を消費させません。これらはNode.js側の資源上限であり、回線規模のDDoSを防げるという保証ではありません。
送信クライアントはURLトークン付きの経路から得た招待を検証し、相互HMAC認証と暗号化設定応答の検証が成功するまでカメラ起動ボタンと設定を有効にしません。接続先や認証値を埋め込んだ検証用経路は製品に含めません。
## 認証
POST `<endpoint>/hello`へroleと32byte clientNonce。サーバーは20秒有効のランダムsessionId、32byte serverNonce、serverProofを返します。proof入力は`recordstudio/v1/<server|client>\n<role>\n`のUTF-8とclientNonce、serverNonceの連結。HMAC-SHA-256(authKey,input)を相互に検証します。
POST `<endpoint>/auth`へsessionIdとclientProof。成功時だけ参加を登録し、暗号化された設定を返します。未認証状態の保持は最大32件、認証済み最大8件、receiver1件、sender5件。未認証20秒、認証済み30秒の無通信で破棄します。
saltはclientNonceとserverNonceの連結。HKDF-SHA-256(encryptionKey,salt,info)で32byteの方向別鍵と4byteのnonce prefixを生成します。infoは`recordstudio/v1/c2s/key`、`s2c/key`、`c2s/nonce`、`s2c/nonce`。
## 暗号化シグナリング
POST `<endpoint>/rpc`はJSON `{id,frame}`。frameはbase64url(12byte header || ciphertext || 16byte GCM tag)。headerはbyte0=1、byte1〜3=0、byte4〜11=uint64BE連番。IVは方向別4byte prefixと8byte連番、AADはheader。送受信の連番は別々に0から開始し、順序不一致はセッションを破棄します。認証応答はs2cの0番、最初のrpc応答はs2cの1番です。
平文メッセージはpoll、signal(to,data)、leave。signal.dataはoffer、answer、iceだけで、最大120000文字。受信待ち最大128件、pollで最大64件を取得します。ブラウザは350ms間隔でpollし、各クライアントのRPCは直列化します。リクエスト上限160KiB、TLSのみ、CORSはconfigのUIオリジンに限定、Refererを送らずCookieを使いません。
ブラウザ同士のSDP fingerprintはこの認証済み経路で交換し、WebRTCがDTLSの鍵を確立します。公開tunnelにSDPやICEを平文で送信しません。WebRTCのメディア転送にはNode.js/Quick Tunnelを使いません。接続成立後にシグナリングが停止しても、既に開いているDataChannelとその収録を維持します。新しい端末の接続にはサーバーの再起動・再接続が必要です。
## DataChannel
ラベル`recordstudio-v1`、ordered=true、maxRetransmits/maxPacketLifeTime指定なし。確実配送と順序を使用します。制御メッセージはJSON文字列、最大64KiB。request/replyでprepare、start、stop、pingを実行します。
バイナリは12byte headerと録画バイト。uint32BE magic=0x52530101、uint32BE seq=接続単位で0から、uint32BE length=payload長。payloadは最大48KiBかSCTP maxMessageSize-12の小さい方。受信順序と長さを検証し、ディスクwrite完了後にack(bytes=接続単位の累積書込済みbyte)を返します。
送信済み−ack済みは最大512KiB。DataChannelのbufferedAmountも512KiB未満を確認します。15秒応答がなければ停止します。MediaRecorderは500ms timesliceで出力し、イベントのBlobは64KiBずつ転送・保存。24MiBを超える録画キューは停止し、未保存分を破棄して不完全として報告します。無限待ちのため録画を一時停止して時間を詰める処理はしません。
prepareの応答に実際のmime/settings/bitrate。receiverは保存先を作成してから全カメラへ共通start時刻を送ります。pingの最小RTT標本から時計差を推定します。stopはMediaRecorderの最終dataavailableと送信キュー、ディスクackまで待ってからbytes/failedを返します。receiverはstopのbytesと当該ファイルbyteを比較し、一致しなければ不完全とします。
送信クライアントは専用のcamera.html/camera.jsで動作し、自分のカメラ映像・録画状態・設定だけを表示します。受信画面、別カメラの情報、ファイル一覧、保存先操作を送信クライアントに読み込みません。接続用QRはcamera.htmlを直接開きます。旧形式のindex.htmlへのカメラ用招待は専用ページへ移動します。
受信した他端末の録画バイトは保存だけを行い、MediaSourceへの追加、自動再生、再エンコードは行いません。送信側は自分のカメラ映像だけを表示します。
## LAN経路
RTCPeerConnectionのiceServersは常に空。UDP host候補だけを送受信し、srflx/relay/TCP候補は除外します。収録ブラウザは生成した候補のmDNSアドレスをip.txtのIPv4へ置き換え、SDP内の候補とtrickle ICEの両方に適用します。送信ブラウザは収録側候補のIPが設定値と一致しない場合に受け付けません。
DataChannel開始時・各映像パケット送信前・ICE経路変更時にgetSelectedCandidatePairで実際の相手先を確認します。送信側のremote.addressが設定IP、protocolがUDP、候補typeがhostまたはprflxでなければ停止します。Node.jsはSDP/ICEの暗号化交換だけを担当し、WebRTCを終端・プロキシしません。
## 保存と回復
File System Access APIでは使用者の選択したフォルダへ逐次writeし、停止時にcloseします。閉じる前のブラウザ異常終了ではファイルのコミットが完了しないことがあります。長時間運用で異常終了への回復を重視する場合はブラウザ内保存を使用します。
ブラウザ内保存はOPFS専用WorkerのSyncAccessHandleでwriteし、2MiBごととclose時にflushします。次回起動時に「保存済みを開く」からファイルを列挙・ダウンロードできます。保存領域を消去するとファイルも消えるため、収録後は取り出してください。
開始情報と終了情報は別名JSONで保存します。切断、保存失敗、容量不足、転送不一致はincomplete。ハードウェア同期、完全無圧縮、任意カメラ5台での4K/120fps維持は保証しません。実測設定、時計差、開始時刻、保存byteをセッションJSONへ保存します。
