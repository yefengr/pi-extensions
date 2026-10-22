# pi-extensions

[yefengr](https://github.com/yefengr) 维护的 [Pi](https://pi.dev) 扩展集合。每个包都是独立的 npm package，可单独安装。

## 包

| 包 | 说明 | 状态 |
|---|---|---|
| [`@yefengr/pi-notify`](./packages/pi-notify) | 通过终端原生 OSC 协议发送桌面通知，不依赖系统通知 Helper | 首发 |
| [`@yefengr/pi-monitor`](./packages/pi-monitor) | 通用后台命令监听：一次性或持续事件，仅通知或自动解释 | 首发 |
| [`@yefengr/pi-subagents`](./packages/pi-subagents) | 进程内子代理运行时：前后台执行、转向、恢复、会话查看与生命周期事件 | 已迁入，未发布 |
| [`@yefengr/pi-task-efficiency`](./packages/pi-task-efficiency) | 任务效率复盘：范围确认、确定性指标与改进建议 | 已迁入，未发布 |

## 安装

需要 Pi 1.x 与 Node.js >= 22.19.0。

```bash
pi install npm:@yefengr/pi-monitor
pi install npm:@yefengr/pi-notify
```

安装后运行 `/reload` 或重启 Pi。卸载：

```bash
pi remove npm:@yefengr/pi-monitor
```

## 开发

```bash
npm install
npm run typecheck
npm test
```

单包验证：

```bash
npm test -w @yefengr/pi-monitor
npm run typecheck -w @yefengr/pi-notify
```

发布前检查 tarball 内容：

```bash
npm pack --dry-run -w @yefengr/pi-notify
```

## 发布

发布使用手动语义化版本与 GitHub Actions npm Trusted Publishing（OIDC），不保存长期 token。首个版本需要在具备 npm 登录的机器上发布，此后在 npm 包设置中绑定本仓库的 `release.yml` 工作流。

## 许可证

除 [`packages/pi-subagents`](./packages/pi-subagents) 保留上游 `tintinweb` 的 MIT 版权声明外，本仓库采用 MIT 许可证，见 [LICENSE](./LICENSE)。
