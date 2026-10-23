# 参与贡献

感谢你关注 pi-extensions。本文说明如何反馈问题和提交改动；开发命令见 [README](README.md#development)，协作与验证约定见 [AGENTS.md](AGENTS.md)。

## 反馈问题

- Bug 与功能建议请通过 [Issue 模板](https://github.com/yefengr/pi-extensions/issues/new/choose)提交。
- 安全漏洞不要公开提交，请按[安全策略](SECURITY.md)使用私密漏洞报告。
- 不要在 issue、日志或截图中附带 token、私钥、会话内容或其他敏感数据。

## 提交改动

1. 较大的改动先开 issue 讨论方向；新增包或修改公开命令、工具、事件命名前，先核对 README 的包职责与分层命名规则。
2. 从 `main` 创建分支，行为变更需要附带自动化测试。扩展界面的组件选型、交互和验收要求见 [TUI 规范](docs/reference/tui-guidelines.md)。
3. 提交前运行受影响的验证命令和 `git diff --check`；改动文档时运行 `npm run check:docs`。仓库根目录的 `npm run verify` 覆盖类型检查、lint、全部测试、文档链接和打包内容检查。
4. 提交 Pull Request，按模板填写摘要与验证结果。CI 的 `verify` 检查通过后由维护者合并。
5. 发布由维护者执行，贡献者不需要修改版本号或创建标签。

贡献的代码按 [MIT 许可证](LICENSE)发布；`packages/pi-subagents` 保留上游版权声明，详见 LICENSE。
