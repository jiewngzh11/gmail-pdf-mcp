# Gmail PDF MCP Server — Claude 部署指南

這份文件是給 Claude 看的。你的任務是幫助使用者將這個專案部署到他自己的 Azure 上，並設定好讓 Claude Desktop App 或 Claude Code 可以使用。

使用者沒有程式基礎，所有指令都由你來執行，你只需要在需要人工操作時（例如瀏覽器登入、複製貼上金鑰）暫停並告訴使用者要做什麼。

---

## 這個專案是什麼

一個 MCP (Model Context Protocol) Server，讓 Claude 能夠：
- 搜尋 Gmail 中主旨含關鍵字的郵件
- 將郵件（含附件）轉換為 PDF
- 儲存 PDF 至 Azure Blob Storage 並回傳下載連結

技術棧：Node.js + TypeScript，Puppeteer（HTML→PDF），pdf-lib（合併），Gmail API，Azure Container Apps（部署），Azure Blob Storage（儲存），GitHub Actions（CI/CD）。

---

## 使用者已準備好的帳號

- **Google Cloud Console** 帳號（用來建立 OAuth2 憑證）
- **GitHub** 帳號（用來 Fork 專案並觸發自動部署）
- **Azure** 帳號（用來建立所有雲端資源）

---

## 部署流程總覽

```
1. Fork GitHub repo
2. 建立 Google OAuth2 憑證（2 個 client）
3. 建立 Azure 資源（5 個）
4. 設定 GitHub Secrets（7 個）
5. 設定 Azure Container App 環境變數
6. Push 觸發 CI/CD 自動部署
7. 設定 Claude Desktop App / Claude Code
8. 授權 Gmail 並測試
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
4. 搜尋 `Gmail API` → 點擊啟用

### 2-2. 設定 OAuth 同意畫面

1. 左側 → **OAuth 同意畫面**
2. User Type 選 **外部** → 建立
3. 填入應用程式名稱（例如 `Gmail PDF MCP`）、支援電子郵件
4. 範圍頁面：點擊 **新增或移除範圍** → 搜尋 `gmail.readonly` → 勾選 → 儲存
5. 測試使用者：加入自己的 Gmail 帳號
6. 完成

### 2-3. 建立「Web 應用程式」OAuth client（用於多使用者授權）

1. 左側 → **憑證** → **+ 建立憑證** → **OAuth 用戶端 ID**
2. 應用程式類型選 **網路應用程式**
3. 名稱輸入 `gmail-pdf-web`
4. 已授權的重新導向 URI，點擊 **+ 新增 URI**，輸入：
   ```
   https://gmail-pdf-mcp.<你的Container App domain>/oauth2callback
   ```
   > **注意**：此時還不知道 domain，先填入以下佔位符，之後步驟五再回來更新：
   > `https://placeholder.example.com/oauth2callback`
5. 點擊 **建立**
6. 記下 **用戶端 ID** 和 **用戶端密鑰**（`GOOGLE_WEB_CLIENT_ID` / `GOOGLE_WEB_CLIENT_SECRET`）

---

## 步驟三：建立 Azure 資源

> 以下由 Claude 用 Azure CLI 自動執行。
> 請先確認使用者已安裝 Azure CLI 並執行 `az login` 登入正確帳號。
> 若未安裝，請使用者先下載：https://aka.ms/installazurecliwindows

請 Claude 執行以下指令（依序執行，每步驟確認成功再繼續）：

```bash
# 設定變數（讓使用者決定名稱，或使用預設值）
RESOURCE_GROUP="rg-gmail-pdf"
LOCATION="eastasia"
ACR_NAME="acrgmailpdf$RANDOM"        # Container Registry（全域唯一）
STORAGE_NAME="sagmailpdf$RANDOM"     # Storage Account（全域唯一）
KV_NAME="kv-gmailpdf-$RANDOM"        # Key Vault（全域唯一）
CONTAINER_APP_NAME="gmail-pdf-mcp"
CONTAINER_ENV_NAME="gmail-pdf-env"

# 1. 建立 Resource Group
az group create --name $RESOURCE_GROUP --location $LOCATION

# 2. 建立 Container Registry
az acr create --name $ACR_NAME --resource-group $RESOURCE_GROUP --sku Basic --admin-enabled true

# 3. 建立 Storage Account 和容器
az storage account create --name $STORAGE_NAME --resource-group $RESOURCE_GROUP --location $LOCATION --sku Standard_LRS
az storage container create --name gmail-pdfs --account-name $STORAGE_NAME

# 4. 建立 Key Vault
az keyvault create --name $KV_NAME --resource-group $RESOURCE_GROUP --location $LOCATION

# 5. 取得 ACR 登入資訊（記下這些值，步驟四需要用到）
az acr show --name $ACR_NAME --query loginServer -o tsv
az acr credential show --name $ACR_NAME --query "passwords[0].value" -o tsv

# 6. 取得 Storage Account Key（步驟四需要用到）
az storage account keys list --account-name $STORAGE_NAME --query "[0].value" -o tsv

# 7. 建立 Container Apps 環境
az containerapp env create --name $CONTAINER_ENV_NAME --resource-group $RESOURCE_GROUP --location $LOCATION

# 8. 建立初始 Container App（用 hello-world 暫代，之後 CI/CD 會更新）
az containerapp create \
  --name $CONTAINER_APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --environment $CONTAINER_ENV_NAME \
  --image mcr.microsoft.com/azuredocs/containerapps-helloworld:latest \
  --target-port 8080 \
  --ingress external \
  --min-replicas 0 \
  --max-replicas 2

# 9. 取得 Container App URL
az containerapp show --name $CONTAINER_APP_NAME --resource-group $RESOURCE_GROUP --query properties.configuration.ingress.fqdn -o tsv
```

記下 Container App 的 URL（格式：`gmail-pdf-mcp.xxxx.eastasia.azurecontainerapps.io`）。

**回到步驟 2-3**，將 Google OAuth 重新導向 URI 更新為：
```
https://<Container App URL>/oauth2callback
```

### 建立 GitHub Actions Service Principal

```bash
# 取得 Subscription ID
SUBSCRIPTION_ID=$(az account show --query id -o tsv)

# 建立 Service Principal
az ad sp create-for-rbac \
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
| `ACR_USERNAME` | ACR admin username（通常與 ACR 名稱相同） |
| `ACR_PASSWORD` | ACR admin password |
| `RESOURCE_GROUP` | `rg-gmail-pdf` |
| `GOOGLE_WEB_CLIENT_ID` | 步驟 2-3 的用戶端 ID |
| `GOOGLE_WEB_CLIENT_SECRET` | 步驟 2-3 的用戶端密鑰 |

---

## 步驟五：設定 Azure Container App 環境變數

請 Claude 執行：

```bash
az containerapp update \
  --name gmail-pdf-mcp \
  --resource-group rg-gmail-pdf \
  --set-env-vars \
    AZURE_DEPLOYMENT=true \
    AZURE_STORAGE_ACCOUNT_NAME=<STORAGE_NAME> \
    AZURE_STORAGE_CONTAINER_NAME=gmail-pdfs \
    AZURE_STORAGE_ACCOUNT_KEY=<Storage Account Key> \
    GOOGLE_WEB_CLIENT_ID=<用戶端 ID> \
    GOOGLE_WEB_CLIENT_SECRET=<用戶端密鑰> \
    OAUTH_CALLBACK_URL=https://<Container App URL>/oauth2callback \
    PORT=8080
```

---

## 步驟六：觸發 CI/CD 部署

請使用者在 GitHub 網頁上對 `README.md` 做任何小修改（例如加一個空行），commit 後就會觸發 GitHub Actions 自動 build + deploy。

或由 Claude 在 clone 下來的 repo 執行：
```bash
git commit --allow-empty -m "trigger deploy"
git push
```

前往 GitHub repo → **Actions** 頁面確認 workflow 執行成功（綠色勾勾）。

---

## 步驟七：設定 Claude 使用 MCP Server

### Claude Code（VS Code 擴充套件）

在 `C:\Users\<使用者名稱>\.claude.json` 中加入（由 Claude 執行）：

```json
"mcpServers": {
  "gmail-pdf": {
    "type": "http",
    "url": "https://<Container App URL>/mcp"
  }
}
```

重新載入 VS Code 視窗（Ctrl+Shift+P → Developer: Reload Window）。

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

---

## 步驟八：授權 Gmail 並測試

在 Claude 中執行：

1. **授權**：呼叫 `authorize_gmail` 工具 → 點擊回傳的連結 → 用自己的 Gmail 帳號登入授權
2. **搜尋測試**：呼叫 `search_emails`，query 輸入 `發票`，max_results 輸入 `3`
3. **轉 PDF 測試**：呼叫 `batch_convert_emails`，query 輸入 `發票`

成功後會回傳 PDF 的下載連結（Azure Blob Storage SAS URL，24 小時有效）。

---

## 可用工具說明

| 工具 | 用途 |
|---|---|
| `authorize_gmail` | 取得 Gmail 授權連結（每個使用者第一次使用需執行） |
| `check_gmail_auth` | 確認目前 session 是否已授權 |
| `search_emails` | 搜尋 Gmail，參數：`query`（關鍵字）、`max_results`（上限 50） |
| `fetch_email_content` | 取得單封郵件完整內容 |
| `convert_email_to_pdf` | 將單封郵件轉為 PDF |
| `batch_convert_emails` | 搜尋 + 批次轉 PDF（最常用），參數：`query`、`max_results`（上限 20） |
| `download_pdf_locally` | 將 Blob 上的 PDF 下載到本機指定路徑 |

---

## 注意事項

- **Gmail 授權是 per-session**：每次 MCP session 重新建立（例如重啟 Claude Desktop App）都需要重新執行 `authorize_gmail`。這是設計上的安全考量。
- **PDF SAS 連結 24 小時有效**：之後需要重新執行 `batch_convert_emails` 產生新連結，或用 `download_pdf_locally` 先下載到本機。
- **Container App 冷啟動**：若 Container App 設定最小 replica 為 0，第一次呼叫可能需要等 10-20 秒啟動。
- **Google OAuth 同意畫面**：若 App 還在「測試中」狀態，只有測試使用者名單內的帳號可以授權。若要開放給任何人使用，需要在 Google Cloud Console 提交 App 審核，或將每個使用者加入測試名單。

---

## 常見問題

**Q: `authorize_gmail` 後呼叫工具出現 `unauthorized_client`**
A: Session 可能已過期（Container App 重啟會清除記憶體中的 session）。重新執行 `authorize_gmail` 即可。

**Q: GitHub Actions 失敗，顯示 ACR login error**
A: 確認 `ACR_USERNAME`、`ACR_PASSWORD`、`ACR_LOGIN_SERVER` 三個 Secret 都填寫正確。

**Q: Container App 部署成功但 `/health` 回傳 404**
A: 可能還在啟動中，等 30 秒再試。或檢查 Azure Portal → Container App → Log stream 查看啟動錯誤。

**Q: PDF 內容空白或中文亂碼**
A: Container App 已安裝 `fonts-noto-cjk`，若仍有問題請在 Azure Portal 查看 Container App logs。
