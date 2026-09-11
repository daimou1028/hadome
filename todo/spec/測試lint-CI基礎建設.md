# 補上測試/lint/CI 基礎建設

更新時間：2026-09-12

## 基本資訊

| 項目 | 內容 |
|------|------|
| 分支 | feature/測試lint-CI基礎建設 |
| 影響範圍 | package.json（新增 devDependencies/scripts）、新增 test/ 目錄、新增 .github/workflows/ci.yml |
| 優先權 | 中 |
| 狀態 | 待執行 |

## 背景與目的

目前專案完全沒有測試框架、lint 設定、CI workflow（`package.json` 的 `scripts` 只有 build/watch/package 相關，`devDependencies` 沒有任何測試/lint 工具，repo 內也沒有 `.github/workflows`）。對於一個會直接執行 shell 指令、寫入檔案的工具（denylist/allowlist、`resolveInside` 路徑守衛、`whyBlocked` 秘密檔案保護）而言，這些安全邏輯完全靠人工檢查、沒有回歸測試保護。

T-005、T-006 的重構也需要這裡建立的測試基礎，之後才能真正驗證「行為沒變」而不是只靠 diff 肉眼比對。

## 實作內容

### 修改檔案

- `package.json` — 新增 `"test"` script，新增測試框架至 devDependencies
- 新增 `test/tools.test.js`（或依選定框架的檔名慣例）— 針對 `src/tools.js` 匯出的純函式做單元測試
- 新增 `.github/workflows/ci.yml` — push/PR 時跑 `npm test`

### 測試框架選擇

用 Node.js 內建的 `node:test` + `node:assert`（Node >= 20，本專案 `engines.vscode`/`engines.node` 已要求 `>=20`），**不新增 devDependency**，符合 ponytail 極簡原則第 2 階（stdlib 能做到就不用裝套件）。

### 優先覆蓋的測試對象（安全與正確性關鍵路徑）

1. `denyReason()` / `mergeDenylist()`（src/tools.js）— denylist 規則是否正確攔截已知的危險指令樣式（`--output`、`git branch -D`、`node -e`、`--remote-debugging-port` 等 [tools.js:23-56](../../src/tools.js)）
2. `whyBlocked()`（src/tools.js:273）— `.git`/`.vscode` 等危險路徑、`SECRET_PATTERNS`（.env、id_rsa、.npmrc 等）、`.bridgeignore` 規則三種情境
3. `resolveInside()`（src/tools.js:340）— 正常路徑、`../` 逃逸工作區、symlink 逃逸(`fs.realpathSync`) 三種情境
4. `shellMetaOutsideQuotes()` / `leadingAssignment()`（src/tools.js）— 引號內外 shell 特殊字元判斷
5. `pathGlobToRegExp()` / `globToRegExp()`（src/tools.js）— glob pattern 轉 regex 的邊界情況（`**`、`{a,b}`、`?`）
6. 剛在 #1-#4 效能修復中改動過的 `readIgnoreRules()` + `whyBlocked(..., {ignoreRules})` 快取行為 — 確認傳入快取結果與不傳時行為一致

### CI workflow 內容

```yaml
name: CI
on:
  push:
    branches: [develop, main]
  pull_request:
    branches: [develop, main]
jobs:
  test:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm test
```

（用 `macos-latest` 而非預設 `ubuntu-latest`：本專案的路徑/檔案系統相關測試在 macOS 開發，`fs.realpathSync` 等行為與大小寫敏感度在不同作業系統可能有差異，先跟開發環境一致，之後有需要再擴充 matrix。）

### 驗收標準

- [ ] `npm test` 可在本地執行且全數通過
- [ ] 上述 6 類測試對象都有至少 1 個正向 + 1 個負向案例
- [ ] `.github/workflows/ci.yml` 語法正確（可用 `actionlint` 或 GitHub 介面驗證，若環境沒有 actionlint 則以 YAML parse 檢查替代）
- [ ] 不引入新的 npm 依賴（沿用 `node:test`）
- [ ] `package.json` 的 `"test"` script 正確指向新測試目錄

## Git Commit

（執行完成後填入）
