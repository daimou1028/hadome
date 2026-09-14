---
name: package
description: 打包 Chrome Extension ZIP 與 VSIX，依 Git tag、package.json、Chrome manifest 判定版本，使用專案既有打包腳本，處理 Node.js 相容性並驗證最終產物。
user-invocable: true
---

# Chrome Extension 與 VSIX 打包 SOP

所有溝通使用繁體中文（台灣）。

## 0. 執行原則

- 先讀取並確認專案現況，再執行打包。
- 不要因 npm warning 就判定失敗；以退出碼與明確成功訊息為準。
- 不要自行修改 `package.json`、`package-lock.json` 或版本號來掩蓋打包問題。
- 不要把四段 Git tag 直接寫入 VSIX 版本；Git tag、VSIX 版本與 Chrome 版本分開判定。
- 每個產物都必須個別驗證；單一產物成功不代表整個任務完成。
- 既有 VSIX 與 Chrome ZIP 產物一律保留，不得刪除或覆蓋。
- 若目標檔名已存在，使用 `-1`、`-2`、`-3` 等遞增尾碼建立新檔；例如 `hadome-0.1.10.2.vsix` 已存在時，下一個應為 `hadome-0.1.10.2-1.vsix`。
- 回報時必須分開列出「已確認」與「未完成或失敗」。

## 1. 版本與 Git 確認

先執行：

```bash
git status --short
git tag --sort=-version:refname | head -20
git describe --tags --always --dirty
node -e "const p=require('./package.json'); console.log(JSON.stringify({name:p.name,version:p.version,scripts:p.scripts},null,2))"
node -e "const p=require('./package-lock.json'); console.log(JSON.stringify({lockfileVersion:p.lockfileVersion,name:p.name,version:p.version},null,2))"
```

讀取 Chrome manifest：

```bash
cat chrome-extension/manifest.json
```

必要時直接讀取 tag 內容：

```bash
git show <TAG>:package.json
git show <TAG>:chrome-extension/manifest.json
```

### 版本規則

- Git tag：只用來確認目前版本標記與 HEAD 狀態。
- VSIX 版本：以目前工作樹 `package.json.version` 為準。
- `package-lock.json`：確認 `name` 與 `version` 是否和 `package.json` 一致；不要任意重建 lockfile。
- Chrome Extension 版本：以 `chrome-extension/manifest.json.version` 為準。
- Git tag 不一定等於 VSIX 版本。
- 四段 Git tag 不可直接當成 VSIX 版本；VSIX 版本須符合 VS Code / VSIX 的版本格式。
- 若專案有協定常數，確認 `TAB_PROTOCOL` 與 `EXPECTED_TAB_PROTOCOL` 一致。

## 2. Node.js 相容性

先檢查：

```bash
node -v
npm -v
which node
which npm
```

若 Node 12 因 `??`、optional chaining、`commander`、`vsce-sign` 或其他現代語法失敗，優先使用已安裝的新版本 Node，例如：

```bash
PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
export PATH
node -v
npm -v
```

切換 Node 後，重新確認 `node -v`、`npm -v`，再重跑失敗命令。

不要因以下訊息直接判定失敗：

- npm deprecated warning
- npm audit warning
- VSCE 一般 warning
- 非零以外的提示訊息

成功與否以以下條件判斷：

1. 命令退出碼為 0。
2. 出現專案腳本明確的成功訊息。
3. 預期產物實際存在。
4. 產物內容驗證通過。

## 3. 建立 Chrome ZIP

優先使用專案既有腳本，不要自行另寫壓縮命令：

```bash
npm run package:chrome
```

確認：

- 命令退出碼為 0。
- 實際產出 ZIP 存在。
- ZIP 檔名包含正確 Chrome 版本。
- ZIP 內的 `manifest.json` 存在。
- ZIP 內 `manifest.json.version` 與 `chrome-extension/manifest.json.version` 一致。
- ZIP 內沒有不應發布的工作檔、原始暫存檔或不必要目錄。

驗證：

```bash
unzip -p <chrome-zip> manifest.json
unzip -l <chrome-zip>
ls -l <chrome-zip>
```

若腳本輸出檔名不是預期名稱，先以實際腳本輸出與檔案系統結果為準，不要猜測檔名。

## 4. 建立 VSIX 與同步 Chrome Extension

使用專案既有打包腳本：

```bash
npm run package
```

`npm run package` 會依序：

1. 重新打包 Webview。
2. 執行 `npm run package:chrome`，同步建立最新的 Chrome Extension ZIP。
3. 建立 VSIX。

目前專案的 `package` script 預期使用：

```json
"package": "node tools/package-extension.js"
```

若只需要單獨建立 Chrome ZIP，仍可使用：

```bash
npm run package:chrome
```

成功條件：

- 命令退出碼為 0。
- 出現 `DONE Packaged` 或等效成功訊息。
- VSIX 檔案實際存在。
- VSIX 檔名與 `package.json.version` 的版本規則一致。
- `vsce` 的一般 warning 不得被誤判為失敗。

若出現 Node 語法錯誤：

1. 先切換到 Node 20 或更新版本。
2. 重新確認 Node / npm 版本。
3. 重新執行 `npm run package`。
4. 回報原始錯誤與重試結果，不要只寫「已修復」。

## 5. 驗證 VSIX

確認 VSIX 內的 Extension manifest：

```bash
unzip -p <vsix> extension/package.json
```

確認 VSIX 內的版本：

- `extension/package.json.version` 必須等於目前 `package.json.version`。
- 不可只依 VSIX 檔名判定版本。
- 若內部 manifest 與外部檔名不一致，視為需要處理的問題。

確認 VSIX 是否包含 Chrome ZIP：

```bash
unzip -l <vsix> | grep '<chrome-zip-filename>'
```

若專案打包腳本要求把 Chrome ZIP 內嵌進 VSIX，必須確認：

- VSIX 內確實存在該 ZIP。
- 內嵌 ZIP 檔名與實際 Chrome ZIP 檔名一致。
- 內嵌 ZIP 沒有被錯誤放在不預期的路徑。

確認產物：

```bash
ls -l <chrome-zip> <vsix>
```

必要時列出 VSIX 內容：

```bash
unzip -l <vsix>
```

## 6. 協定常數一致性

若專案有協定常數，檢查：

```bash
grep -R -n 'TAB_PROTOCOL\|EXPECTED_TAB_PROTOCOL' chrome-extension src
```

確認：

- `TAB_PROTOCOL` 與 `EXPECTED_TAB_PROTOCOL` 的值一致。
- Chrome Extension 與 VS Code Extension 使用同一個協定版本。
- 若發現不一致，不能宣稱打包完整成功；應列為未完成或失敗。

## 7. 產物與版本交叉驗證

至少確認下列關係：

| 項目 | 應使用的來源 |
|---|---|
| Git 版本標記 | `git describe --tags --always --dirty` |
| VSIX 版本 | `package.json.version` |
| lockfile 版本 | `package-lock.json.version` |
| Chrome 版本 | `chrome-extension/manifest.json.version` |
| VSIX 內部版本 | `extension/package.json.version` |
| Chrome ZIP 內部版本 | ZIP 內 `manifest.json.version` |
| VSIX 內嵌 Chrome ZIP | `unzip -l <vsix>` |

不可只確認檔名；必須至少讀取一次產物內部的 manifest / package.json。

## 8. 回報格式

### 已確認

- Git tag 與 HEAD：
- 工作樹是否乾淨：
- `package.json.version`：
- `package-lock.json.version`：
- Chrome manifest version：
- 實際 Node.js / npm 版本：
- Chrome ZIP 檔名與大小：
- Chrome ZIP 內 manifest 版本：
- VSIX 檔名與大小：
- VSIX 內 `extension/package.json` 版本：
- VSIX 是否包含 Chrome ZIP：
- 協定版本是否一致：

### 未完成或失敗

明確列出：

- 失敗命令：
- 退出碼：
- 錯誤訊息：
- 已完成部分：
- 尚未完成部分：
- 是否需要使用者決定後續處理：

不要把單一產物成功寫成全部完成。

## 檢查清單

- [ ] Git tag、HEAD、工作樹狀態已確認
- [ ] `package.json` 與 `package-lock.json` 版本已確認
- [ ] Chrome manifest 版本已確認
- [ ] Node.js / npm 版本已確認
- [ ] Node.js 相容性已確認
- [ ] Chrome ZIP 已建立
- [ ] Chrome ZIP 實際存在
- [ ] ZIP 內 manifest 已驗證
- [ ] VSIX 已建立
- [ ] VSIX 實際存在
- [ ] VSIX 內 package.json 已驗證
- [ ] VSIX 內嵌 Chrome ZIP 已驗證（若專案要求）
- [ ] 產物檔名與內部版本已交叉驗證
- [ ] 協定常數一致性已驗證（若適用）
- [ ] 已區分已確認與未完成項目
