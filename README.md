# WB 与 Ozon 选品评审台

面向选品评审、利润核算和上架准备协作的本地应用源码，采用 [MIT 许可证](LICENSE)。前端使用 React/Vite，服务端使用 Node.js；业务模型、数据校验和状态流位于 `selection-review-app/lib/`。

## 最新工程进度

[三色工作台健康与草稿安全验证](docs/current/三色工作台健康与草稿安全验证-2026-10-08.md)记录本轮修改、本机运行回归、云端检查及草稿安全限制；历史交接不代表当前代码或业务状态。

## 查看与参与修改

项目地址：[zhangdashuai1016-ui/wb-ozon-selection](https://github.com/zhangdashuai1016-ui/wb-ozon-selection)。公开后可直接浏览代码，无需申请查看权限。

1. 登录自己的 GitHub 账号，点击仓库右上角 **Fork**，建立自己的副本。
2. 在自己的副本里创建功能分支，修改代码或文档；提交说明写清问题、改动和验证结果。
3. 发起 Pull Request，目标选择本仓库的 `main`。
4. 由维护者审查、确认 CI 结果后合并。新贡献者的 CI 运行可能需要维护者批准。

Fork 和 MIT 许可不授予原仓库写权限。直接向原仓库推送需要维护者另行邀请为协作者；不要共享账号、密码或访问令牌。

## 贡献者开发检查

准备 Node.js 24 和 pnpm 11.19.0。在自己的 Fork 中修改时，克隆自己的仓库；只阅读代码可以直接克隆本仓库：

```bash
git clone https://github.com/zhangdashuai1016-ui/wb-ozon-selection.git
cd wb-ozon-selection/selection-review-app
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm test:ci
pnpm build
node --check server.mjs
```

依赖安装需要访问软件包仓库。上述纯测试、构建和语法检查不启动评审台服务；`pnpm test` 会包含临时服务测试，不是这里的默认检查入口。

GitHub CI 同时运行静态检查、纯测试、构建和隔离 API 测试。API 测试只在无外网、非 root、代码只读的独立容器内启动临时服务，并使用合成数据和假派发程序；`pnpm test:ci:api` 不应直接在本机运行。测试通过不等于真实店铺操作或业务验收完成。

## 数据与运行边界

- 本仓库不包含真实候选数据库、经营证据目录、商品素材目录或业务凭据；测试样例不代表当前平台事实。
- 克隆代码不会安装后台服务，也不是开箱即用的生产环境。应用仍有原维护者的个人路径与任务配置，使用前需要独立配置和审查。
- 不要直接运行个人 `.command`、后台启动或部署脚本，也不要为贡献代码而导入真实经营数据、连接真实店铺或开启付费调用。
- 平台操作必须使用运行者自己的合法账号与明确授权；开源代码不提供他人的平台权限、凭据或生产授权。这是运行安全说明，不是 MIT 许可证的附加使用限制。
- 提交前检查变更和文件清单，不要上传密码、Token、Cookie、环境文件或带密钥的链接。允许提交的 `.env.example` 及 `.env.*.example` 只能包含占位值；`.gitignore` 不能清除历史或保证没有秘密泄漏。

原维护者的本机配置与实现说明见 [应用 README](selection-review-app/README.md)；项目业务边界见 [项目规则](AGENTS.md)。

## 许可证

本项目按 [MIT License](LICENSE) 提供，允许使用、修改、分发和商用，须保留版权及许可证声明；软件不提供担保。第三方依赖仍遵循各自的许可证。
