# 安全策略

本仓库维护四个运行在用户本机 Pi 进程中的扩展：`@yefengr/pi-notify`、`@yefengr/pi-monitor`、`@yefengr/pi-task-efficiency` 和 `@yefengr/pi-subagents`。它们与 Pi 共享用户权限，安全问题可能影响用户的本机环境或会话数据，请私下报告，不要公开披露。

## 报告漏洞

请通过 GitHub 的私密漏洞报告提交：打开仓库的 [Security](https://github.com/yefengr/pi-extensions/security) 页面，点击 **Report a vulnerability**，或直接打开[提交表单](https://github.com/yefengr/pi-extensions/security/advisories/new)。报告只有维护者可见。

不要在公开 issue、讨论区或 Pull Request 中披露漏洞细节。

报告中请尽量说明：

- 受影响的包与版本，以及 Pi、Node 和终端的版本；
- 复现步骤与实际影响；
- 可行的修复思路（如有）。

报告中不要附带真实的 token、私钥、会话内容或他人的数据；需要示例时请使用测试数据。

## 处理流程

- 维护者会尽快确认收到报告，并与你私下沟通修复方案和披露时间。
- 修复发布后，会通过 GitHub Security Advisory 公开说明。

## 范围

在范围内：

- 本仓库四个 npm 包的代码、构建脚本和发布流程；
- 命令注入、路径穿越、权限绕过，以及把会话内容、凭据或环境变量写入日志、通知或报告的问题；
- 发布产物与源码不一致，或发布流程可被未授权触发的问题。

以下属于已知的设计边界，不视为漏洞：

- 扩展不是沙箱：`pi-monitor` 会执行用户或模型给出的命令，`pi-subagents` 的子代理拥有 Pi 授予的工具权限；
- Pi 进程、终端或操作系统本身被攻陷后的风险；
- 用户主动安装并运行的第三方扩展或模型服务。

## 支持的版本

只维护 npm 上最新的正式版本。旧版本不单独修复，请先升级到最新版本再复现。
