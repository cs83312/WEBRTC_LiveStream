# WEBRTC_LiveStream — 醫療 1對1 視訊看診

醫師 ↔ 病患點對點視訊看診服務。重點：**即時**（P2P 直連、音訊優先）、**穩定**（TURN、ICE restart、斷線自動恢復、自適應碼率）、**安全**（預約 token、候診室、HTTPS/WSS、DTLS-SRTP、稽核紀錄、不錄影）。

## 架構

```
瀏覽器(醫師) ──WSS 信令── Node.js (Express + Socket.IO) ──WSS 信令── 瀏覽器(病患)
      └──────────── DTLS-SRTP 加密影音（直連，或經 coturn 中繼）────────────┘
```

- 影音不經過應用伺服器；TURN 中繼時也只轉送加密封包，無法解密。
- `server/`：`auth.js` 預約 token（JWT）、`signaling.js` 候診室 / 信令轉發 / 斷線寬限、`turn.js` 臨時 TURN 憑證、`audit.js` 稽核紀錄。
- `public/js/`：`call.js` RTCPeerConnection（perfect negotiation、ICE restart、DataChannel 心跳、RED 冗餘音訊）、`quality.js` 品質監測與自適應碼率、`media.js` 裝置處理、`main.js` 流程與 UI。

## 開發

```bash
npm install
cp .env.example .env      # 開發可先留空，會自動產生隨機密鑰
npm run dev
# 開啟 http://localhost:8009/dev/new 取得醫師端 / 病患端測試連結
npm test
```

在手機或其他電腦測試時必須使用 HTTPS（瀏覽器規定）：用 [mkcert](https://github.com/FiloSottile/mkcert) 產生 `localhost` 與區網 IP 的憑證，填入 `TLS_CERT` / `TLS_KEY`。

## 建立預約（給預約系統呼叫）

```bash
curl -X POST https://consult.example.com/api/appointments \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"startsAt":"2026-10-01T09:00:00+08:00","durationMinutes":15}'
```

回傳 `doctorUrl`、`patientUrl`。token 放在 URL `#` 之後，不會進入伺服器日誌或 Referer；有效期為看診時段前後各 30 分鐘（可調）。

## 正式部署

1. `NODE_ENV=production`，設定 `JWT_SECRET`、`ADMIN_API_KEY`、`TURN_SECRET`（各 32 bytes 隨機）。
2. TLS：直接設定憑證，或放在反向代理後並設 `TRUST_PROXY=true`（代理需支援 WebSocket）。
3. TURN：修改 `deploy/turnserver.conf`（realm、`static-auth-secret` = `TURN_SECRET`、`external-ip`、憑證），`docker compose -f deploy/docker-compose.yml up -d`；防火牆開 3478/udp+tcp、443/tcp、49160-49200/udp。
4. `.env` 設定 `STUN_URLS` / `TURN_URLS`（務必包含 `turns:...:443?transport=tcp`，醫院網路常只放行 443）。
   若不希望醫病雙方得知彼此 IP，設 `ICE_TRANSPORT_POLICY=relay`（所有影音經 TURN，伺服器頻寬需求較高）。
5. 目前房間狀態存在記憶體，請以單一實例執行（1對1 看診的負載很小）；要水平擴充需加上 Socket.IO Redis adapter 與共享狀態。
   重啟信令伺服器時進行中的通話不會中斷（醫師端會自動重新核准同一病患頁面），但「已結束的預約」清單會遺失，重啟後到期前的舊連結可再次進入；正式環境建議將其改存資料庫。

## 測試與驗證

- `npm test`：token 驗證、候診室、信令白名單、斷線寬限 / 重連、結束看診、API 與安全標頭。
- 本機 TURN 測試（Docker Desktop）：
  ```bash
  export TURN_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  TURN_EXTERNAL_IP=<本機區網 IP> docker compose -f deploy/local/docker-compose.yml up -d
  TURN_URLS="turn:<本機區網 IP>:3478?transport=udp" ICE_TRANSPORT_POLICY=relay npm run dev
  ```
  TURN 位址請用區網 IP 而非 `127.0.0.1`：瀏覽器取得鏡頭權限後會逐一綁定網卡，連不到 loopback 上的 TURN。品質指示燈的提示文字會顯示「經 TURN 中繼」，也可在 `chrome://webrtc-internals` 確認候選為 relay。
- 弱網路自動測試（需先啟動上面的本機 coturn 與本機 Chrome）：
  ```bash
  TURN_SECRET=<同 coturn> TURN_HOST=<本機區網 IP> npm run test:weak-network
  ```
  兩個瀏覽器經由一個 UDP 干擾代理連到 TURN（效果同 clumsy 篩選 TURN 埠，但不需管理員權限），依序跑基準 → 中度（RTT 約 150 ms、掉包 2–5%）→ 嚴重（RTT 約 300–490 ms、掉包 8–16%）→ 恢復 → 完全斷線 12 秒，檢查通話不斷、音訊持續、自動降 / 升碼率、建議純語音與自動恢復。加 `AB_DISABLE_RED=1` 可與純 Opus 對照（實測嚴重弱網下音訊補償比例 8.9% → 0.9%）。
  Docker Desktop（WSL2）核心不含 netem，無法用 `tc` 在容器內模擬。
- 手動：Windows 也可用 [clumsy](https://jagt.github.io/clumsy/)（需管理員）模擬掉包 / 延遲；拔網路線 10 秒再接回應自動恢復。

## 合規檢查表（非程式項目）

| 項目 | 說明 |
| --- | --- |
| 資料在地化 | 應用伺服器、TURN、稽核日誌放在台灣境內機房 / 雲端區域 |
| 通訊診察治療辦法 | 診療紀錄與病人身分核對屬 HIS / 病歷系統，本服務只提供通訊；醫師須於看診時核對身分 |
| 個資法 | 病患進入前須勾選同意（已實作）；需另備完整個資告知文件與連結 |
| HIPAA | 與雲端 / 主機業者簽 BAA；稽核日誌保存期限依政策設定（`AUDIT_RETENTION_DAYS`） |
| 稽核紀錄 | `logs/audit-*.jsonl` 只記錄 metadata（預約編號、角色、事件、時間、IP、通話品質），不含影音 / SDP / token |
| 錄影 | 本服務不錄影；如需錄影須另行評估同意、加密儲存與保存期限 |
| 弱點管理 | 定期 `npm audit`、更新 coturn 與 Node.js |

---

學習來源：[How To Create A Video Chat App With WebRTC](https://www.youtube.com/watch?v=DvlyzDZDEq4&ab_channel=WebDevSimplified)
