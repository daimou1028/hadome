## Context

hadome 的 `run_command` 有一道與 `mode` 無關的獨立閘門。`mode` 只影響工作區內寫檔確認（`pathFor()` 中的 `if (write && mode === 'ask')`），指令執行則由許可清單把關，唯有 `mode === 'never'` 能讓 `askOrPass()` 直接回 `'once'` 全數放行。

現行守門判斷式：

```js
if (denied || meta || guardedPath || !isAllowed(cmd, allowlist)) {
```

`meta` 是無條件觸發詢問的條件，而 `rememberable = !denied && !meta && !guardedPath && canRememberAlways(prog)` 又因為 `!meta` 而永遠為 false。兩者合起來使得複合指令既無法命中清單、也無法加入清單。

詳細背景見 [docs/superpowers/specs/2026-09-14-allow-every-time-button-design.md](../../../docs/superpowers/specs/2026-09-14-allow-every-time-button-design.md)。

## Goals / Non-Goals

**Goals:**

- 讓使用者能一次許可一整類複合指令，且許可可累積、可回收。
- 保留對「能挾帶任意程式」結構的防線，不因便利而開後門。
- 重用既有的 `chatgptBridge.allowlist` 與 `forgetAllowed()`，不新增設定項。

**Non-Goals:**

- 不新增第五個權限模式（真要全放行，「略過權限確認」已存在）。
- 不改 `webview/panel.html`、`package.json` enum、`webview/src/ui/modeCycle.js`。
- 不做兩段式許可粒度（如 `git branch`），命中率太低。
- 不追求 100% 消除詢問；`find -exec`、`$(...)` 這類仍會每次詢問。

## Decisions

### D1：「類似」＝指令中用到的所有程式名

按下按鈕時把該指令所有指令位置的程式名一次寫入清單。替代方案是記住指令全文（`isAllowed` 的 `c === a` 即可命中），實作最小且零新安全面，但 AI 幾乎不會送出逐字相同的第二串指令，實質等於沒做。

**取捨**：記住 `git` 等於放行所有 `git` 子指令，包含 `git push`、`git reset --hard`。因此對話框必須明列將記住的程式，讓使用者按下前看得見。

### D2：比對用 `segments` 而非 `progs`

`isAllowed('git', ['git status'])` 為 false。若只比對程式名，既有的 `DEFAULT_ALLOWLIST` 會全數失效，形同砍掉現有許可。改用各段完整文字比對後，`git status && git diff` 的兩段都能命中既有清單。

**衍生的行為擴張**：由已許可指令組成的複合指令從此不再詢問。這是刻意且經確認的決定，比「只加一顆按鈕」影響更大。

### D3：解析不安全時收起按鈕，而非放寬

替代方案是「能抓幾個算幾個」照樣提供按鈕，最省詢問，但等於接受「第一次放行 `find` 之後，`find -exec rm -rf` 永遠不再問」。另一替代方案是二次確認彈窗，彈性最高但多一層 UI 與狀態。選擇最保守的一條。

`RUNS_ANYTHING` 需補 `command`：`command -v gh` 能以 `command` 為程式名繞過判定。

### D4：重導向的細分

`>` 屬於 `SHELL_META`，若一律視為 unsafe，`2>/dev/null` 這種極常見的寫法就拿不到按鈕。改為檢查重導向目標：`/dev/null` 或工作區內相對路徑視為安全，其餘 unsafe。放行工作區內寫入與 `edit` 模式的既有語意一致。

### D4b：前置環境變數賦值一律不可記憶（實作中發現）

原設計把 `FOO=bar cmd` 的賦值視為「跳過」，讓 `cmd` 成為程式名。實作後發現這會開出一條提權路徑：`NODE_ENV=test npm test` 被剝掉賦值後兩段都命中清單而自動放行，等同於 `LD_PRELOAD=/tmp/evil.so ls`、`PATH=/tmp/evil git status` 也會自動放行。現行程式碼原本靠 `leadingAssignment()` 把這類指令歸入 `meta` 而一律詢問，這道防線不能拆。

因此新增第六個原因鍵 `cmd.unsafe.assignment`：指令位置一出現賦值即判為不可記憶。

### D5：unsafe 原因以 key 傳遞而非內嵌字串

既有的 denylist 把日文 `why` 直接內嵌進 `detail`，在中／英文介面下會露出日文。新機制改於 ask 負載加 `whyKey` 欄位，由 `extension.js` 翻譯後附上，避免延續這個問題。

### D6：對話框不需改 webview

`askPermissionFromPanel()` 送出的 `actions` 陣列驅動按鈕渲染，新增按鈕只需讓 `always` 有值並選用新的 i18n 鍵 `action.allowPrograms`。

## Risks / Trade-offs

| 風險 | 緩解 |
|---|---|
| 自寫 shell 詞法分析可能有漏判，導致危險程式被記入清單 | `unsafe` 判定往保守方向倒；詞法失敗直接回 `cmd.unsafe.parse`；單元測試涵蓋攻擊案例 |
| 程式名粒度過寬（記住 `git` 即放行 `git push`） | 對話框明列將記住的程式；denylist 仍攔 `git branch -D`；`forgetAllowed()` 可逐條回收 |
| D2 的行為擴張讓既有使用者感到「突然變寬鬆」 | 擴張僅限「各段都已在清單內」，等於使用者早已逐條許可過的指令組合 |
| `RUNS_ANYTHING` 清單可能還有未涵蓋的挾帶程式（如 `watch`、`timeout`） | 本次先補 `command`；清單是純資料，後續發現可低成本追加 |
| 分段規則未涵蓋 `case`/`esac`、行內函式定義等冷門語法 | 未涵蓋的語法會落入 `cmd.unsafe.parse`，退回「只允許這次」，不會誤放行 |
