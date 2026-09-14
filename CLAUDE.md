# hadome 專案規則

## Git 工作流程

- **`main` 的合併一律人工執行。** 不要用 `gh pr merge`、`git merge`、`git push` 等方式自動把 PR 合併進 `main`，即使 CI 綠燈、PR 已核准，或使用者看起來同意合併方向也一樣。遇到「要不要合併」這類問題，只回報 PR 現況(是否有衝突、CI/檢查狀態、branch protection 設定)，等使用者親自在 GitHub 上按下 merge，或在對話中明確下指令(例如「幫我合併到 main」)才動手。
- **日常開發與 code review 都在 `develop` 及其下的功能分支層級進行。** 流程是：從 `develop` 切一個功能分支 → 開發/修 bug → 開 PR 回 `develop` → review → 合併進 `develop`。這一段(功能分支 → `develop`)可以照常協助開 PR、跑檢查、甚至合併。`develop` → `main` 是獨立、且一定要人工把關的最後一步。
- `main` 已設定 GitHub branch protection：禁止 force push、禁止刪除分支；未要求 PR review(目前單人維護)。之後若有協作者加入或建了 CI，可以再加嚴。

參見全域規則 `pr-merge` skill 中的「main 的特殊規則」章節。
