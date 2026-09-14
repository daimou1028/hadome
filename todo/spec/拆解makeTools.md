# 拆解 makeTools() 巨大物件

更新時間：2026-09-12

## 基本資訊

| 項目 | 內容 |
|------|------|
| 分支 | feature/拆解makeTools |
| 影響範圍 | src/tools.js（單檔案，`makeTools` 的回傳介面不變）|
| 優先權 | 中 |
| 狀態 | 待執行 |

## 背景與目的

`src/tools.js`（2684 行）幾乎整個檔案圍繞著一個函式 `makeTools({...})`（[tools.js:659](../../src/tools.js)），內部回傳一個含 40+ 個 method 的巨大物件字面量 `all = { list_dir, browser_open, browser_read, ..., run_command, ... }`。所有工具共用同一個 closure（`root`、`allowlist`、`readAt`、`background` 等），難以單獨測試、難以依工具類別（檔案 / browser / git / 背景指令）拆檔。

## 實作內容

**原則：只做搬移/分組，不改變任何行為或對外介面。** `makeTools()` 的回傳值（工具名 → async function 的物件）必須維持完全相同的 key 與函式簽名。

### 修改檔案

- `src/tools.js`（保留：allowlist/denylist、路徑守衛、`makeTools` 主體、最終組裝）
- 新增：`src/tools/file-tools.js`（list_dir / read_file / write_file / edit_file / glob / search 等檔案類工具的 factory）
- 新增：`src/tools/browser-tools.js`（browser_open / browser_read / browser_click / browser_shot / browser_type / browser_close / browser_scroll / browser_save）
- 新增：`src/tools/git-tools.js`（enter_worktree / exit_worktree 等 git 相關工具，若 run_command 也在此範圍需一併評估歸屬）
- 新增：`src/tools/misc-tools.js`（spawn_agents / codebase_search / web_search / web_fetch / update_todos / read_rule / search_skills 等其餘工具）

（實際分組以 tools.js 現有工具清單的自然邊界為準，執行時先列出全部 method 名稱與所屬類別再動手，不要邊拆邊猜。）

### 具體變更

每個新檔案匯出一個 factory function，接收 `makeTools()` 現有的 closure 依賴（`root`、`pathFor`、`guard`、`askOrPass`、`withFull`、`clip` 等公用工具函式）作為參數，回傳該分類的工具物件片段；`makeTools()` 主體改成呼叫這些 factory 並用 `Object.assign`/展開語法把片段合併回 `all`。

### 驗收標準

- [ ] `node --check` 通過所有新增/修改檔案
- [ ] `Object.keys(makeTools({root:'/tmp'}))` 拆解前後完全相同（可用一次性腳本比對）
- [ ] 每個工具的行為（含錯誤訊息、i18n key）逐字保留，不重寫任何邏輯
- [ ] `src/tools.js` 行數明顯下降（帶出至少 3 個獨立檔案）
- [ ] 因無自動化測試（T-007 尚未執行完，視執行順序而定），需手動走過幾個關鍵工具（`read_file`、`glob`、`search`、`resolveInside` 路徑守衛）確認回傳格式不變

## Git Commit

（執行完成後填入）
