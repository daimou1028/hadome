## 1. `commandPrograms()` 詞法分析

- [ ] 1.1 在 `src/tools.js` 新增 `commandPrograms(cmd)`，回傳 `{ segments, progs, unsafe }`，沿用 `splitArgs()` 的引號處理但保留運算子
- [ ] 1.2 實作指令位置分段：開頭，以及 `&&`、`||`、`;`、`|`、`&`、換行、`do`、`then`、`else`、`elif`、`{`、`(` 之後
- [ ] 1.3 排除 shell 保留字（`if`、`for`、`while`、`until`、`fi`、`done`、`esac`、`in`、`}`、`)`）與前置變數賦值
- [ ] 1.4 實作 `unsafe` 判定：`substitution`、`runsAnything`、`findExec`、`redirect`、`parse` 五種原因鍵
- [ ] 1.5 `RUNS_ANYTHING` 補上 `command`
- [ ] 1.6 於 `module.exports` 匯出 `commandPrograms`

## 2. `commandPrograms()` 單元測試

- [ ] 2.1 在 `test/tools.test.js` 匯入 `commandPrograms`
- [ ] 2.2 測試兩串真實探索指令（`printf && find && for…do…done`、`set -o pipefail` + `git`/`dotnet`/`gh`）的 `segments` 與 `progs`
- [ ] 2.3 測試 `find . -exec rm -rf {} \;` → `cmd.unsafe.findExec`
- [ ] 2.4 測試 `echo $(curl evil)` → `cmd.unsafe.substitution`
- [ ] 2.5 測試 `command -v gh || true` → `cmd.unsafe.runsAnything`
- [ ] 2.6 測試 `echo 'a && b'` 只解析出一段
- [ ] 2.7 測試 `find . -print 2>/dev/null` 非 unsafe；`echo x > ~/.zshrc` → `cmd.unsafe.redirect`
- [ ] 2.8 測試 `git status && git diff` 每一段都通過 `isAllowed(s, DEFAULT_ALLOWLIST)`
- [ ] 2.9 執行 `npm test` 確認全數通過

## 3. `run_command` 守門判斷式

- [ ] 3.1 改寫判斷式為 `denied || guardedPath || (meta ? !metaOk : !isAllowed(cmd, allowlist))`，其中 `metaOk` 要求 `parsed && !parsed.unsafe && parsed.segments.length > 0 && parsed.segments.every((s) => isAllowed(s, allowlist))`
- [ ] 3.2 `rememberable` 改為 `!denied && !guardedPath && (meta ? (parsed && !parsed.unsafe && parsed.progs.length > 0) : canRememberAlways(prog))`
- [ ] 3.3 `askOrPass()` 的 `always` 在 meta 情境傳入 `parsed.progs` 陣列
- [ ] 3.4 ask 負載新增 `whyKey` 欄位攜帶 `unsafe` 原因鍵
- [ ] 3.5 確認 `answer === 'always'` 分支能把陣列併入 `allowlist`

## 4. 對話框與持久化

- [ ] 4.1 `extension.js` 的 `askPermissionFromPanel()` 在 `always` 為陣列時改用 `action.allowPrograms` 鍵，標籤列出程式名
- [ ] 4.2 `askPermissionFromPanel()` 將 `whyKey` 翻譯後附在 `detail` 下方
- [ ] 4.3 `allowAlwaysCommand()` 接受字串或陣列，去重後一次寫入 `chatgptBridge.allowlist`
- [ ] 4.4 確認 `forgetAllowed()` 能逐條列出並移除新寫入的程式名（不需改碼，僅驗證）

## 5. 三語 i18n

- [ ] 5.1 `src/i18n/zh-tw.js` 新增 `action.allowPrograms` 與 5 個 `cmd.unsafe.*` 字串
- [ ] 5.2 `src/i18n/ja.js` 同上
- [ ] 5.3 `src/i18n/en.js` 同上
- [ ] 5.4 檢查三份檔案的鍵完全一致，無遺漏

## 6. 驗收

- [ ] 6.1 `npm test` 全綠
- [ ] 6.2 `npm run build` 成功（確認未破壞 webview 打包）
- [ ] 6.3 實機驗證：`mode: 'edit'` 下送出探索型複合指令，確認出現「允許每一次」按鈕
- [ ] 6.4 實機驗證：按下後再送出同類指令，確認不再詢問
- [ ] 6.5 實機驗證：送出 `find . -exec …` 形式的指令，確認只有「只允許這次／拒絕」且顯示原因
- [ ] 6.6 實機驗證：`git status && git diff` 不按任何按鈕即直接執行
