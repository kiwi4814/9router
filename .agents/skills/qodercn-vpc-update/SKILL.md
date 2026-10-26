---
name: qodercn-vpc-update
description: 更新本项目的上游代码、npm 全局 QoderCN CLI 和 VPC 模型数据，评估兼容性并进行低成本真实验收。
disable-model-invocation: true
---

# QoderCN VPC 更新

用户显式调用本 Skill 时执行整条维护流程；用户指定只检查/只更新某项时遵从该范围。本部署只关心 QoderCN CN VPC 反代链路与 VPC 可用性：非 Qoder 提供商/功能的变化只做兼容性核对，不列为验收目标，也不为它们的既有红项负责。安装渠道保持 npm 全局包 `@qodercn-ai/qoderclicn`，保留现有国内镜像、VPC 配置和本地凭据。每次记录基线与实际结果，不把此前故障恢复步骤当作正常更新步骤。

## 1. 基线与目标

- 读取项目上下文；改 `open-sse/` 前读取 `open-sse/AGENTS.md`。
- 记录当前分支、HEAD、工作区与暂存区、upstream URL、应用/CLI 版本和 CLI 入口实际目标。存在用户修改时保留；重叠修改先解决隔离方式，不自动 stash/reset。
- 用 `npm prefix -g`、`npm root -g`、`npm config get registry` 定位实际全局安装。检查 shell 中 `qodercn`/`qoderclicn` 是否被旧路径或 dispatcher 遮蔽。
- 从 npm 获取目标版本与包元数据：

```bash
npm view @qodercn-ai/qoderclicn dist-tags --json --fetch-retries=0 --fetch-timeout=10000
npm view @qodercn-ai/qoderclicn@<target> version engines dist --json --fetch-retries=0 --fetch-timeout=10000
```

- 检查实际 9Router 启动配置/服务管理器，确认端口、运行目录、构建来源、QODER 网络 origin 的**来源**。`qoder` 加 VPC origin 可以是自用部署；不能看到 CN 就自动迁移成 `qoder-cn`。
- 凭据仅在进程内读取和使用。数据库、CLI auth 文件、环境变量与模型配置含敏感信息；只输出筛选后的版本、域名、模型、状态，禁止输出 token、Authorization、完整 connection/config 或带凭据的命令。

完成条件：旧版本/旧提交、更新目标、安装渠道、VPC 配置来源与新代码验证路径均已确定。

## 2. 发布变化与兼容性评估

联网检索新发布线索，再读取一手来源；使用 npm 元数据与实际 CLI `--help` 交叉验证：

- 国内官方日志：https://docs.qoder.cn/product-overview/qoder-cn-cli
- npm 包：https://www.npmjs.com/package/@qodercn-ai/qoderclicn
- 国际日志只作旁证，不当作 CN 同版本的发布记录。

覆盖旧版到目标版之间的已发布记录。逐项分成：客户端 UI/工具/权限变化；模型及默认参数变化；认证、VPC endpoint、签名/编码、请求体、SSE、usage/错误协议变化。后两类与本项目相关代码对照：`shared/qoder/`、`services/qoderModels.js`、`services/qoderModelMeta.js`、`executors/qoder.js`、`services/usage/misc.js`、`src/app/api/v1/models/route.js` 与模型生成脚本。

官方日志落后于包版本时明确写“目标版本发布说明未公开/未找到”；区分本地 help 观察与 release-note 事实。仅因 CLI 版本更新不盲目更改 COSY 版本或签名字段。有契约变化证据才实施必要适配。

完成条件：每项相关变化有来源、影响判断与验收路径；未知部分显式列出。

## 3. 同步上游代码

```bash
git fetch upstream
git log HEAD..upstream/master --oneline
git diff HEAD...upstream/master --stat
git merge --no-commit upstream/master
```

先确认远端默认分支；若不是 master 使用实际分支。对照 incoming 改动与自用补丁，重点保留 VPC origin 覆盖、live slug 与同一 catalog 的路由身份、倍率/能力透传、参数映射、队列重试，并纳入上游真正的修复。冲突按双方意图合并，不整文件选 ours/theirs。检查自动合并也可能留下的问题，尤其 try/catch/finally、签名重放保护和 intl/CN 分流。

后续验证通过后再完成 merge commit；用户未授权提交时保持可检查的未提交合并状态并明确说明。已有合并且上游无新提交时不重复合并。push、生产部署、破坏性恢复需独立授权。

## 4. 更新 CLI

CLI 已达目标且入口正常时只验证，跳过重装。否则按 npm 元数据确定具体目标版本，备份旧包及必要入口用于回退（不复制 auth），保持 registry 配置不变：

```bash
npm install -g @qodercn-ai/qoderclicn@<target> \
  --include=optional --ignore-scripts --fetch-retries=0 --fetch-timeout=10000
npm rebuild -g @qodercn-ai/qoderclicn --foreground-scripts
qodercn --version
qoderclicn --version
qodercn --help
```

固定目标版可使包元数据、备份与安装可核对；无需固定版本时也可用 `npm update -g @qodercn-ai/qoderclicn` 加相同参数。`--ignore-scripts` 后的 rebuild 是必需步骤。

只有 EEXIST、悬空链接、超时或包损坏时，读取 [references/npm-recovery.md](references/npm-recovery.md) 执行对应恢复分支。避免 --force 覆盖不明入口。

完成条件：两个命令指向预期安装，版本为目标版，help 正常，VPC 配置保持原值。

## 5. 同步 VPC 数据并比较

- 更新前保存脱敏的 `/v1/models` 与 CLI 模型目录快照（本轮可用旧服务/已存在本地缓存作为基线，但注明时间与来源）。
- 更新后运行 `qoderclicn --list-models`，并用本项目 `resolveQoderModels(credentials, { forceRefresh: true })` 拉取 live catalog。启动环境从实际服务配置读取，不把 VPC 域名/凭据写入仓库。
- 对比每个 internal key 的增删、display name/public slug、price_factor/original_price_factor、enable、VL/reasoning、努力度与默认档位、context_config/默认和最大窗口、输出上限。缺失字段记为未知，不推断为 0 或 unsupported。
- 验证 9Router `/v1/models` 与当前 catalog 一致；缓存 TTL 可能使旧服务返回旧数据，使用新进程/明确刷新机制。修改源文件不会使已运行的生产构建自动更新。
- 模型以 live catalog 为准，避免把组织专属目录覆盖到国际/公共 CN 静态 registry。涉及字段兼容变化时修正共享解析并验证。
- 存在本机 `~/.9router/scripts/sync-omp-models.sh` 时，检查其目标和行为后执行；否则使用 `scripts/qoder/gen-omp-models.mjs` 生成块并更新现有客户端对应 provider，保留其他 provider 配置。无该客户端时标记不适用。
- Qoder Credits 倍率与供应商 API USD/百万 token 不是同一计费单位。保留二者区别；未知供应商价格不伪造为免费。

完成条件：新 catalog 与网关/适用客户端一致，所有可比较的模型变化都有结果；无旧快照时说明不能追溯变化，不伪造 diff。

## 6. 构建与运行服务切换

源码更新、CLI 更新、运行服务更新分别验收。生产 Next.js 服务仍使用旧构建时，git pull/merge/push 和更新 QoderCN CLI 都不会更新网页版本。

1. 核对 `package.json` 的目标版本、实际启动入口、构建目录和服务管理器。读取 `/api/version` 的实现，明确侧栏当前版本来自应用构建，latest 来自官方 npm 包；这不是 QoderCN CLI 的版本比较。
2. 仓库/VPC 自用部署使用项目构建命令，不点网页的官方全局 npm 更新按钮，也不执行 `npm i -g 9router@latest` 替换自用版本。版本号按真实代码更新，不能通过改标签或隐藏提示掩盖旧构建。
3. 在生产构建前检查依赖与构建脚本，保留旧构建、启动配置和回退点（仓库外、仅本机）。优先隔离构建，验证后切换；若必须覆盖正在运行的 `.next`，告知短暂停机，停服务后构建。构建失败恢复旧构建并重新启动原服务，不能让服务停留在半更新状态。
4. 构建成功后，使用实际服务管理器切换/重启；保留原端口、VPC 环境、数据目录和安全启动包装器 `custom-server.js`。macOS LaunchAgent 使用实际发现的 label/plist，其他环境按自身管理器操作；项目文档中只保留通用步骤，不写本机私密配置。
5. 等待服务就绪，在**实际对外端口**校验 `/api/version.currentVersion == package.json.version`，再用新浏览器页面/刷新页面验证侧栏版本和更新提示。latest 大于当前目标时仍有提示可能是正常现象；latest 获取失败/null 不是“已追上最新版本”的证据。

完成条件：新服务运行版本与本轮源码目标一致，网页实际显示正确，且下一节的新服务 VPC 冒烟通过。没有切换授权时明确标为“仅源码更新，运行服务未更新”；不能将全流程记为完成。

## 7. 验收与收尾

从 live **启用**模型中选最小已知非负 priceFactor；并列选支持关闭思考或低努力度的模型。只做短请求，限制输出、超时和重试。

1. 官方 CLI：根据当前 `--help` 支持的选项，在临时空目录运行：

```bash
qoderclicn -p --model <live-display-name> --thinking disabled \
  --tools "" --strict-mcp-config --no-session-persistence \
  --max-output-tokens 64 --max-model-request-retries 0 '只回复 CLI_SMOKE_OK'
```

模型不允许禁用思考时省略该选项，使用其最低支持档位。观察实际正文，版本/help/目录成功不等于推理成功。

2. **当前代码与新服务**：运行源码 executor 的短请求，记录所选 slug、实际发送的 model_config.key、HTTP 状态、完整 SSE 正文与结束标志。服务切换前可先在隔离端口验证；切换后必须在实际服务端口验收 `/v1/models`、非流式与完整流式 `/v1/chat/completions`。认证信息在进程内注入，不能出现在 argv 或日志。只测旧服务或只测源码不足以证明部署成功。
3. 使用现有测试包验证 Qoder 路径：默认 `cd tests && npm test` 只跑 `unit/qoder*`；涉及组合回退时跑 `npm run test:qoder-path`。合并上游后跑 `npm run test:all` 并用 `tests/__baseline__/known-fails.txt` 判断既有红项，非 Qoder 失败不得当作本轮回归，也不得写成测试通过。缺依赖先安装 tests 声明依赖，不把启动失败写成测试通过。测试发现回归先修复。
4. SSE 必须消费到终止，验证实际文本、finish/usage（上游提供时）及错误；禁止用截取前几行当通过。响应 model 为 auto 不能证明选定模型被正确计费，要以发出的 key/config 作为路由证据，账单需独立证据。
5. 必要适配完成后更新 CHANGELOG，清理本轮临时包/快照/服务；保留可用回退备份及用户原始配置。验证通过后按授权完成合并提交。

## 汇总格式

- 代码与部署：旧 HEAD → 新 HEAD/上游目标、冲突文件与保留的自用行为、提交/推送状态；源码版本 → 实际服务版本、网页显示与提示状态、是否切换及回退点。
- CLI：旧版 → 新版、镜像/安装方式、是否恢复入口；官方功能变化及代码影响，链接来源，缺失的目标版说明。
- 模型：增删/更名/倍率/窗口/能力/默认值的变化表；无变化明确说无变化；基线缺失说明不能判断历史变化。
- 验证：CLI、新源码、新服务各自证据；最低倍率、所选模型、发送 key、正文、流结束与测试结果。
- 风险：未验证契约、旧构建仍运行、缺失凭据/价格说明；剩余可执行事项继续处理，不能把失败标为完成。
