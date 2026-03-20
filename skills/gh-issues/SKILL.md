---
name: gh-issues
description: "Fetch GitHub issues, spawn sub-agents to implement fixes and open PRs, then monitor and address PR review comments. Usage: /gh-issues [owner/repo] [--label bug] [--limit 5] [--milestone v1.0] [--assignee @me] [--fork user/repo] [--watch] [--interval 5] [--reviews-only] [--cron] [--dry-run] [--model glm-5] [--notify-channel -1002381931352]"
user-invocable: true
metadata:
  { "openclaw": { "requires": { "bins": ["curl", "git", "gh"] }, "primaryEnv": "GH_TOKEN" } }
---

# gh-issues — Auto-fix GitHub Issues with Parallel Sub-agents

You are an orchestrator. Follow these 6 phases exactly. Do not skip phases.

IMPORTANT — No `gh` CLI dependency. This skill uses curl + the GitHub REST API exclusively. The GH_TOKEN env var is already injected by OpenClaw. Pass it as a Bearer token in all API calls:

```
curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" ...
```

---

## Phase 1 — Parse Arguments

Parse the arguments string provided after /gh-issues.

**Positional:** `owner/repo` — optional. If omitted, detect from `git remote get-url origin`.
- HTTPS: `https://github.com/owner/repo.git` → `owner/repo`
- SSH: `git@github.com:owner/repo.git` → `owner/repo`

**Flags:**
| Flag | Default | Description |
|------|---------|-------------|
| --label | _(none)_ | Filter by label |
| --limit | 10 | Max issues to fetch per poll |
| --milestone | _(none)_ | Filter by milestone title |
| --assignee | _(none)_ | Filter by assignee (`@me` for self) |
| --state | open | Issue state: open, closed, all |
| --fork | _(none)_ | Your fork (`user/repo`) for pushing branches and opening PRs |
| --watch | false | Keep polling after each batch |
| --interval | 5 | Minutes between polls (only with `--watch`) |
| --dry-run | false | Fetch and display only — no sub-agents |
| --yes | false | Skip confirmation, auto-process all |
| --reviews-only | false | Skip Phases 2-5, run only Phase 6 |
| --cron | false | Cron-safe: spawn agents, exit without waiting |
| --model | _(none)_ | Model for sub-agents (e.g. `glm-5`) |
| --notify-channel | _(none)_ | Telegram channel ID for final PR summary |

Derived values:
- `SOURCE_REPO` = positional owner/repo (where issues live)
- `PUSH_REPO` = --fork value if provided, else SOURCE_REPO
- `FORK_MODE` = true if --fork was provided

**If `--reviews-only`:** Skip to Phase 6 after token resolution.
**If `--cron`:** Force `--yes`. If also `--reviews-only`, jump to Phase 6 in cron mode.

---

## Phase 2 — Fetch Issues

**Token Resolution:** Check `$GH_TOKEN` → `~/.openclaw/openclaw.json` → `/data/.clawdbot/openclaw.json`.

```
curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/{SOURCE_REPO}/issues?per_page={limit}&state={state}&{query_params}"
```

- Build `query_params` from: `labels=`, `milestone=` (resolve title→number first), `assignee=` (resolve `@me`→username first)
- Filter out pull requests (exclude items where `pull_request` key exists)
- Error on 401/403: report auth failure and stop

---

## Phase 3 — Present & Confirm

Display a markdown table of fetched issues (number, title, labels). Show fork mode notice if active.

- `--dry-run`: display and stop
- `--yes`: auto-process all, proceed to Phase 4
- Otherwise: ask "all", comma-separated numbers, or "cancel"

---

## Phase 4 — Pre-flight Checks

Run sequentially:
1. **Dirty tree check** — warn if uncommitted changes exist
2. **Record BASE_BRANCH** — `git rev-parse --abbrev-ref HEAD`
3. **Verify remote access** — `git ls-remote --exit-code origin HEAD` (add `fork` remote if FORK_MODE)
4. **Verify GH_TOKEN** — GET /user, expect HTTP 200
5. **Skip existing PRs** — check API for open PRs with `fix/issue-{N}` head branch
6. **Skip in-progress branches** — check PUSH_REPO via API for `fix/issue-{N}` branch
7. **Skip claimed issues** — read `/data/.clawdbot/gh-issues-claims.json`, expire claims >2h old

See [`references/preflight-checks.md`](references/preflight-checks.md) for full curl commands and claim file format.

---

## Phase 5 — Spawn Sub-agents (Parallel)

**Cron mode:** Use cursor file to select ONE next issue → spawn single agent → write claim → exit.  
**Normal mode:** Spawn up to 8 agents concurrently. Write claims after spawning each.

After spawning, write claim: add `{SOURCE_REPO}#{N}` with current ISO timestamp to the claims file.

See [`references/sub-agent-prompt.md`](references/sub-agent-prompt.md) for the full sub-agent task template.

**Spawn config per agent:**
- `runTimeoutSeconds: 3600`
- `cleanup: "keep"`
- `model: "{MODEL}"` if `--model` was provided

---

## Results Collection

_(Skipped in cron mode)_

After all sub-agents complete, present a summary table:

| Issue | Status | PR | Notes |
|-------|--------|----|-------|
| #42 Fix null pointer | PR opened | https://github.com/.../pull/99 | 3 files changed |
| #37 Add retry logic | Failed | -- | Could not identify target code |

End with: "Processed {N} issues: {success} PRs opened, {failed} failed, {skipped} skipped."

If `--notify-channel` is set, send final summary to that Telegram channel.

Store opened PRs as `OPEN_PRS` for Phase 6.

---

## Phase 6 — PR Review Handler

Monitors open `fix/issue-*` PRs for review comments and spawns agents to address them.

**When it runs:** After Results Collection, when `--reviews-only` is set, or each watch cycle.

**Cron review mode (`--cron --reviews-only`):** Discover PRs → analyze comments → spawn ONE review-fix agent → exit.

### Step 6.1 — Discover PRs
- From Phase 5: use `OPEN_PRS`
- From `--reviews-only`: fetch all open PRs, filter to `head.ref` starting with `fix/issue-`

### Step 6.2 — Fetch Review Sources (per PR)
1. PR reviews: `GET /repos/{repo}/pulls/{n}/reviews`
2. Inline comments: `GET /repos/{repo}/pulls/{n}/comments`
3. General comments: `GET /repos/{repo}/issues/{n}/comments`
4. PR body for embedded reviews (e.g. Greptile `<!-- greptile_comment -->`)

### Step 6.3 — Analyze for Actionability
Determine bot's username via `GET /user`, exclude own comments.

**NOT actionable:** pure approvals, informational bot comments, already-addressed comments, APPROVED reviews with no inline changes.

**IS actionable:** `CHANGES_REQUESTED` reviews, comments with "please fix / change / update / will fail" language, inline code issues, embedded reviews flagging critical issues.

### Step 6.4 — Present & Confirm
Show table of PRs with actionable comment counts. Ask for confirmation unless `--yes` is set.

### Step 6.5 — Spawn Review Fix Sub-agents
Spawn up to 8 agents concurrently. See [`references/review-fix-prompt.md`](references/review-fix-prompt.md) for the full prompt template.

### Step 6.6 — Review Results
Summary table: PR, comments addressed, skipped, commit SHA, status. Add addressed comment IDs to `ADDRESSED_COMMENTS`.

---

## Watch Mode

After each batch:
1. Add processed issues to `PROCESSED_ISSUES`, addressed comments to `ADDRESSED_COMMENTS`
2. Sleep `{interval}` minutes
3. Return to Phase 2 (new issues filtered automatically)
4. Run Phase 6 for new review comments on all tracked PRs
5. Stop on user "stop" command; present cumulative summary

**Between-poll context:** Retain only `PROCESSED_ISSUES`, `ADDRESSED_COMMENTS`, `OPEN_PRS`, parsed args, `BASE_BRANCH`, `SOURCE_REPO`, `PUSH_REPO`, `FORK_MODE`, `BOT_USERNAME`. Discard issue bodies, comment bodies, and sub-agent transcripts.
