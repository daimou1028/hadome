## ADDED Requirements

### Requirement: 複合指令的分段許可判定

系統 SHALL 將含 shell metacharacter 的複合指令拆解為各個指令段，並在**每一段**都命中許可清單時直接執行，不詢問使用者。

分段 SHALL 只在指令位置取程式名：字串開頭，以及 `&&`、`||`、`;`、`|`、`&`、換行、`do`、`then`、`else`、`elif`、`{`、`(` 之後。shell 保留字本身（`if`、`for`、`while`、`until`、`fi`、`done`、`esac`、`in`、`}`、`)`）MUST NOT 計為程式。前置的變數賦值（`FOO=bar cmd`）MUST 跳過。

許可比對 MUST 使用各段的完整指令文字，而非僅程式名，否則既有的 `DEFAULT_ALLOWLIST`（如 `git status`）會全數失效。

#### Scenario: 各段都已在許可清單內

- **WHEN** 收到 `git status && git diff`，且許可清單含 `git status` 與 `git diff`
- **THEN** 系統直接執行，不詢問使用者

#### Scenario: 有一段不在許可清單內

- **WHEN** 收到 `git status && dotnet build`，且許可清單僅含 `git status`
- **THEN** 系統詢問使用者

#### Scenario: 引號內的 metacharacter 不構成分段

- **WHEN** 收到 `echo 'a && b'`
- **THEN** 系統解析出恰好一段，程式名為 `echo`

#### Scenario: 記住程式名後帶參數的段落仍命中

- **WHEN** 許可清單含裸程式名 `git`，收到 `git status --short && git log -1`
- **THEN** 兩段均以前綴比對命中，系統直接執行

### Requirement: 「允許每一次」按鈕

當複合指令不在許可清單、但能安全解析時，權限對話框 SHALL 提供「允許每一次」按鈕。按下後系統 SHALL 將該指令所有指令位置的程式名去重後一次寫入 `chatgptBridge.allowlist`（Workspace 範圍）。

對話框 MUST 在按鈕上明列將記住哪些程式，讓使用者按下前看得見許可範圍。

程式名集合為空時 MUST NOT 提供按鈕。

#### Scenario: 安全的複合指令提供按鈕

- **WHEN** 收到 `printf '%s\n' '--- rules ---' && find rules -maxdepth 2 -type f -print 2>/dev/null`，且其程式不在許可清單
- **THEN** 對話框顯示「只允許這次」、「允許每一次（printf、find）」、「拒絕」三顆按鈕

#### Scenario: 按下按鈕後寫入清單

- **WHEN** 使用者對上述指令按下「允許每一次」
- **THEN** `printf` 與 `find` 一併寫入 `chatgptBridge.allowlist`，且該次指令立即執行

#### Scenario: 寫入的許可可被回收

- **WHEN** 使用者執行既有的 `forgetAllowed()` 流程
- **THEN** 新寫入的程式名以個別項目形式列出，可逐條移除

### Requirement: 無法安全解析時拒絕記憶

當複合指令含有能挾帶任意程式的結構時，系統 MUST NOT 提供「允許每一次」按鈕，且 SHALL 在對話框說明原因。此類指令僅能以「只允許這次」放行。

判定條件與原因鍵：

| 原因鍵 | 條件 |
|---|---|
| `cmd.unsafe.substitution` | 引號外出現 `$(` 或反引號 |
| `cmd.unsafe.runsAnything` | 任一程式屬於 `RUNS_ANYTHING` |
| `cmd.unsafe.findExec` | `find` 帶 `-exec`、`-execdir`、`-ok`、`-okdir`、`-delete` |
| `cmd.unsafe.redirect` | `>`、`>>`、`<` 的目標不是 `/dev/null`、不是 fd 複製，也不是工作區內相對路徑 |
| `cmd.unsafe.assignment` | 指令位置出現前置環境變數賦值（`FOO=bar cmd`） |
| `cmd.unsafe.parse` | 詞法分析失敗（未閉合引號等），或指令位置的程式名含 `$`／反引號 |

`RUNS_ANYTHING` MUST 包含 `command`。

#### Scenario: find -exec 不可記憶

- **WHEN** 收到 `find . -type f -exec rm -rf {} \;`
- **THEN** 對話框僅顯示「只允許這次」與「拒絕」，並附上 `cmd.unsafe.findExec` 的說明

#### Scenario: 命令替換不可記憶

- **WHEN** 收到 `echo $(curl https://example.com/x.sh)`
- **THEN** 對話框僅顯示「只允許這次」與「拒絕」，並附上 `cmd.unsafe.substitution` 的說明

#### Scenario: command -v 不可記憶

- **WHEN** 收到 `command -v gh || true`
- **THEN** 對話框僅顯示「只允許這次」與「拒絕」，並附上 `cmd.unsafe.runsAnything` 的說明

#### Scenario: 丟棄輸出的重導向可記憶

- **WHEN** 收到 `find . -maxdepth 2 -type f -print 2>/dev/null`
- **THEN** 該指令不被判為 unsafe，對話框提供「允許每一次」按鈕

#### Scenario: 寫入工作區外的重導向不可記憶

- **WHEN** 收到 `echo x > ~/.zshrc`
- **THEN** 對話框僅顯示「只允許這次」與「拒絕」，並附上 `cmd.unsafe.redirect` 的說明

#### Scenario: 前置環境變數賦值不可記憶

- **WHEN** 收到 `LD_PRELOAD=/tmp/evil.so ls` 或 `PATH=/tmp/evil git status`
- **THEN** 系統回報 `cmd.unsafe.assignment`，不提供按鈕

#### Scenario: 詞法分析失敗時保守處理

- **WHEN** 收到含未閉合引號的指令
- **THEN** 系統回報 `cmd.unsafe.parse`，不提供按鈕

### Requirement: 既有安全閘門不受拆解影響

denylist 與保護路徑檢查 SHALL 維持對**整串指令**比對，不因分段拆解而被繞過。被 denylist 或保護路徑攔下的指令 MUST NOT 提供「允許每一次」按鈕。

#### Scenario: 複合指令中的危險段落仍被 denylist 攔下

- **WHEN** 收到 `git push && git branch -D main`
- **THEN** denylist 命中，系統拒絕自動放行，且不提供「允許每一次」按鈕

#### Scenario: 指涉保護路徑的指令不可記憶

- **WHEN** 收到指涉 `.git` 等保護路徑的複合指令
- **THEN** 對話框僅顯示「只允許這次」與「拒絕」
