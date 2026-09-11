# 拆解 handleRun() 巨型函式

更新時間：2026-09-12

## 基本資訊

| 項目 | 內容 |
|------|------|
| 分支 | feature/拆解handleRun |
| 影響範圍 | extension.js（單檔案，無外部 API 變動）|
| 優先權 | 中 |
| 狀態 | 待執行 |

## 背景與目的

`extension.js` 的 `handleRun(task)`（約 [extension.js:569-1183](../../extension.js)，近 600 行）一次處理了：

1. queue 路由與 MCP 連線建立/拆卸
2. mention/attachment（`@檔案`）解析與組裝
3. `runAgent()` 呼叫時傳入的 20+ 個 callback（onTool/onTurn/onDelta/onNotice/...）組裝
4. 執行結果的 post-processing（session 更新、UI 通知、result 訊息組裝）
5. try/catch/finally 錯誤處理與佇列的下一筆觸發

目前完全無法單獨測試其中任一段行為，修改任何一小塊都要重新理解整個函式。

## 實作內容

**原則：只做 extract method，不改變任何行為。** 這是重構任務，不是修 bug，驗收標準是「行為與重構前逐位元組相同」。

### 修改檔案

`extension.js`

### 具體變更

把 `handleRun()` 內部拆成幾個具名的**巢狀函式**（仍在 `handleRun` 作用域內，因為大量閉包捕捉了 `s`、`current`、`session` 等模組級/區域變數，不強行拉到模組頂層以免破壞閉包語意），大致切法：

1. `setupMcp(mcpSettings)` — 對應現有 `if (settings().mcp) { ... }` 區塊（約 590-606 行），回傳 `mcpGot`
2. `buildTaskAttachments(s, task)` — mention 解析、`uploadFiles` 組裝、`buildAttachment` 呼叫（約 667-745 行），回傳 `{ taskText, uploadFiles }`
3. `buildAgentCallbacks(s, ctx)` — `runAgent()` 呼叫時的整包 callback 物件（約 749-1087 行，目前是 `runAgent({...})` 的巨大物件字面量），拆成獨立函式回傳這個物件，讓 `runAgent` 呼叫本身只剩「組 callbacks → await runAgent」兩行
4. `handleRunResult(s, result)` — 執行完後的 session 更新、`notifyIdle`、`post({type:'result',...})`（約 1089-1142 行）

`try/catch/finally` 骨架與 `queue.next()` 觸發下一筆（1175-1182 行）留在最外層的 `handleRun` 本體，不拆。

### 驗收標準

- [ ] `node --check extension.js` 通過
- [ ] 拆解後 `handleRun()` 主體只剩流程編排（呼叫上述 4 個子函式 + try/catch/finally），不含業務邏輯細節
- [ ] `git diff` 只有「搬動程式碼 + 包一層 function」，找不到任何邏輯改動（不新增/移除 if 分支、不改變呼叫順序、不改變任何字串/數值）
- [ ] 因為沒有自動化測試（見 T-007），驗證方式是：逐段 diff 比對搬動前後的程式碼字元完全一致，且對 `runAgent`/`post`/`s.*` 等呼叫順序不變

## Git Commit

（執行完成後填入）
