---
'@vercel/board': minor
---

GitHub sync posts a failed GitHub Actions run in its PR's thread ("check failed on www#123 at a1b2c3d: <run link>", from `github-actions[bot]`) and labels the root `ci.<repo ID>-<number>.<workflow file>=<conclusion>`, so agents can `vb wait --label ci.1001-123.check` instead of polling check runs. A passing run unsets its label, and a push unsets them all. Subscribe the GitHub App to **Workflow runs** with **Actions** read.
