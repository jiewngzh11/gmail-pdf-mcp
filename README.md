# Gmail PDF MCP Server

Gmail PDF MCP Server 是一個 Node.js + TypeScript 的 MCP (Model Context Protocol) 伺服器，可以讓支援 MCP 的客戶端搜尋 Gmail、把郵件與附件轉成 PDF，並自動存到使用者自己的 Google Drive。

這個專案適合部署到 Azure Container Apps，並透過 GitHub Actions 自動 build / deploy。第一次連線時會走 Google OAuth 授權，完成後 refresh token 會儲存在 Azure Key Vault，之後伺服器重啟或排程任務執行都不需要重新授權。

## 功能

- 搜尋 Gmail 中主旨含關鍵字的郵件
- 讀取單封郵件完整 HTML / 文字內容
- 將郵件內容轉成 PDF
- 支援將 PDF / 圖片附件合併進輸出的 PDF
- 將 PDF 儲存到 Google Drive：`Gmail PDF MCP/{寄件人}/`
- 支援互動式 MCP 使用與無人值守排程任務
- 支援 Azure Container Apps + Azure Key Vault + GitHub Actions 部署

## 技術架構

- Runtime：Node.js + TypeScript
- MCP：`@modelcontextprotocol/sdk`
- Gmail / Drive：Google APIs
- PDF：Puppeteer、pdf-lib
- Cloud：Azure Container Apps、Azure Container Registry、Azure Key Vault
- CI/CD：GitHub Actions

## 事前準備

你需要準備：

- Google Cloud Console 帳號
- GitHub 帳號
- Azure 帳號
- 本機或部署環境可使用 Node.js
- 若要由本機建立 Azure 資源，需安裝 Azure CLI 並執行 `az login`

## 部署流程總覽

1. Fork GitHub repo
2. 建立 Google OAuth2 Web Client
3. 建立 Azure 資源
4. 設定 GitHub Actions Secrets
5. 設定 Azure Container App 環境變數
6. Push 到 GitHub 觸發 CI/CD
7. 設定 MCP 客戶端
8. 測試 Gmail 搜尋與 PDF 轉檔

## 1. Fork Repo

Fork 這個 repo 到自己的 GitHub 帳號：

```text
https://github.com/jiewngzh11/gmail-pdf-mcp
```

Fork 後 repo 通常會是：

```text
https://github.com/<你的 GitHub 帳號>/gmail-pdf-mcp
```

## 2. 建立 Google OAuth2 憑證

### 2.1 啟用 Google APIs

1. 前往 [Google Cloud Console](https://console.cloud.google.com)
2. 建立新專案，或使用既有專案
3. 到「API 和服務」→「已啟用的 API 和服務」
4. 啟用 `Gmail API`
5. 啟用 `Google Drive API`

### 2.2 設定 OAuth 同意畫面

1. 到「OAuth 同意畫面」
2. User Type 選「外部」
3. 填入應用程式名稱，例如 `Gmail PDF MCP`
4. 新增以下 scopes：

```text
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/drive.file
```

5. 如果 App 還在測試模式，請把自己的 Gmail 加入測試使用者

### 2.3 建立 Web OAuth Client

1. 到「憑證」→「建立憑證」→「OAuth 用戶端 ID」
2. 應用程式類型選「網路應用程式」
3. 名稱可填 `gmail-pdf-web`
4. 先加入一個暫時的重新導向 URI：

```text
https://placeholder.example.com/oauth2callback
```

5. 建立後記下：

```text
GOOGLE_WEB_CLIENT_ID
GOOGLE_WEB_CLIENT_SECRET
```

> Azure 部署只需要 OAuth Client ID 和 Client Secret，不需要下載或放置 `credentials.json`。`credentials.json` 只供本機開發 / 本機測試使用，請勿 commit 到 GitHub。

等 Azure Container App 建立完成並取得正式網域後，回到這裡把重新導向 URI 改成：

```text
https://<Container App URL>/oauth2callback
```

## 3. 建立 Azure 資源

以下指令會建立：

- Resource Group
- Azure Container Registry
- Azure Key Vault
- Azure Container Apps Environment
- Azure Container App

```bash
RESOURCE_GROUP="rg-gmail-pdf"
LOCATION="eastasia"
ACR_NAME="acrgmailpdf$RANDOM"
KV_NAME="kv-gmailpdf-$RANDOM"
CONTAINER_APP_NAME="gmail-pdf-mcp"
CONTAINER_ENV_NAME="gmail-pdf-env"

az group create --name $RESOURCE_GROUP --location $LOCATION

az acr create \
  --name $ACR_NAME \
  --resource-group $RESOURCE_GROUP \
  --sku Basic \
  --admin-enabled true

az keyvault create \
  --name $KV_NAME \
  --resource-group $RESOURCE_GROUP \
  --location $LOCATION

az acr show --name $ACR_NAME --query loginServer -o tsv
az acr credential show --name $ACR_NAME --query "passwords[0].value" -o tsv

az containerapp env create \
  --name $CONTAINER_ENV_NAME \
  --resource-group $RESOURCE_GROUP \
  --location $LOCATION

az containerapp create \
  --name $CONTAINER_APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --environment $CONTAINER_ENV_NAME \
  --image mcr.microsoft.com/azuredocs/containerapps-helloworld:latest \
  --target-port 8080 \
  --ingress external \
  --min-replicas 0 \
  --max-replicas 2

az containerapp show \
  --name $CONTAINER_APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --query properties.configuration.ingress.fqdn \
  -o tsv
```

如果在 Git Bash 執行 Azure CLI，請在可能被路徑轉換影響的 `az` 指令前加上：

```bash
MSYS_NO_PATHCONV=1
```

## 4. 授權 Container App 存取 Key Vault

Container App 需要 Managed Identity 才能讀寫 Key Vault 裡的 refresh token。

```bash
az containerapp identity assign \
  --name $CONTAINER_APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --system-assigned

PRINCIPAL_ID=$(az containerapp identity show \
  --name $CONTAINER_APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --query principalId \
  -o tsv)

az keyvault set-policy \
  --name $KV_NAME \
  --resource-group $RESOURCE_GROUP \
  --object-id $PRINCIPAL_ID \
  --secret-permissions get set list
```

`az keyvault create` 預設使用 Access Policies，因此一般情況請使用 `az keyvault set-policy`。如果你的 Key Vault 開啟了 RBAC (`enableRbacAuthorization: true`)，才改用 `Key Vault Secrets Officer` 角色。

## 5. 建立 GitHub Actions Service Principal

```bash
SUBSCRIPTION_ID=$(az account show --query id -o tsv)

MSYS_NO_PATHCONV=1 az ad sp create-for-rbac \
  --name "github-actions-gmail-pdf" \
  --role contributor \
  --scopes /subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP \
  --sdk-auth
```

輸出的整段 JSON 就是 GitHub Secret `AZURE_CREDENTIALS`。

## 6. 設定 GitHub Secrets

到 GitHub repo → Settings → Secrets and variables → Actions → New repository secret，新增：

| Secret | 值 |
|---|---|
| `AZURE_CREDENTIALS` | Service Principal JSON |
| `ACR_LOGIN_SERVER` | ACR login server，例如 `acrgmailpdf12345.azurecr.io` |
| `ACR_USERNAME` | ACR admin username，通常與 ACR 名稱相同 |
| `ACR_PASSWORD` | ACR admin password |
| `RESOURCE_GROUP` | 例如 `rg-gmail-pdf` |
| `GOOGLE_WEB_CLIENT_ID` | Google OAuth Web Client ID |
| `GOOGLE_WEB_CLIENT_SECRET` | Google OAuth Web Client Secret |

## 7. 設定 Azure Container App 環境變數

先產生一個排程任務可用的靜態 bearer token：

```bash
STATIC_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
echo "STATIC_BEARER_TOKEN=$STATIC_TOKEN"
```

取得 Key Vault URL：

```bash
KV_URL=$(az keyvault show --name <KV_NAME> --query properties.vaultUri -o tsv)
```

設定 Container App：

```bash
az containerapp update \
  --name gmail-pdf-mcp \
  --resource-group rg-gmail-pdf \
  --set-env-vars \
    AZURE_DEPLOYMENT=true \
    AZURE_KEY_VAULT_URL=$KV_URL \
    GOOGLE_WEB_CLIENT_ID=<Google OAuth Client ID> \
    GOOGLE_WEB_CLIENT_SECRET=<Google OAuth Client Secret> \
    OAUTH_CALLBACK_URL=https://<Container App URL>/oauth2callback \
    STATIC_BEARER_TOKEN=$STATIC_TOKEN \
    PORT=8080
```

請保存 `STATIC_BEARER_TOKEN`，之後設定排程任務時會用到。

## 8. 觸發 CI/CD 部署

把程式 push 到 GitHub `main` 分支後，GitHub Actions 會自動 build image 並部署到 Azure Container Apps。

也可以用空 commit 觸發：

```bash
git commit --allow-empty -m "trigger deploy"
git push
```

部署完成後測試：

```bash
curl https://<Container App URL>/health
```

正常會回傳：

```json
{"status":"ok"}
```

## 9. 設定 MCP 客戶端

### 互動式使用

透過 `mcp-remote` 連線：

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

第一次呼叫工具時，瀏覽器會自動開啟 Google 授權頁面。授權完成後：

- 本機 `mcp-remote` 會快取 token
- Server 會把 refresh token 備份到 Azure Key Vault
- 後續重啟通常不需要重新授權

### 無人值守排程任務

排程任務無法開瀏覽器，因此需要先完成一次互動式授權，再呼叫 MCP 工具：

```text
save_schedule_token
```

拿到永久 bearer token 後，排程任務可使用 HTTP MCP 設定：

```json
{
  "mcpServers": {
    "gmail-pdf": {
      "type": "http",
      "url": "https://<Container App URL>/mcp",
      "headers": {
        "Authorization": "Bearer <save_schedule_token 回傳的 token>"
      }
    }
  }
}
```

## 本機開發

安裝依賴：

```bash
npm install
```

編譯：

```bash
npm run build
```

啟動：

```bash
npm start
```

本機 OAuth 測試才需要在專案根目錄放 `credentials.json`，並會產生 `token.json`。這兩個檔案都包含敏感資訊，已在 `.gitignore` 中排除，不應提交到 GitHub。

## MCP 工具

| 工具 | 用途 |
|---|---|
| `authorize_gmail` | 手動取得 Gmail / Drive 授權連結 |
| `check_gmail_auth` | 檢查目前 session 是否已授權 |
| `search_emails` | 搜尋 Gmail，支援 Gmail 搜尋語法 |
| `fetch_email_content` | 取得單封郵件完整內容 |
| `convert_email_to_pdf` | 將單封郵件轉成 PDF 並存到 Drive |
| `batch_convert_emails` | 搜尋郵件並批次轉成 PDF |
| `save_schedule_token` | 將目前授權儲存成排程任務可用的 bearer token |

搜尋範例：

```text
發票
subject:發票 after:2026/3/1 before:2026/4/1
```

## 測試範例

搜尋主旨含「發票」的前 3 封郵件：

```text
請搜尋主旨含「發票」的郵件，最多 3 封
```

批次轉 PDF：

```text
請把主旨含「發票」的郵件轉成 PDF
```

成功後 PDF 會存到 Google Drive：

```text
Gmail PDF MCP/{寄件人}/{檔名}.pdf
```

## 常見問題

### 連線後沒有跳出授權頁面

確認 `OAUTH_CALLBACK_URL` 已設定，且 Google OAuth Web Client 的重新導向 URI 完全相同，包含 `/oauth2callback`。

### 出現 `unauthorized_client` 或 `invalid_token`

通常代表尚未授權、token 過期，或 refresh token 尚未寫入 Key Vault。請重新連線並完成 Google 授權，再等幾秒讓 Server 寫入 Key Vault。

### GitHub Actions 顯示 ACR login error

請確認以下 Secrets 正確：

- `ACR_LOGIN_SERVER`
- `ACR_USERNAME`
- `ACR_PASSWORD`

### `/health` 回傳 404

Container App 可能還在啟動，請等 30 秒後再試。若仍失敗，請到 Azure Portal 的 Container App Log stream 查看錯誤。

### PDF 中文亂碼或空白

Container App image 內已安裝 Noto CJK 字型。若仍有問題，請查看 Container App logs。

### Google Drive 找不到 PDF

PDF 會存到授權時登入的 Google 帳號，不一定是部署者帳號。請確認授權使用的帳號，並查看 Drive 根目錄下的 `Gmail PDF MCP/`。

### Drive 上傳出現 `Insufficient Permission`

通常是 OAuth token 沒有取得 `https://www.googleapis.com/auth/drive.file` scope。請確認 Google OAuth 同意畫面與授權流程包含 Drive scope，然後重新授權。

### 排程任務出現 `invalid_token`

請先完成一次互動式授權，讓 refresh token 寫入 Key Vault，再呼叫 `save_schedule_token` 取得排程任務用 token。
