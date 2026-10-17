# 多阶段构建：web(client/dist) → go embed 暂存 + 交叉编译 → distroless 运行时。
# 产物链与 build.sh / .github/workflows/release.yml 完全一致（web/manual 内嵌）。
# 本地可用 podman build 验证：cache mounts 与自动平台 ARG 均为 Buildah 原生支持，
# 不依赖 BuildKit 外部 frontend（syntax 指令对 podman 是 no-op）。
# syntax=docker/dockerfile:1

ARG GO_VERSION=1.26
ARG NODE_VERSION=22

# ---- web：构建 client/dist（JS 产物与架构无关，只在构建平台跑）----
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION} AS web
WORKDIR /src

# 先只取清单文件：依赖安装独立成层，源码变更不重跑 pnpm install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY client/package.json client/
COPY packages/bot-api/package.json packages/bot-api/
COPY packages/protocol/package.json packages/protocol/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    corepack enable && pnpm install --frozen-lockfile

COPY client/ client/
COPY packages/ packages/
RUN pnpm build

# ---- go：embed 暂存 + 交叉编译（双架构无需 QEMU）----
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION} AS build
# TARGETOS/TARGETARCH 由构建器按目标平台注入；单平台构建时为空 = 原生编译
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
WORKDIR /src

COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY server/ server/
# 与 build.sh 相同的 embed 暂存：web 为构建产物，manual 直接复制整目录（含 legalassets）
COPY --from=web /src/client/dist server/cmd/omb/web/
COPY docs/manual server/cmd/omb/manual/

# 非 root 可写的空目录，拷到运行阶段作 /app/data（server 以 cwd 相对路径写 data/matches）
RUN mkdir -p /out/empty
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" \
    go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/omb ./server/cmd/omb

# ---- 运行时：distroless static（与 docs/deploy.md 示例一致）----
FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/omb /omb
# /app 由 WORKDIR 创建时归 root，nonroot 写不了日志目录；这里预置可写的 data 挂载点
COPY --from=build --chown=65532:65532 /out/empty /app/data
WORKDIR /app
# 容器内必须绑全网卡：镜像默认 127.0.0.1 是容器自己的回环，-p 发布不进去（ADR-0014）
ENV OMB_ADDR=:27182
# 大房默认（见 docs/deploy.md「房间席位上限」）：单房席位 200 + GC 调优。
# 两者均已是代码内置默认（席位 room.MaxPlayers、GC ai.GCPercentDefault），
# ENV 只是把值显式摆在明面便于 docker run -e 覆盖——
# docker run -e OMB_MAX_PLAYERS=64 即回退小房，-e OMB_GC_PERCENT=100 回退标准 GC。
# GOGC=400 为压测结论：200 人房 tick 墙钟减半，代价是堆峰值变高
# （容器建议内存 ≥2GiB，紧可加 OMB_GC_MEMORY_LIMIT 兜底）。
ENV OMB_MAX_PLAYERS=200
ENV OMB_GC_PERCENT=400
EXPOSE 27182
USER nonroot:nonroot
ENTRYPOINT ["/omb"]
