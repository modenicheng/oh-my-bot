# 计划：CI/CD 与版本发布流水线

状态：实现完成。本地集成验证已通过：golangci-lint v2.14.0 为 0 issues，CI 命令全绿，五平台交叉构建、5 个归档、SHA256SUMS 与版本/healthz smoke 均通过；GitHub Actions 与真实 Release 上传由推送后的远端运行继续验证。
范围：CI（lint/test）、语义化版本注入、release-please 自动发版 PR、tag 驱动多平台构建发布、依赖更新。
不涉及：容器/GHCR、ESLint、Playwright 新基建、公网加固。

外部行为均按当前官方文档与源码核实（release-please-action v5 `action.yml`、release-please `manifest.ts`/`versioning-strategies/prerelease.ts`/`strategies/simple.ts`/CLI 17.11.2 `src/bin/release-please.ts`、golangci-lint v2 JSON schema、golangci-lint-action v9 README）。

## 0. 实施边界

- 不创建或移动 tag，不自动合并 Release Please PR，不写任何凭据。
- `pnpm-lock.yaml` 保持不变；安装统一使用 `pnpm install --frozen-lockfile`。
- Go 存量 lint 修复保持机械、语义等价，不改变业务规则。
- 不引入容器/GHCR、ESLint、Playwright 新基建或公网加固。

## 1. 版本注入与查询（单一版本源 = 二进制）

- `server/cmd/omb/main.go`：
  - `var version = "dev"`；release 构建用 `-ldflags '-X main.version=<tag>'` 注入。
  - `-version` flag：打印版本后立即退出，不监听端口、不初始化 hub。
  - 启动日志带版本：`oh-my-bot <version> listening on ...`。
  - 只读 `GET /api/version` → `{"version":"..."}`；非 GET 返回 405 并带 `Allow: GET`；`Cache-Control: no-store`。
- 前端页脚：
  - `client/index.html`：`#view-join` 底部 `<p id="app-version">dev</p>`。
  - 新增 `client/src/version.ts`：`initAppVersion()` 启动时异步 fetch `/api/version`，**不 await、不阻塞** startup 手势解锁与 `prepare()` 音频路径；成功写 `v<version>`（version 已带 `v` 前缀则不重复），失败/异常 payload 静默保持 `dev`。
  - `client/src/app.css` 末尾小段低调小字样式。
  - `client/src/startup.ts` 仅加一行 fire-and-forget 调用；手势解锁音频逻辑零改动。
- 测试：`server/cmd/omb/version_test.go`（GET-only、JSON 形状、ldflags 注入点=同名包级变量）；`client/src/version.test.ts`（label 解析与静默 fallback）。`-version` 不绑端口用真实进程验证（见 §8）。

## 2. Go 静态检查（golangci-lint v2）

- 新增 `.golangci.yml`，v2 格式（`version: "2"`）：
  - `linters.default: standard`（errcheck、go vet、ineffassign、staticcheck、unused）+ `enable: [misspell]`。
  - `formatters: gofmt + goimports`，`goimports.local-prefixes: [github.com/modenicheng/oh-my-bot]`。
- 草稿基线的存量告警已清零：按窄修处理（机械 `_ =`/defer 包装、gofmt/goimports 格式化、unused `rotateK` 删除、QF1001/ST1023/SA4000/ineffassign 语义等价改写、ST1005 报错文案），legacy replay 弃用字段（SA1019×7）用行内 `//nolint:staticcheck` + 中文理由局部豁免，未关任何规则。涉及 ai/listen/netws/stats/snapshot/glue/room/sim/mapgen 的生产与测试文件；未触碰 558 控制代码重写区。

## 3. CI 工作流（.github/workflows/ci.yml）

- 触发：push main、全部 PR、workflow_dispatch；`concurrency` 按 ref 取消旧运行。
- `go` job（ubuntu-latest）：checkout → setup-go（`go-version-file: go.mod`）→ golangci-lint-action v9 → 完整 `go test -timeout 10m ./...` → `go test -race -short -timeout 10m ./...`。严格 5/12ms 性能门和依赖生产脚本墙钟配额的集成测试仅在非 race 全量步骤运行；64 runtime 并发 race harness 使用放宽测试配额，继续覆盖数据竞争。
- `web` job：pnpm/action-setup（读 `packageManager`）→ setup-node 22（cache pnpm）→ `pnpm install --frozen-lockfile` → 根 `pnpm typecheck`（显式过滤 packages + client，避免根脚本递归）→ `pnpm test`（vitest run，不含 Playwright e2e）。
- `package.json` 补 `"test": "vitest run"`（vitest 已是 root devDependency，锁文件不动）。
- 权限最小：顶层 `permissions: contents: read`。
- action 版本按发布 API 实查固定大版本（checkout/setup-*/artifact/pnpm-setup/golangci-lint-action），不凭记忆。

## 4. 自动发版（release-please）

已核实的真实行为（本计划的机制基础）：

- release-please-action 没有 `prerelease` 输入；它虽暴露 `release-as`，但 manifest 模式存在官方 issue #1220 的静默忽略问题，因此手动指定版本仍走 CLI。
- manifest 模式（给 config-file + manifest-file、不给 release-type）读 `release-please-config.json` + `.release-please-manifest.json`；CLI `release-pr` 的 `--release-as` 透传到 `Manifest.fromManifest(..., releaseAs)`，可产出指定版本（如高于现有基线的 `v0.2.0-rc.1`）的 release PR，merge 后 tag 亦为该版本。
- config `prerelease: true` 的语义（`manifest.ts`）：GitHub release 满足 `version 有预发布段 || major === 0` 时标记为 prerelease。对 0.x 项目即：所有 0.x 与 rc 的 release 都是 prerelease，进 1.0.0 后自动转正。
- `simple` 策略显式设 `version-file: VERSION`，只维护现有 VERSION，不尝试更新默认的 version.txt；manifest 初值 `0.1.0`。
- 已知约束（GitHub 官方文档）：**GITHUB_TOKEN 触发的事件不会再触发其他 workflow**。release-please 用默认 token merge 出的 tag 不会自动跑 release.yml。两条真实路径：
  1. 配置 fine-grained PAT（Contents、Pull requests 和 Issues 均为 read/write）为 secret `RELEASE_PLEASE_TOKEN`，workflow 里 `secrets.RELEASE_PLEASE_TOKEN || github.token` 兜底，全自动；
  2. 不配 PAT 时，merge release PR 后 GitHub release/tag 已由 release-please 创建，产物构建用 release.yml 的 `workflow_dispatch`（tag 必填）手动补跑。
- 文件：
  - `release-please.yml`：push main 自动 + workflow_dispatch（仅允许从 main 运行；`release_as` 非空走 CLI `release-pr --release-as`，严格 SemVer 且必须高于最新 tag，空则与 push 等价跑常规 action）；权限 `contents: write` + `pull-requests: write`；含 checkout；fork PR 不进本工作流，无 secret 暴露面。
  - `release-please-config.json`：根包 `simple` + `version-file: VERSION` + `prerelease: true` + `prerelease-type: rc` + `include-component-in-tag: false`（单包、纯 `vX.Y.Z` tag）。
  - `.release-please-manifest.json`：`{ ".": "0.1.0" }`；`VERSION`：`0.1.0`；`CHANGELOG.md` 初始占位（首个 release PR 可能回溯全部历史提交，changelog 在该 PR 内人工润色）。
- 人工 rc 流程：仓库已有 `v0.1.0` 基线，因此从更高版本开始，例如 workflow_dispatch 填 `release_as=v0.2.0-rc.1` → 得 release PR（VERSION=0.2.0-rc.1）→ merge → 对应 prerelease tag/release。后续 RC 或无后缀版本均显式填写目标版本；工作流拒绝不高于最新 tag 的版本。当前默认版本策略未启用 `versioning: prerelease`，`prerelease-type: rc` 本身不是自动递增策略。

## 5. 发布构建（.github/workflows/release.yml）

- 触发：push tag `v*` + workflow_dispatch（**tag 必填**，resolve job 严格 `vX.Y.Z[-pre]` 校验并验证远端 tag 存在，输出 tag+commit；绝不以 main 分支头当版本）。
- `build-web`：pnpm frozen-lockfile + 根 `pnpm build`（workspace typecheck + client build），上传 `web-dist` artifact（所有平台共用同一 embed 内容）。
- `build-binaries`（needs build-web）：matrix linux/amd64、linux/arm64、windows/amd64、darwin/amd64、darwin/arm64；按 build.sh 语义暂存 embed（`client/dist→server/cmd/omb/web`、`docs/manual→server/cmd/omb/manual`，含 .gitkeep）→ `CGO_ENABLED=0 GOOS/GOARCH=… go build -trimpath -ldflags '-X main.version=<tag>'`；命名 `omb-<version>-<os>-<arch>.tar.gz`，windows 为 `.zip`（内含 `omb.exe`）。
- smoke（linux/amd64 leg 内）：`./omb -version` 输出严格等于 tag；`./omb -addr 127.0.0.1:18099 &` 后 curl `/healthz` 200，trap 清理 PID。
- `gather`：下载全部平台 artifact，逐一校验 5 个平台归档存在（4 tar.gz + 1 zip），缺任何一个直接失败；随后在产物目录内生成 `SHA256SUMS`（行内路径即文件名）。
- `resolve` 额外要求 tag commit 中的 `VERSION` 与 tag 去掉 `v` 后一致；历史 `v0.1.0` 早于版本链路，会快速失败并提示创建新版本 tag。
- `publish`（needs resolve/gather，含手动 dispatch）：`gh release view` 已存在则 `gh release upload --clobber`（兼容 release-please 预创建的 release），否则 `gh release create --generate-notes`；0.x 或带预发布后缀的 tag 自动加 `--prerelease`，权限仅 `contents: write`。
- artifact 名全局唯一（`web-dist` / `omb-<os>-<arch>` / `release-assets`），上传/下载严格 needs 串行。

## 6. 依赖更新（.github/dependabot.yml）

- `github-actions`（directory `/`）、`gomod`（`/`，根 go.mod）、`npm`（`/`，pnpm workspace lock），全部 weekly。

## 7. 文档

- `docs/deploy.md` 增 CI/CD 发版章节：工作流一览、正式/rc 发版步骤、Releases 下载与 SHA256 校验、`-version` / `GET /api/version` / 首页页脚三种查询方式、GITHUB_TOKEN 限制与两条真实路径、已知限制。
- `README.md` 加一行发版/下载入口。
- 不声称已部署/已推送/Actions 已绿；未本地验证的自动晋级行为如实列为限制。

## 8. 本地验证清单（真实执行，不做远程操作）

1. `pnpm install --frozen-lockfile`（锁文件零改动）。
2. `gofmt -l`、`go vet ./...`、`go test ./...`（含新 version_test.go）。
3. `go run ./server/cmd/omb -version` → `dev` 且进程即退；`go build -ldflags '-X main.version=v0.2.0-rc.1'` 后 `-version` → `v0.2.0-rc.1`，起服 `GET /api/version` JSON 匹配、POST 405。
4. `pnpm typecheck`、`pnpm test`（含 version.test.ts）、`pnpm --filter client build` 后 dev 页脚确认。
5. 草稿工作树 `golangci-lint run` = 0 issues（v2.14.0，存量告警窄修后清零，见 §2）；合入最新功能后需再做一次集成 lint。
6. GitHub Actions、release PR 自动晋级与 GitHub Release 上传由推送后的远端演练确认；五平台交叉编译与本地打包已在当前集成工作树验证。

## 9. 新增/修改文件清单

新增：`docs/plans/ci-cd-release.md`、`.golangci.yml`、`.github/workflows/ci.yml`、`.github/workflows/release-please.yml`、`.github/workflows/release.yml`、`.github/dependabot.yml`、`release-please-config.json`、`.release-please-manifest.json`、`VERSION`、`CHANGELOG.md`、`client/src/version.ts`、`client/src/version.test.ts`、`server/cmd/omb/version_test.go`。
修改（小段插入）：`server/cmd/omb/main.go`、`package.json`、`build.sh`、`client/index.html`、`client/src/startup.ts`、`client/src/app.css`、`docs/deploy.md`、`README.md`；另对 Go 生产/测试文件做必要的机械 lint 修复与 gofmt（含后合并的 `server/cmd/omb/manual_image_test.go`）。
