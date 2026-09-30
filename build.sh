#!/usr/bin/env bash
# oh-my-bot 构建脚本：前端 + 手册 → embed → 单二进制
set -euo pipefail
cd "$(dirname "$0")"
pnpm -r typecheck
pnpm --filter client build
cd server/cmd/omb
rm -rf web manual
mkdir -p web manual
cp -r ../../../client/dist/* web/
cp -r ../../../docs/manual/* manual/
cd ../..
go build -o omb.exe ./cmd/omb
echo "BUILD OK: server/omb.exe"
