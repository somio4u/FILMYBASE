#!/bin/bash
# Automatic backup: commits any changes and pushes them to ONE branch only.
#   - does nothing when nothing changed
#   - never pushes to main, never force-pushes, never switches branches, never merges or pulls
#   - stops and logs when there is a conflict, the wrong branch is checked out,
#     or a secret file (.env, settings.local.json, ...) is about to be committed
# Log: <project>/auto-backup.log   (ignored by git)

BRANCH="claude/friendly-rubin-tu4rpn"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$REPO/auto-backup.log"
PATH="/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }
# a problem that keeps happening is logged once, not every 15 minutes
stop() {
  if [ "$(tail -n 1 "$LOG" 2>/dev/null | cut -d' ' -f4-)" != "STOPPED: $*" ]; then log "STOPPED: $*"; fi
  exit 1
}

cd "$REPO" || exit 1
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || stop "$REPO is not a git repository"

# one run at a time
LOCK="$REPO/.git/auto-backup.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  # a lock older than 30 minutes is left over from a crash
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then rmdir "$LOCK" 2>/dev/null && mkdir "$LOCK" 2>/dev/null || exit 0; else exit 0; fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# a merge, rebase, cherry-pick or unresolved conflict is in progress: do not touch anything
GITDIR="$(git rev-parse --git-dir)"
for f in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply; do
  [ -e "$GITDIR/$f" ] && stop "a git operation is in progress ($f). Finish or abort it, then the backup resumes."
done
[ -n "$(git diff --name-only --diff-filter=U)" ] && stop "unresolved merge conflicts in: $(git diff --name-only --diff-filter=U | tr '\n' ' ')"

# only the one branch
CURRENT="$(git branch --show-current)"
[ "$CURRENT" = "$BRANCH" ] || stop "checked out branch is '$CURRENT', not '$BRANCH'. Nothing was changed."

# (1) nothing to do?
[ -z "$(git status --porcelain)" ] && exit 0

# (2) stage everything git is allowed to see (.gitignore is respected)
git add -A >> "$LOG" 2>&1 || stop "git add failed"

# (5) never commit secrets, even if they were force-added
BAD="$(git diff --cached --name-only | grep -E '(^|/)(\.env($|\.)|settings\.local\.json$)|(^|/)[^/]*\.(pem|p12)$|(^|/)id_(rsa|ed25519)$|service[-_]?account[^/]*\.json$' || true)"
if [ -n "$BAD" ]; then
  git reset -q >> "$LOG" 2>&1
  stop "refusing to commit secret-looking files: $(echo "$BAD" | tr '\n' ' ')- unstaged everything"
fi

git diff --cached --quiet && exit 0   # only ignored/untracked-empty changes
COUNT="$(git diff --cached --name-only | wc -l | tr -d ' ')"
git commit -q -m "Auto-backup $(date '+%Y-%m-%d %H:%M:%S') ($COUNT files)" >> "$LOG" 2>&1 || stop "git commit failed"

# (3)+(4) push to the one branch, explicitly, no force
if git push -q origin "HEAD:refs/heads/$BRANCH" >> "$LOG" 2>&1; then
  log "backed up $COUNT files to $BRANCH ($(git rev-parse --short HEAD))"
else
  stop "push to $BRANCH was refused or failed (remote may have newer commits, or no network). Commit is saved locally; nothing was forced."
fi
