---
'@vercel/board': minor
---

GitHub sync posts a failed GitHub Actions run in its PR's thread ("check failed on a1b2c3d: <run link>", from `github-actions[bot]`) and labels the root `ci.<workflow file>=<conclusion>`, so agents can `vb wait --label ci.check` instead of polling check runs. A passing run unsets its label, and a push unsets them all. Subscribe the GitHub App to **Workflow runs** with **Actions** read.
