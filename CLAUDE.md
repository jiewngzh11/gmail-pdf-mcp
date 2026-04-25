# Gmail PDF MCP Server — Claude 部署指南

這份文件是給 Claude 看的。你的任務是幫助使用者將這個專案部署到他自己的 Azure 上，並設定好讓 Claude Desktop App 或 Claude Code 可以使用。

使用者沒有程式基礎，所有指令都由你來執行，你只需要在需要人工操作時（例如瀏覽器登入、複製貼上金鑰）暫停並告訴使用者要做什麼。

---

## 這個專案是什麼

一個 MCP (Model Context Protocol) Server，讓 Claude 能夠：
- 搜尋 Gmail 中主旨含關鍵字的郵件
- 將郵件（含附件）轉換為 PDF
- 自動儲存 PDF 至使用者的 **Google Drive**（`Gmail PDF MCP/{寄件人}/` 資料夾）

技術棧：Node.js + TypeScript，Puppeteer（HTML→PDF），pdf-lib（合併），Gmail API，Google Drive API，Azure Container Apps（部署），GitHub Actions（CI/CD）。

**授權流程**：符合 MCP Authorization 規範（RFC 6749）。Claude Desktop App 或 Claude Code 連上 MCP Server 時，會**自動跳出瀏覽器要求授權**（Gmail 讀取 + Google Drive 存檔），不需要手動呼叫任何工具。

---

## 使用者已準備好的帳號

- **Google Cloud Console** 帳號（用來建立 OAuth2 憑證）
- **GitHub** 帳號（用來 Fork 專案並觸發自動部署）
- **Azure** 帳號（用來建立雲端資源）

---

## 部署流程總覽

```
1. Fork GitHub repo
2. 建立 Google OAuth2 憑證（1 個 Web 應用程式 client）
3. 建立 Azure 資源（4 個）
4. 設定 GitHub Secrets（7 個）
5. 設定 Azure Container App 環境變數
6. Push 觸發 CI/CD 自動部署
7. 設定 Claude Desktop App / Claude Code
8. 測試
```

---

## 步驟一：Fork GitHub Repo

請使用者前往以下網址，點擊右上角 **Fork** 按鈕，將 repo fork 到自己的 GitHub 帳號：

```
https://github.com/jiewngzh11/gmail-pdf-mcp
```

Fork 完成後，使用者的 repo 網址會是：
```
https://github.com/<使用者GitHub帳號>/gmail-pdf-mcp
```

---

## 步驟二：建立 Google OAuth2 憑證

> 需要使用者手動操作，在瀏覽器完成。

### 2-1. 前往 Google Cloud Console

1. 開啟 [https://console.cloud.google.com](https://console.cloud.google.com)
2. 建立新專案（或使用現有專案），例如命名為 `gmail-pdf-mcp`
3. 左側選單 → **API 和服務** → **已啟用的 API 和服務** → 點擊 **+ 啟用 API 和服務**
4. 搜尋並啟用 `Gmail API`
5. 再次點擊 **+ 啟用 API 和服務**，搜尋並啟用 `Google Drive API`

### 2-2. 設定 OAuth 同意畫面

1. 左側 → **OAuth 同意畫面**
2. User Type 選 **外部** → 建立
3. 填入應用程式名稱（例如 `Gmail PDF MCP`）、支援電子郵件
4. 範圍頁面：點擊 **新增或移除範圍**，搜尋並勾選：
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/drive.file`
5. 測試使用者：加入自己的 Gmail 帳號
6. 完成

### 2-3. 建立「Web 應用程式」OAuth client

1. 左側 → **憑證** → **+ 建立憑證** → **OAuth 用戶端 ID**
2. 應用程式類型選 **網路應用程式**
3. 名稱輸入 `gmail-pdf-web`
4. 已授權的重新導向 URI，點擊 **+ 新增 URI**：
   > **注意**：此時還不知道 Container App domain，先填佔位符，步驟五取得 URL 後回來更新：
   > `https://placeholder.example.com/oauth2callback`
5. 點擊 **建立**
6. 記下 **用戶端 ID** 和 **用戶端密鑰**（`GOOGLE_WEB_CLIENT_ID` / `GOOGLE_WEB_CLIENT_SECRET`）

---

## 步驟三：建立 Azure 資源

> 以下由 Claude 用 Azure CLI 自動執行。
> 請先確認使用者已安裝 Azure CLI 並執行 `az login` 登入正確帳號。
> 若未安裝，請使用者先下載：https://aka.ms/installazurecliwindows

**注意**：若在 Git Bash 執行，所有 `az` 指令前須加 `MSYS_NO_PATHCONV=1` 避免路徑轉換問題。

```bash
RESOURCE_GROUP="rg-gmail-pdf"
LOCATION="eastasia"
ACR_NAME="acrgmailpdf$RANDOM"     # Container Registry（全域唯一）
KV_NAME="kv-gmailpdf-$RANDOM"    # Key Vault（全域唯一）
CONTAINER_APP_NAME="gmail-pdf-mcp"
CONTAINER_ENV_NAME="gmail-pdf-env"

# 1. 建立 Resource Group
az group create --name $RESOURCE_GROUP --location $LOCATION

# 2. 建立 Container Registry
az acr create --name $ACR_NAME --resource-group $RESOURCE_GROUP --sku Basic --admin-enabled true

# 3. 建立 Key Vault（用於備用 refresh token）
az keyvault create --name $KV_NAME --resource-group $RESOURCE_GROUP --location $LOCATION

# 4. 取得 ACR 登入資訊（記下這些值，步驟四需要用到）
az acr show --name $ACR_NAME --query loginServer -o tsv
az acr credential show --name $ACR_NAME --query "passwords[0].value" -o tsv

# 5. 建立 Container Apps 環境
az containerapp env create --name $CONTAINER_ENV_NAME --resource-group $RESOURCE_GROUP --location $LOCATION

# 6. 建立初始 Container App（用 hello-world 暫代，CI/CD 會更新）
az containerapp create \
  --name $CONTAINER_APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --environment $CONTAINER_ENV_NAME \
  --image mcr.microsoft.com/azuredocs/containerapps-helloworld:latest \
  --target-port 8080 \
  --ingress external \
  --min-replicas 0 \
  --max-replicas 2

# 7. 取得 Container App URL
az containerapp show --name $CONTAINER_APP_NAME --resource-group $RESOURCE_GROUP --query properties.configuration.ingress.fqdn -o tsv
```

記下 Container App 的 URL（格式：`gmail-pdf-mcp.xxxx.eastasia.azurecontainerapps.io`）。

**回到步驟 2-3**，將 Google OAuth 重新導向 URI 更新為：
```
https://<Container App URL>/oauth2callback
```

### 建立 GitHub Actions Service Principal

```bash
SUBSCRIPTION_ID=$(az account show --query id -o tsv)

MSYS_NO_PATHCONV=1 az ad sp create-for-rbac \
  --name "github-actions-gmail-pdf" \
  --role contributor \
  --scopes /subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP \
  --sdk-auth
```

輸出的 JSON 整段複製，這就是 `AZURE_CREDENTIALS`。

---

## 步驟四：設定 GitHub Secrets

請使用者前往 GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**，新增以下 7 個 Secrets：

| Secret 名稱 | 值的來源 |
|---|---|
| `AZURE_CREDENTIALS` | 步驟三最後的 Service Principal JSON |
| `ACR_LOGIN_SERVER` | ACR 的 login server URL（例如 `acrgmailpdf12345.azurecr.io`） |
| `ACR_USERNAME` | ACR admin username（與 ACR 名稱相同） |
| `ACR_PASSWORD` | ACR admin password |
| `RESOURCE_GROUP` | `rg-gmail-pdf` |
| `GOOGLE_WEB_CLIENT_ID` | 步驟 2-3 的用戶端 ID |
| `GOOGLE_WEB_CLIENT_SECRET` | 步驟 2-3 的用戶端密鑰 |

---

## 步驟五：設定 Azure Container App 環境變數

先產生一個隨機的 `STATIC_BEARER_TOKEN`（供排程任務使用），再一起設定進去：

```bash
# 產生靜態 token（記下這個值）
STATIC_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
echo "STATIC_BEARER_TOKEN=$STATIC_TOKEN"

# 設定所有環境變數
az containerapp update \
  --name gmail-pdf-mcp \
  --resource-group rg-gmail-pdf \
  --set-env-vars \
    AZURE_DEPLOYMENT=true \
    GOOGLE_WEB_CLIENT_ID=<用戶端 ID> \
    GOOGLE_WEB_CLIENT_SECRET=<用戶端密鑰> \
    OAUTH_CALLBACK_URL=https://<Container App URL>/oauth2callback \
    STATIC_BEARER_TOKEN=$STATIC_TOKEN \
    PORT=8080
```

**保存 `STATIC_BEARER_TOKEN` 的值**，步驟七設定排程任務時會用到。

---

## 步驟六：觸發 CI/CD 部署

請使用者在 GitHub 網頁上對 `README.md` 做任何小修改（例如加空行），commit 後觸發 GitHub Actions 自動 build + deploy。

或由 Claude 執行：
```bash
git commit --allow-empty -m "trigger deploy"
git push
```

前往 GitHub repo → **Actions** 頁面確認 workflow 執行成功（綠色勾勾）。

部署完成後驗證：
```bash
curl https://<Container App URL>/health
# 應回傳 {"status":"ok"}
```

---

## 步驟七：設定 Claude 使用 MCP Server

### Claude Code（VS Code 擴充套件）

在 `C:\Users\<使用者名稱>\.claude.json` 中加入 `mcpServers` 欄位（由 Claude 執行）：

```json
"mcpServers": {
  "gmail-pdf": {
    "type": "http",
    "url": "https://<Container App URL>/mcp"
  }
}
```

重新載入 VS Code 視窗（`Ctrl+Shift+P` → `Developer: Reload Window`）。

### Claude Code 排程任務（無人值守）

一般互動式使用時，每個 session 連線後瀏覽器會跳出授權頁面，token 儲存在記憶體中。  
但 **排程任務**（例如 Claude Cowork schedule）在無人值守環境執行，無法開啟瀏覽器，需要永久 bearer token。

Server 支援**兩種排程 token**，可同時並存：

| Token 類型 | 使用情境 | Gmail / Drive 帳號 |
|---|---|---|
| `STATIC_BEARER_TOKEN`（env var） | 部署者自己的排程 | Key Vault 中的 refresh token（部署者帳號） |
| `save_schedule_token` 工具產生 | 每位使用者各自的排程 | 該使用者自己的 Google 帳號 |

#### 個人排程 token 設定流程（每位使用者各做一次）

1. **正常連線**，瀏覽器跳出 Google 授權頁面，完成授權
2. 在 Claude 中呼叫工具：
   ```
   請呼叫 save_schedule_token
   ```
3. 工具回傳一個永久 bearer token（例如 `a1b2c3...`）和設定說明
4. 將 token 設定到 `.claude.json`：

```json
"mcpServers": {
  "gmail-pdf": {
    "type": "http",
    "url": "https://<Container App URL>/mcp",
    "headers": {
      "Authorization": "Bearer <save_schedule_token 回傳的 token>"
    }
  }
}
```

5. 之後的排程任務即使 Server 重啟也不需要重新授權，PDF 存到**自己的 Google Drive**

> **Token 說明**：`save_schedule_token` 會將你的 refresh token 存入 Key Vault（`gmail-refresh-token-{你的email}`），之後 Server 重啟時自動從 Key Vault 載入，排程 token 永久有效。若需要撤銷，至 Google 帳號安全設定移除「Gmail PDF MCP」的存取權即可。

### Claude Desktop App

在 `C:\Users\<使用者名稱>\AppData\Roaming\Claude\claude_desktop_config.json` 中加入：

```json
{
  "mcpServers": {
    "gmail-pdf": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<Container App URL>/mcp"]
    }
  }
}
```

完全退出 Claude Desktop App（系統列右鍵 → Quit），再重新開啟。

> **注意**：Claude Desktop App 不支援直接使用 `"type": "http"` 連接遠端 MCP，必須透過 `mcp-remote` 作為本機代理。需要先安裝 Node.js。

---

## 步驟八：測試

Server 實作了 MCP Authorization 規範，**連線時會自動彈出 Google 授權頁面**：

1. 在 Claude 中使用任何 gmail-pdf 工具（例如 `search_emails`）
2. Claude 會自動開啟瀏覽器 → 用自己的 Google 帳號登入授權（同時授權 Gmail 讀取 + Google Drive 存檔）
3. 授權完成後直接使用工具，不需要任何額外步驟

**測試搜尋**：
```
請搜尋主旨含「發票」的郵件，最多 3 封
```

**測試轉 PDF**：
```
請把主旨含「發票」的郵件轉成 PDF
```

成功後 PDF 會存到使用者的 Google Drive，路徑為 `Gmail PDF MCP/{寄件人名稱}/{檔名}.pdf`，回傳 Google Drive 分享連結。

---

## 可用工具說明

| 工具 | 用途 |
|---|---|
| `authorize_gmail` | 手動取得授權連結（通常不需要，連線時自動觸發；可用於重新授權） |
| `check_gmail_auth` | 確認目前 session 是否已授權 |
| `search_emails` | 搜尋 Gmail，參數：`query`（Gmail 搜尋語法）、`max_results`（上限 50） |
| `fetch_email_content` | 取得單封郵件完整內容 |
| `convert_email_to_pdf` | 將單封郵件轉為 PDF 並存到 Google Drive |
| `batch_convert_emails` | 搜尋 + 批次轉 PDF（最常用），參數：`query`、`max_results`（上限 20） |
| `save_schedule_token` | 將目前授權儲存為個人排程 token（每人只需設定一次） |

> `search_emails` 支援完整 Gmail 搜尋語法，例如：
> - `發票` — 任何欄位含「發票」
> - `subject:發票 after:2026/3/1 before:2026/4/1` — 三月份主旨含「發票」

---

## 注意事項

- **Gmail 授權是 per-session**：每次 MCP session 重新建立（例如重啟 Claude Desktop App）會需要重新授權。Claude Desktop App 連線時會自動跳出授權頁面。
- **Google OAuth 同意畫面**：App 在「測試中」狀態時，只有測試使用者名單內的帳號可以授權。若要開放給同事使用，需在 Google Cloud Console 將同事帳號加入測試名單，或提交 App 審核。
- **Container App 冷啟動**：最小 replica 為 0 時，第一次呼叫可能需要等 10-20 秒啟動。
- **PDF 存放位置**：PDF 存在**各自使用者**的 Google Drive（授權時登入哪個帳號，PDF 就存到哪個帳號），路徑為 `Gmail PDF MCP/{寄件人}/`。
- **三軌授權並存**：① `STATIC_BEARER_TOKEN` → 部署者帳號（env var 設定）；② `save_schedule_token` 產生的個人 token → 各使用者自己的帳號（存 Key Vault，重啟自動載入）；③ 互動式瀏覽器授權 → 各使用者 per-session。三軌互不干擾。

---

## 常見問題

**Q: 連線後沒有跳出授權頁面**
A: 確認 `OAUTH_CALLBACK_URL` 環境變數已設定，且 Google OAuth client 的重新導向 URI 與 `OAUTH_CALLBACK_URL` 完全一致（含 `/oauth2callback`）。

**Q: 呼叫工具出現 `unauthorized_client`**
A: Session 已過期（Container App 重啟會清除記憶體中的 token）。重新連線或呼叫 `authorize_gmail` 取得新授權連結。

**Q: GitHub Actions 失敗，顯示 ACR login error**
A: 確認 `ACR_USERNAME`、`ACR_PASSWORD`、`ACR_LOGIN_SERVER` 三個 Secret 填寫正確。

**Q: Container App 部署成功但 `/health` 回傳 404**
A: 可能還在啟動中，等 30 秒再試。或至 Azure Portal → Container App → Log stream 查看錯誤。

**Q: PDF 內容空白或中文亂碼**
A: Container App 已內建 `fonts-noto-cjk`，若仍有問題請查看 Container App logs。

**Q: Google Drive 找不到 PDF**
A: 確認授權時選的是正確的 Google 帳號。PDF 存在 Drive 根目錄的 `Gmail PDF MCP/` 資料夾下。

**Q: 排程任務呼叫工具出現 `invalid_token`**
A: `STATIC_BEARER_TOKEN` 環境變數可能未設定，或 `.claude.json` 的 `headers.Authorization` 值與 Container App 的環境變數不一致。重新確認兩邊的 token 值相同。

**Q: 排程任務存的 PDF 跑到別的 Google Drive**
A: 若使用 `STATIC_BEARER_TOKEN`，PDF 固定存到部署者的 Drive（預期行為）。若想排程存到自己的 Drive，請改用 `save_schedule_token` 產生個人 token，並在 `.claude.json` 的 `headers.Authorization` 使用該 token。

**Q: `save_schedule_token` 回傳錯誤「Session has no refresh token」**
A: Google 只在第一次授權時回傳 refresh token。請在 Google 帳號安全設定撤銷「Gmail PDF MCP」的存取，再重新連線授權，之後再呼叫 `save_schedule_token`。
