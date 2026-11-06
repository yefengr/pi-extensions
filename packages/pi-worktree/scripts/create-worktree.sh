#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' \
    '用法：' \
    '  create-worktree.sh --repo <仓库路径> --name <名称> --base <引用> --branch <新分支> --state-file <文件> [--approve-setup-hook <blob-id>]' \
    '  create-worktree.sh --repo <仓库路径> --name <名称> --existing-branch <分支> --state-file <文件> [--approve-setup-hook <blob-id>]' \
    '  create-worktree.sh --repo <仓库路径> --name <名称> --base <引用> --detach --state-file <文件> [--approve-setup-hook <blob-id>]'
}

fail() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

set_mode() {
  local requested_mode="$1"
  if [[ -n "$mode" && "$mode" != "$requested_mode" ]]; then
    fail "--branch、--existing-branch 和 --detach 只能选择一种"
  fi
  mode="$requested_mode"
}

write_state() {
  local state="$1"
  [[ -n "$state_file" ]] || return 0
  printf '%s\n' "$state" >"$state_file"
}

repo_input=""
name=""
base=""
branch=""
mode=""
state_file=""
approved_setup_hook_blob=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      [[ $# -ge 2 ]] || fail "--repo 缺少参数"
      repo_input="$2"
      shift 2
      ;;
    --name)
      [[ $# -ge 2 ]] || fail "--name 缺少参数"
      name="$2"
      shift 2
      ;;
    --base)
      [[ $# -ge 2 ]] || fail "--base 缺少参数"
      base="$2"
      shift 2
      ;;
    --branch)
      [[ $# -ge 2 ]] || fail "--branch 缺少参数"
      set_mode "new-branch"
      branch="$2"
      shift 2
      ;;
    --existing-branch)
      [[ $# -ge 2 ]] || fail "--existing-branch 缺少参数"
      set_mode "existing-branch"
      branch="$2"
      shift 2
      ;;
    --detach)
      set_mode "detached"
      shift
      ;;
    --state-file)
      [[ $# -ge 2 ]] || fail "--state-file 缺少参数"
      state_file="$2"
      shift 2
      ;;
    --approve-setup-hook)
      [[ $# -ge 2 ]] || fail "--approve-setup-hook 缺少钩子内容标识"
      approved_setup_hook_blob="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "未知参数：$1"
      ;;
  esac
done

[[ -n "$state_file" ]] || fail "必须提供 --state-file"
[[ "$state_file" == /* ]] || fail "--state-file 必须是绝对路径"
[[ -d "$(dirname "$state_file")" ]] || fail "--state-file 父目录不存在"
[[ ! -e "$state_file" && ! -L "$state_file" ]] || fail "--state-file 必须指向尚不存在的文件"
write_state "validation"

[[ -n "$repo_input" ]] || fail "必须提供 --repo"
source_root="$(git -C "$repo_input" rev-parse --show-toplevel 2>/dev/null)" \
  || fail "不是有效的 Git 仓库路径：$repo_input"
source_root="$(cd "$source_root" && pwd -P)"

[[ -n "$name" ]] || fail "必须提供 --name"
[[ "$name" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || fail "工作树名称只能包含小写字母、数字和单连字符"
[[ ${#name} -le 40 ]] || fail "工作树名称不得超过 40 个字符"
[[ -n "$mode" ]] || fail "必须选择 --branch、--existing-branch 或 --detach"

# 只允许从主检出创建，避免从 linked worktree 继续派生工作空间。
git_dir="$(git -C "$source_root" rev-parse --absolute-git-dir)"
git_common_dir="$(git -C "$source_root" rev-parse --path-format=absolute --git-common-dir)"
superproject_root="$(git -C "$source_root" rev-parse --show-superproject-working-tree)"
if [[ -z "$superproject_root" && "$git_dir" != "$git_common_dir" ]]; then
  fail "指定仓库已经是 linked worktree：$source_root；请从主仓库执行创建器"
fi

case "$mode" in
  existing-branch)
    [[ -z "$base" ]] || fail "--existing-branch 模式不接受 --base"
    git -C "$source_root" check-ref-format --branch "$branch" >/dev/null \
      || fail "已有分支名称不合法：$branch"
    git -C "$source_root" show-ref --verify --quiet "refs/heads/$branch" \
      || fail "本地分支不存在：$branch"
    base="$branch"
    ;;
  new-branch)
    [[ -n "$base" ]] || fail "--branch 模式必须提供 --base"
    git -C "$source_root" check-ref-format --branch "$branch" >/dev/null \
      || fail "新分支名称不合法：$branch"
    if git -C "$source_root" show-ref --verify --quiet "refs/heads/$branch"; then
      fail "本地分支已经存在，请改用 --existing-branch：$branch"
    fi
    git -C "$source_root" rev-parse --verify --quiet "${base}^{commit}" >/dev/null \
      || fail "基准引用无法解析为提交：$base"
    ;;
  detached)
    [[ -n "$base" ]] || fail "--detach 模式必须提供 --base"
    branch=""
    git -C "$source_root" rev-parse --verify --quiet "${base}^{commit}" >/dev/null \
      || fail "基准引用无法解析为提交：$base"
    ;;
esac

pi_agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
# 与 core.ts 对齐：支持字面 ~ 与 ~/...，其余必须是绝对路径。
case "$pi_agent_dir" in
  "~") pi_agent_dir="$HOME" ;;
  "~/"*) pi_agent_dir="$HOME/${pi_agent_dir#"~/"}" ;;
esac
[[ "$pi_agent_dir" == /* ]] || fail "PI_CODING_AGENT_DIR 必须是绝对路径：$pi_agent_dir"
# 工作树根目录与 agent 目录同级（默认 ~/.pi/worktrees）。
worktree_root="$(dirname "$pi_agent_dir")/worktrees"
mkdir -p "$worktree_root"
worktree_root="$(cd "$worktree_root" && pwd -P)"
target="$worktree_root/$name"
[[ ! -e "$target" && ! -L "$target" ]] || fail "目标路径已经存在：$target"
setup_script="$source_root/.pi/worktree/setup.sh"
setup_hook_expected="false"

verify_setup_hook() {
  [[ -f "$setup_script" ]] || fail "项目工作树钩子不是普通文件：$setup_script"
  [[ -n "$approved_setup_hook_blob" ]] \
    || fail "项目存在工作树钩子，必须先审查并传入 --approve-setup-hook <blob-id>：$setup_script"
  local current_blob
  current_blob="$(git hash-object "$setup_script")" \
    || fail "无法计算项目工作树钩子内容标识：$setup_script"
  [[ "$current_blob" == "$approved_setup_hook_blob" ]] \
    || fail "项目工作树钩子在批准后发生变化，拒绝执行：$setup_script"
}

if [[ -e "$setup_script" || -L "$setup_script" ]]; then
  verify_setup_hook
  setup_hook_expected="true"
fi

run_setup() {
  local phase="$1"
  local working_dir="$2"

  verify_setup_hook
  printf '执行已批准的项目工作树钩子：%s (%s)\n' "$setup_script" "$phase"
  (
    cd "$working_dir"
    export PI_WORKTREE_PHASE="$phase"
    export PI_WORKTREE_SOURCE_ROOT="$source_root"
    export PI_WORKTREE_TARGET="$target"
    export PI_WORKTREE_BASE="$base"
    export PI_WORKTREE_BRANCH="$branch"
    export PI_WORKTREE_NAME="$name"
    export PI_WORKTREE_MODE="$mode"
    # 钩子契约禁止输出敏感信息；扩展入口仍不转发钩子输出。
    bash "$setup_script" "$phase"
  )
}

# 在 Git linked-worktree 管理目录写入专属所有权标记（非工作区），供扩展严格判定来源。
write_ownership_marker() {
  local target_git_dir target_common_dir created_at
  target_git_dir="$(git -C "$target" rev-parse --absolute-git-dir)" || return 1
  target_common_dir="$(git -C "$target" rev-parse --path-format=absolute --git-common-dir)" || return 1
  [[ -n "$target_git_dir" && -n "$target_common_dir" ]] || return 1
  # 主工作区的 git-dir 与 common-dir 相同，标记只能写入 linked worktree 管理目录。
  [[ "$target_git_dir" != "$target_common_dir" ]] || return 1
  created_at="$(node -e 'process.stdout.write(new Date().toISOString())')" || return 1
  [[ -n "$created_at" ]] || return 1
  printf '{"schemaVersion":1,"createdAt":"%s"}\n' "$created_at" >"$target_git_dir/pi-worktree-manager.json" || return 1
}

if [[ "$setup_hook_expected" == "true" ]]; then
  write_state "before-create"
  if ! run_setup "before-create" "$source_root"; then
    fail "项目 before-create 钩子失败，尚未创建工作树"
  fi
else
  printf '项目未提供 .pi/worktree/setup.sh，跳过项目初始化钩子。\n'
fi

write_state "git-add"
printf '创建工作树：%s\n' "$target"
case "$mode" in
  new-branch)
    git -C "$source_root" worktree add -b "$branch" "$target" "$base"
    ;;
  existing-branch)
    git -C "$source_root" worktree add "$target" "$branch"
    ;;
  detached)
    git -C "$source_root" worktree add --detach "$target" "$base"
    ;;
esac

# git worktree add 成功后、项目 after-create 钩子前写标记；
# 标记失败时保留工作树并停留在 ownership 阶段，由扩展如实归类失败。
write_state "ownership"
if ! write_ownership_marker; then
  printf '错误：无法写入 Pi 工作树所有权标记。工作树已保留用于诊断：%s\n' "$target" >&2
  exit 1
fi

if [[ "$setup_hook_expected" == "true" ]]; then
  write_state "after-create"
  if ! run_setup "after-create" "$target"; then
    printf '错误：项目 after-create 钩子失败。工作树已保留用于诊断：%s\n' "$target" >&2
    exit 1
  fi
fi

write_state "completed"
printf '工作树已就绪：%s\n' "$target"
