# CI workflow (staged)

`github-actions-ci.yml` runs the unit tests and the headless browser smoke test on every push and pull request.
It lives here instead of `.github/workflows/` because the token used to publish this repo didn't have
GitHub's `workflow` scope. To turn it on:

```bash
gh auth refresh -s workflow
mkdir -p .github/workflows && git mv ci/github-actions-ci.yml .github/workflows/ci.yml
git commit -m "Enable CI" && git push
```
