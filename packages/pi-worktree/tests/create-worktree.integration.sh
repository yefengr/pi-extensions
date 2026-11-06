#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CREATOR="$(cd "$SCRIPT_DIR/.." && pwd -P)/scripts/create-worktree.sh"
TEMP_ROOT="$(mktemp -d)"
ORIGINAL_HOME="$HOME"

cleanup() {
  rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT

fail_test() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_file_contains() {
  local file="$1"
  local expected="$2"
  grep -Fq "$expected" "$file" || fail_test "$file 未包含：$expected"
}

assert_branch_exists() {
  local repo="$1"
  local branch="$2"
  git -C "$repo" show-ref --verify --quiet "refs/heads/$branch" \
    || fail_test "分支不存在：$branch"
}

assert_branch_absent() {
  local repo="$1"
  local branch="$2"
  if git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
    fail_test "分支不应存在：$branch"
  fi
}

assert_registered() {
  local repo="$1"
  local target="$2"
  target="$(cd "$target" && pwd -P)"
  git -C "$repo" worktree list --porcelain | grep -Fqx "worktree $target" \
    || fail_test "工作树未登记：$target"
}

assert_not_registered() {
  local repo="$1"
  local target="$2"
  if [[ -e "$target" ]]; then
    target="$(cd "$target" && pwd -P)"
  fi
  if git -C "$repo" worktree list --porcelain | grep -Fqx "worktree $target"; then
    fail_test "工作树不应登记：$target"
  fi
}

new_repo() {
  local name="$1"
  local repo="$TEMP_ROOT/repos/$name"
  mkdir -p "$repo"
  git -C "$repo" init -q -b main
  git -C "$repo" config user.name tester
  git -C "$repo" config user.email tester@example.com
  printf 'fixture\n' >"$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -qm init
  printf '%s\n' "$repo"
}

run_creator() {
  local agent_dir="$1"
  shift
  PI_CODING_AGENT_DIR="$agent_dir" HOME="$ORIGINAL_HOME" \
    bash "$CREATOR" "$@"
}

printf '1..15\n'

repo="$(new_repo new-branch)"
case_dir="$TEMP_ROOT/cases/new-branch"
agent_dir="$case_dir/agent"
state="$TEMP_ROOT/state-new-branch"
run_creator "$agent_dir" --repo "$repo" --name sample-new --base main --branch feat/new --state-file "$state" >/dev/null
assert_file_contains "$state" completed
assert_registered "$repo" "$case_dir/worktrees/sample-new"
marker="$(git -C "$case_dir/worktrees/sample-new" rev-parse --absolute-git-dir)/pi-worktree-manager.json"
[[ -f "$marker" ]] || fail_test "成功创建后缺少所有权标记：$marker"
assert_file_contains "$marker" '"schemaVersion":1'
assert_file_contains "$marker" '"createdAt":"'
[[ ! -e "$case_dir/worktrees/sample-new/pi-worktree-manager.json" ]] || fail_test "所有权标记不得写入工作区"
assert_branch_exists "$repo" feat/new
printf 'ok 1 - 新分支模式并写入所有权标记\n'

repo="$(new_repo existing-branch)"
git -C "$repo" branch feat/existing
case_dir="$TEMP_ROOT/cases/existing-branch"
agent_dir="$case_dir/agent"
state="$TEMP_ROOT/state-existing"
run_creator "$agent_dir" --repo "$repo" --name sample-existing --existing-branch feat/existing --state-file "$state" >/dev/null
assert_registered "$repo" "$case_dir/worktrees/sample-existing"
[[ "$(git -C "$case_dir/worktrees/sample-existing" branch --show-current)" == "feat/existing" ]] \
  || fail_test "未检出已有分支"
printf 'ok 2 - 已有分支模式\n'

repo="$(new_repo detached)"
case_dir="$TEMP_ROOT/cases/detached"
agent_dir="$case_dir/agent"
state="$TEMP_ROOT/state-detached"
run_creator "$agent_dir" --repo "$repo" --name sample-detached --base main --detach --state-file "$state" >/dev/null
assert_registered "$repo" "$case_dir/worktrees/sample-detached"
[[ -z "$(git -C "$case_dir/worktrees/sample-detached" branch --show-current)" ]] \
  || fail_test "detached 模式仍有当前分支"
printf 'ok 3 - detached 模式\n'

repo="$(new_repo invalid-name)"
case_dir="$TEMP_ROOT/cases/invalid-name"
agent_dir="$case_dir/agent"
state="$TEMP_ROOT/state-invalid-name"
if run_creator "$agent_dir" --repo "$repo" --name ../escape --base main --branch feat/escape --state-file "$state" >/dev/null 2>&1; then
  fail_test "非法名称不应成功"
fi
assert_branch_absent "$repo" feat/escape
[[ ! -e "$case_dir/escape" ]] || fail_test "路径穿越产生了目录"
printf 'ok 4 - 非法名称和路径穿越\n'

repo="$(new_repo invalid-base)"
case_dir="$TEMP_ROOT/cases/invalid-base"
agent_dir="$case_dir/agent"
state="$TEMP_ROOT/state-invalid-base"
if run_creator "$agent_dir" --repo "$repo" --name sample-invalid-base --base missing --branch feat/missing --state-file "$state" >/dev/null 2>&1; then
  fail_test "不存在的基准不应成功"
fi
assert_branch_absent "$repo" feat/missing
assert_not_registered "$repo" "$case_dir/worktrees/sample-invalid-base"
printf 'ok 5 - 不存在的基准引用\n'

repo="$(new_repo before-failure)"
mkdir -p "$repo/.pi/worktree"
cat >"$repo/.pi/worktree/setup.sh" <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "before-create" ]] && exit 17
HOOK
chmod +x "$repo/.pi/worktree/setup.sh"
git -C "$repo" add .pi/worktree/setup.sh
git -C "$repo" commit -qm hook
agent_dir="$TEMP_ROOT/cases/before-failure/agent"
state="$TEMP_ROOT/state-before-failure"
hook_blob="$(git hash-object "$repo/.pi/worktree/setup.sh")"
if run_creator "$agent_dir" --repo "$repo" --name sample-before-fail --base main --branch feat/before-fail --state-file "$state" --approve-setup-hook "$hook_blob" >/dev/null 2>&1; then
  fail_test "before-create 失败不应成功"
fi
assert_file_contains "$state" before-create
assert_branch_absent "$repo" feat/before-fail
assert_not_registered "$repo" "$TEMP_ROOT/cases/before-failure/worktrees/sample-before-fail"
printf 'ok 6 - before-create 失败不留工作树或分支\n'

repo="$(new_repo after-failure)"
mkdir -p "$repo/.pi/worktree"
cat >"$repo/.pi/worktree/setup.sh" <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "after-create" ]]; then
  exit 23
fi
HOOK
chmod +x "$repo/.pi/worktree/setup.sh"
git -C "$repo" add .pi/worktree/setup.sh
git -C "$repo" commit -qm hook
case_dir="$TEMP_ROOT/cases/after-failure"
agent_dir="$case_dir/agent"
state="$TEMP_ROOT/state-after-failure"
hook_blob="$(git hash-object "$repo/.pi/worktree/setup.sh")"
if run_creator "$agent_dir" --repo "$repo" --name sample-after-fail --base main --branch feat/after-fail --state-file "$state" --approve-setup-hook "$hook_blob" >/dev/null 2>&1; then
  fail_test "after-create 失败不应成功"
fi
assert_file_contains "$state" after-create
assert_branch_exists "$repo" feat/after-fail
assert_registered "$repo" "$case_dir/worktrees/sample-after-fail"
marker="$(git -C "$case_dir/worktrees/sample-after-fail" rev-parse --absolute-git-dir)/pi-worktree-manager.json"
[[ -f "$marker" ]] || fail_test "after-create 失败后缺少所有权标记：$marker"
assert_file_contains "$marker" '"schemaVersion":1'
printf 'ok 7 - after-create 失败保留工作树、分支和所有权标记\n'

repo="$(new_repo no-hook)"
case_dir="$TEMP_ROOT/cases/no-hook"
agent_dir="$case_dir/agent"
state="$TEMP_ROOT/state-no-hook"
output="$(run_creator "$agent_dir" --repo "$repo" --name sample-no-hook --base main --branch feat/no-hook --state-file "$state")"
[[ "$output" == *"跳过项目初始化钩子"* ]] || fail_test "无钩子时缺少跳过提示"
assert_file_contains "$state" completed
printf 'ok 8 - 无项目钩子\n'

repo="$(new_repo existing-target)"
case_dir="$TEMP_ROOT/cases/existing-target"
agent_dir="$case_dir/agent"
mkdir -p "$case_dir/worktrees/sample-existing-target"
state="$TEMP_ROOT/state-existing-target"
if run_creator "$agent_dir" --repo "$repo" --name sample-existing-target --base main --branch feat/target --state-file "$state" >/dev/null 2>&1; then
  fail_test "已有目标路径不应成功"
fi
assert_branch_absent "$repo" feat/target
printf 'ok 9 - 已有目标路径安全失败\n'

repo="$(new_repo checked-out-branch)"
case_dir="$TEMP_ROOT/cases/checked-out-branch"
agent_dir="$case_dir/agent"
state="$TEMP_ROOT/state-checked-out-branch"
git -C "$repo" branch feat/checked-out
occupied="$TEMP_ROOT/occupied-worktree"
git -C "$repo" worktree add "$occupied" feat/checked-out >/dev/null
if run_creator "$agent_dir" --repo "$repo" --name sample-checked-out --existing-branch feat/checked-out --state-file "$state" >/dev/null 2>&1; then
  fail_test "已被检出的分支不应重复挂载"
fi
assert_file_contains "$state" git-add
assert_not_registered "$repo" "$case_dir/worktrees/sample-checked-out"
printf 'ok 10 - 已检出分支安全失败\n'

repo="$(new_repo hook-mismatch)"
mkdir -p "$repo/.pi/worktree"
cat >"$repo/.pi/worktree/setup.sh" <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail
exit 0
HOOK
chmod +x "$repo/.pi/worktree/setup.sh"
git -C "$repo" add .pi/worktree/setup.sh
git -C "$repo" commit -qm hook
agent_dir="$TEMP_ROOT/cases/hook-mismatch/agent"
state="$TEMP_ROOT/state-hook-mismatch"
if run_creator "$agent_dir" --repo "$repo" --name sample-hook-mismatch --base main --branch feat/hook-mismatch --state-file "$state" --approve-setup-hook deadbeef >/dev/null 2>&1; then
  fail_test "错误钩子内容标识不应成功"
fi
assert_file_contains "$state" validation
assert_branch_absent "$repo" feat/hook-mismatch
assert_not_registered "$repo" "$TEMP_ROOT/cases/hook-mismatch/worktrees/sample-hook-mismatch"
printf 'ok 11 - 钩子批准绑定内容标识\n'

repo="$(new_repo ownership-failure)"
case_dir="$TEMP_ROOT/cases/ownership-failure"
agent_dir="$case_dir/agent"
state="$TEMP_ROOT/state-ownership-failure"
fake_bin="$TEMP_ROOT/fake-bin"
mkdir -p "$fake_bin"
printf '#!/usr/bin/env bash\nexit 1\n' >"$fake_bin/node"
chmod +x "$fake_bin/node"
if PATH="$fake_bin:$PATH" PI_CODING_AGENT_DIR="$agent_dir" HOME="$ORIGINAL_HOME" \
  bash "$CREATOR" --repo "$repo" --name sample-ownership-fail --base main --branch feat/ownership-fail --state-file "$state" >/dev/null 2>&1; then
  fail_test "所有权标记写入失败时不应成功"
fi
assert_file_contains "$state" ownership
assert_branch_exists "$repo" feat/ownership-fail
assert_registered "$repo" "$case_dir/worktrees/sample-ownership-fail"
marker="$(git -C "$case_dir/worktrees/sample-ownership-fail" rev-parse --absolute-git-dir)/pi-worktree-manager.json"
[[ ! -e "$marker" ]] || fail_test "标记写入失败时不应留下标记：$marker"
printf 'ok 12 - 所有权标记写入失败保留工作树并停留在 ownership 阶段\n'

repo="$(new_repo tilde-agent-dir)"
case_dir="$TEMP_ROOT/cases/tilde-agent-dir"
home_dir="$case_dir/home"
run_dir="$case_dir/cwd"
mkdir -p "$home_dir" "$run_dir"
state="$TEMP_ROOT/state-tilde-agent-dir"
(
  cd "$run_dir"
  HOME="$home_dir" PI_CODING_AGENT_DIR='~/pi/agent' \
    bash "$CREATOR" --repo "$repo" --name sample-tilde --base main --branch feat/tilde --state-file "$state" >/dev/null
)
assert_file_contains "$state" completed
assert_registered "$repo" "$home_dir/pi/worktrees/sample-tilde"
[[ ! -e "$run_dir/~" && ! -e "$run_dir/pi" ]] || fail_test "字面 ~ 不应在 CWD 下产生目录"
printf 'ok 13 - PI_CODING_AGENT_DIR 字面 ~ 展开到 HOME\n'

repo="$(new_repo relative-agent-dir)"
case_dir="$TEMP_ROOT/cases/relative-agent-dir"
home_dir="$case_dir/home"
run_dir="$case_dir/cwd"
mkdir -p "$home_dir" "$run_dir"
state="$TEMP_ROOT/state-relative-agent-dir"
if (
  cd "$run_dir"
  HOME="$home_dir" PI_CODING_AGENT_DIR='relative/agent' \
    bash "$CREATOR" --repo "$repo" --name sample-relative --base main --branch feat/relative --state-file "$state" >/dev/null 2>&1
); then
  fail_test "相对 PI_CODING_AGENT_DIR 不应成功"
fi
assert_file_contains "$state" validation
assert_branch_absent "$repo" feat/relative
[[ ! -e "$run_dir/relative" ]] || fail_test "相对路径不应在 CWD 产生目录"
printf 'ok 14 - 相对 PI_CODING_AGENT_DIR 被拒绝\n'

repo="$(new_repo default-agent-dir)"
case_dir="$TEMP_ROOT/cases/default-agent-dir"
home_dir="$case_dir/home"
run_dir="$case_dir/cwd"
mkdir -p "$home_dir" "$run_dir"
state="$TEMP_ROOT/state-default-agent-dir"
(
  cd "$run_dir"
  env -u PI_CODING_AGENT_DIR HOME="$home_dir" \
    bash "$CREATOR" --repo "$repo" --name sample-default --base main --branch feat/default --state-file "$state" >/dev/null
)
assert_file_contains "$state" completed
assert_registered "$repo" "$home_dir/.pi/worktrees/sample-default"
printf 'ok 15 - 默认工作树根目录位于 HOME/.pi/worktrees\n'
