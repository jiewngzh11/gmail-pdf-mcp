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

**授權流程**：符合 MCP Authorization 規範（RFC 6749）。第一次連上 MCP Server 時，會**自動跳出瀏覽器要求授權**（Gmail 讀取 + Google Drive 存檔）。授權完成後，credentials 自動存入 Azure Key Vault，**之後無論 Server 重啟或排程任務執行，都不需要再重新授權**。

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

### 啟用 Managed Identity 並授權 Key Vault

Container App 需要 Managed Identity 才能存取 Key Vault（讀取與寫入 refresh token）：

```bash
# 啟用 system-assigned managed identity
az containerapp identity assign \
  --name $CONTAINER_APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --system-assigned

# 取得 principal ID
PRINCIPAL_ID=$(az containerapp identity show \
  --name $CONTAINER_APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --query principalId -o tsv)

# 設定 Key Vault Access Policy（get、set、list 三個 secret 權限）
az keyvault set-policy \
  --name $KV_NAME \
  --resource-group $RESOURCE_GROUP \
  --object-id $PRINCIPAL_ID \
  --secret-permissions get set list
```

> **注意**：`az keyvault create` 預設使用 Access Policies（非 RBAC），所以必須用 `az keyvault set-policy` 設定存取，而不是 `az role assignment create`。若你的 Key Vault 有開啟 RBAC（`enableRbacAuthorization: true`），才改用 `Key Vault Secrets Officer` 角色。

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

# 取得 Key Vault URL
KV_URL=$(az keyvault show --name <KV_NAME> --query properties.vaultUri -o tsv)

# 設定所有環境變數
az containerapp update \
  --name gmail-pdf-mcp \
  --resource-group rg-gmail-pdf \
  --set-env-vars \
    AZURE_DEPLOYMENT=true \
    AZURE_KEY_VAULT_URL=$KV_URL \
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

**不需要任何額外設定。** 授權流程如下：

1. **第一次連線**：瀏覽器自動跳出 Google 授權頁面，完成授權
2. **自動持久化**：Server 在背景將你的 credentials 存入 Azure Key Vault
3. **之後的所有連線與排程任務**：Server 從 Key Vault 載入，不需要重新授權

排程任務的 `.claude.json` 設定與互動式完全相同，**不需要額外的 token 或 headers**：

```json
"mcpServers": {
  "gmail-pdf": {
    "type": "http",
    "url": "https://<Container App URL>/mcp"
  }
}
```

> **每位使用者各自的帳號**：多人共用同一台 Server 時，每個人的 credentials 分別存在 Key Vault（以 Gmail 帳號為索引）。排程任務使用哪個 bearer token，PDF 就存到哪個人的 Google Drive。

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

Server 實作了 MCP Authorization 規範：

1. **第一次**：使用任何工具（例如 `search_emails`）→ 自動開啟瀏覽器 → 用自己的 Google 帳號登入授權
2. **授權後**：credentials 自動存入 Key Vault（背景執行，約 2-3 秒）
3. **之後**：Server 重啟、新 session、或排程任務，全部自動從 Key Vault 載入，不再跳出瀏覽器

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

- **授權只需一次**：第一次連線完成瀏覽器授權後，credentials 自動存入 Key Vault。Server 重啟、新 session、或排程任務，都不需要重新授權。
- **Google OAuth 同意畫面**：App 在「測試中」狀態時，只有測試使用者名單內的帳號可以授權。若要開放給同事使用，需在 Google Cloud Console 將同事帳號加入測試名單，或提交 App 審核。
- **Container App 冷啟動**：最小 replica 為 0 時，第一次呼叫可能需要等 10-20 秒啟動。
- **PDF 存放位置**：PDF 存在**各自使用者**的 Google Drive（授權時登入哪個帳號，PDF 就存到哪個帳號），路徑為 `Gmail PDF MCP/{寄件人}/`。

---

## 常見問題

**Q: 連線後沒有跳出授權頁面**
A: 確認 `OAUTH_CALLBACK_URL` 環境變數已設定，且 Google OAuth client 的重新導向 URI 與 `OAUTH_CALLBACK_URL` 完全一致（含 `/oauth2callback`）。

**Q: 呼叫工具出現 `unauthorized_client` 或 `invalid_token`**
A: 可能是第一次使用（尚未授權），或 credentials 尚未存入 Key Vault。重新連線，瀏覽器會跳出授權頁面，完成後約 3 秒自動存入 KV，之後不再需要重新授權。

**Q: GitHub Actions 失敗，顯示 ACR login error**
A: 確認 `ACR_USERNAME`、`ACR_PASSWORD`、`ACR_LOGIN_SERVER` 三個 Secret 填寫正確。

**Q: Container App 部署成功但 `/health` 回傳 404**
A: 可能還在啟動中，等 30 秒再試。或至 Azure Portal → Container App → Log stream 查看錯誤。

**Q: PDF 內容空白或中文亂碼**
A: Container App 已內建 `fonts-noto-cjk`，若仍有問題請查看 Container App logs。

**Q: Google Drive 找不到 PDF**
A: 確認授權時選的是正確的 Google 帳號。PDF 存在 Drive 根目錄的 `Gmail PDF MCP/` 資料夾下。

**Q: 第一次授權後，第二次連線仍然跳出瀏覽器**
A: credentials 尚未存入 Key Vault（auto-persist 在背景執行，約 3 秒）。等幾秒後重新連線即可。若持續發生，請查看 Container App Log stream 是否有 `[auth] auto-persist failed` 錯誤，並確認步驟三的 Key Vault Secrets Officer 角色已設定。

**Q: 排程任務呼叫工具出現 `invalid_token`**
A: 使用者尚未完成過一次互動式授權，credentials 不在 Key Vault。請先用互動方式（瀏覽器）授權一次，之後排程即可正常使用。

**Q: `save_schedule_token` 可以用來做什麼**
A: 這是手動備援工具，正常情況下不需要使用。若 auto-persist 失敗（Key Vault 權限不足等），或需要主動刷新 KV 中的 token，可以呼叫此工具。

**Q: Key Vault 存取被拒（auto-persist failed）**
A: Container App 的 Managed Identity 缺少寫入權限。請確認步驟三中已執行 `az role assignment create --role "Key Vault Secrets Officer"` 並等待 1-2 分鐘讓角色生效。
