# Pre-flight Checks — Full Reference

## Step 5 — Check for Existing PRs

For each confirmed issue number N:

```bash
curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/{SOURCE_REPO}/pulls?head={PUSH_REPO_OWNER}:fix/issue-{N}&state=open&per_page=1"
```

(PUSH_REPO_OWNER = owner portion of PUSH_REPO)

If response array is non-empty → skip issue, report:
> "Skipping #{N} — PR already exists: {html_url}"

## Step 6 — Check for In-progress Branches

For each remaining issue N:

```bash
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $GH_TOKEN" \
  "https://api.github.com/repos/{PUSH_REPO}/branches/fix/issue-{N}"
```

If HTTP 200 → branch exists on push repo but no PR yet → skip:
> "Skipping #{N} — branch fix/issue-{N} exists on {PUSH_REPO}, fix likely in progress"

## Step 7 — Claim-based In-progress Tracking

Prevents duplicate processing when a sub-agent hasn't pushed a branch yet.

```bash
CLAIMS_FILE="/data/.clawdbot/gh-issues-claims.json"
if [ ! -f "$CLAIMS_FILE" ]; then
  mkdir -p /data/.clawdbot
  echo '{}' > "$CLAIMS_FILE"
fi
```

Expire claims older than 2 hours:

```bash
CLAIMS=$(cat "$CLAIMS_FILE")
CUTOFF=$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-2H +%Y-%m-%dT%H:%M:%SZ)
CLAIMS=$(echo "$CLAIMS" | jq --arg cutoff "$CUTOFF" 'to_entries | map(select(.value > $cutoff)) | from_entries')
echo "$CLAIMS" > "$CLAIMS_FILE"
```

Check if `{SOURCE_REPO}#{N}` is a key in the claims file. If claimed and not expired:
> "Skipping #{N} — sub-agent claimed this issue {minutes}m ago, still within timeout window"

## Cron Mode — Cursor Tracking

```bash
CURSOR_FILE="/data/.clawdbot/gh-issues-cursor-{SOURCE_REPO_SLUG}.json"
# SOURCE_REPO_SLUG = owner-repo (slashes → hyphens)
```

Cursor file format:
```json
{"last_processed": null, "in_progress": null}
```

Select next issue: first where `issue_number > last_processed` AND not claimed AND no PR AND no branch. Wrap around to oldest eligible if none found past cursor.

After spawning: mark `in_progress` in cursor file, write claim, fire-and-forget, exit skill.
