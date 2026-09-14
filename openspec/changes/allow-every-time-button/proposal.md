## Why

使用者選了「自動同意編輯檔案」（`mode: 'edit'`）後，仍然每次都被問「可以執行這個指令嗎？」，且對話框只有「只允許這次／拒絕」，永遠不會出現「一直允許」。

根因有三：

1. `run_command` 的守門判斷式把 `meta`（引號外含 `;` `&` `|` `` ` `` `$` `<` `>` 換行）當成**無條件**詢問的條件，`mode` 完全管不到這道閘門。
2. `rememberable` 的計算含 `!meta`，所以含 metacharacter 的指令拿不到 `always` 選項。
3. `isAllowed()` 拿**整串指令**比對前綴，複合指令不可能命中 `DEFAULT_ALLOWLIST`。

結果是 AI 常送出的探索型複合指令（`printf … && find … && for f in …; do …; done`）每次都要人工放行，且永遠無法累積成許可清單。唯一的替代方案是切到「略過權限確認」，代價是連危險指令都不再詢問。

## What Changes

在權限對話框新增第三顆按鈕「允許每一次」。按下後，把該指令中所有**指令位置的程式名**一次寫入許可清單，之後同類複合指令自動放行。

- 新增 `commandPrograms()` 詞法分析，把複合指令拆成 `segments`（各段完整文字）與 `progs`（程式名集合），並回報 `unsafe` 原因。
- 守門判斷式改為：複合指令若能安全解析、且**每一段**都命中許可清單，就直接放行。
- 無法安全解析時（命令替換、`RUNS_ANYTHING`、`find -exec`、危險重導向、詞法失敗）**不提供**按鈕，並在對話框說明原因。
- `RUNS_ANYTHING` 補上 `command`，堵住 `command -v X` 繞過程式名判定的路徑。

**刻意的行為擴張**：由已許可指令組成的複合指令（如 `git status && git diff`）從此不再詢問，不需按任何按鈕。

**不做**：不新增第五個權限模式；不改 `webview/panel.html`、`package.json` enum、`webview/src/ui/modeCycle.js`；不改許可清單的儲存位置與回收機制。

## Capabilities

### New Capabilities

- `command-permission`: `run_command` 的執行許可決策——何時直接放行、何時詢問、何時可將許可記入清單。

### Modified Capabilities

（無。`openspec/specs/` 目前為空，本變更為首個規格。）

## Impact

| 檔案 | 影響 |
|---|---|
| `src/tools.js` | 新增並匯出 `commandPrograms()`；改 `run_command` 守門判斷式；`always` 型別擴充為 `string \| string[]`；`RUNS_ANYTHING` 補 `command`；ask 負載新增 `whyKey` |
| `extension.js` | `askPermissionFromPanel()` 處理陣列 `always` 與 `whyKey`；`allowAlwaysCommand()` 接受陣列 |
| `src/i18n/zh-tw.js`、`ja.js`、`en.js` | 新增 `action.allowPrograms` 與 5 個 `cmd.unsafe.*` 字串 |
| `test/tools.test.js` | `commandPrograms()` 單元測試 |

**不受影響**：`webview/panel.html`（對話框由 `actions` 陣列驅動）、`package.json`、`webview/src/ui/modeCycle.js`、`chatgptBridge.allowlist` 的儲存範圍與 `forgetAllowed()` 回收機制。

**安全面**：許可粒度為程式名，記住 `git` 等於放行所有 `git` 子指令（`git branch -D` 仍被 denylist 攔下）。denylist 與保護路徑檢查維持整串比對，不受拆解影響。
