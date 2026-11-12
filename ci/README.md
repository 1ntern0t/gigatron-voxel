# CI

GitHub Actions runs [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) on pushes to `main` and on pull requests. The job installs dependencies with `npm ci`, runs the Node unit tests, runs the headless Chrome smoke test, and uploads screenshots from `artifacts/`.

The workflow used to live at `ci/github-actions-ci.yml`. Actions never loaded that path, and the token that published the repo lacked the `workflow` scope, so CI did not run until the file was moved.

`actions/checkout` and `actions/setup-node` are pinned to v5, and `actions/upload-artifact` to v6. The previous majors run on Node 20, which GitHub-hosted runners removed on 2026-09-23. v5, v5, and v6 are the oldest majors that declare Node 24. The test commands are unchanged.
