# 脚本运行时性能：分配根治与 GC 调优

日期：2026-10-03
状态：已接受
关联：ADR-0007 r2（60Hz 单时钟与脚本并行）、ADR-0004（服务端维护 Observation）

## 背景

64 脚本 60Hz 满载对局在 8 核内网目标机（bit-333，Xeon E3-1230V2）上出现
script deferred（顺延）与帧预算吃紧。perf 剖析（199Hz 采样 + Go pprof）
归因结论：

- **不是 A\***：`nav.Direction` 缓存命中 0 alloc、~20µs/64 查询；冷查
  （新起终点对首查）561µs/次，稳态对局不构成热点。
- **不是跨语言调用机制本身**：goja 原生函数调用开销远小于对象构建。
- **真瓶颈**：每 tick 重建 JS 观测对象的分配风暴 + GC。
  - 重载 64 脚本帧：124K allocs / 9.1MB / 帧；
  - CPU 时间 ~40% 花在 GC/分配（scanobject/mallocgc/setOwnStr 系）；
  - GOGC=100 下 GC assist 使 8 worker 只剩 4.3x 有效加速
    （串行 32ms → 并行 7.5ms）；
  - 每 tick ~20 个原生方法闭包被 `vm.ToValue` 重复包装成新 JS 函数对象。

## 决策

### D1：原生方法绑定跨 tick 缓存（vmBindings）

`context.go`：装载期（`loadLocked` 成功，即 Hot Swap 原子替换点）为每个
VM 创建一次全部原生方法（move/fire/scan/navigateTo…共 ~16 个），闭包
捕获 `*tickHooks`；每 tick 只切换 hooks 的 frame/cmd 字段。bot 壳、
self、game、scan() 返回值**仍每帧/每调用全新构建**——手册
data.md「生命周期」契约（「bot 每帧重建」「scan() 每次调用都给新对象」）
不变，有测试锁定（`bindings_test.go`）。

语义增强（顺带修复）：旧实现每 tick 新建函数，脚本跨 tick 持有旧方法
引用时调用会写入死收集器被静默丢弃；缓存后写入**当帧**收集器，行为
更符合直觉。方法对象身份跨 tick 稳定是新的实现契约（有测试锁定）。

### D2：scan() 数组批量构建

`observation.go`：robots/cores/uplinks/projectiles/healthPacks/walls
改走 `vm.NewArray(items...)` 批量初始化（一次分配 values 切片），
替代逐元素 `Set(strconv.Itoa(i), …)`（每次走 setOwnStr 哈希查找 +
字符串分配）。元素对象仍每调用全新（契约不变）。

### D3：GC 参数配置化（gc.*）

`config.yaml` 新增 `gc:` 段（env 覆盖：`OMB_GC_PERCENT` /
`OMB_GC_MEMORY_LIMIT`），main.go 在 hub 创建前应用：

```yaml
gc:
  percent: 400        # 等价 GOGC；0/缺省 = 不调整
  memory_limit: 1GiB  # 等价 GOMEMLIMIT 软上限，可选
```

依据：tick 级短命垃圾（每帧 ~9MB）放大触发间隔只影响峰值堆
（几百 MB 量级）；bit-333 实测 GOGC 400 使帧时 -34%、deferred
1.4%→0%。防御上限 `GCPercentMax=2000`。`config.example.yaml`
默认注释带推荐值 400。

## 实测（bit-333，E3-1230V2 8核 @3.3GHz，同一基准三组对照）

| 场景 | 基线 | 根治后 | 变化 |
|---|---|---|---|
| 空脚本 tick | 41.4µs / 201 allocs | 19.6µs / 73 allocs | -53% / -64% |
| scan() 一次 | +35µs / +146 allocs | +33µs / +144 allocs | 时间持平* |
| 重载脚本 tick | 170µs / 426 allocs | 140µs / 296 allocs | -18% / -31% |
| 64 脚本帧 @GOGC=100 | 7.50ms / 1.4% deferred | 7.82ms / 0% deferred | deferred 清零 |
| 64 脚本帧 @GOGC=400 | 4.96ms | 4.29ms | -13%（叠加 D1/D2） |
| 最佳组合（w32, GOGC=400） | — | **4.05ms** | 相对基线 **-46%** |

*scan() 元素对象仍需新建（契约要求），数组容器分配已省；单次 scan 的
净收益主要体现在 64 脚本整帧（allocs 124K→116K）与 GC 压力下降。

帧预算 12ms：修复前余量 4.5ms（62%），修复后余量 7.95ms（66%），
且最坏尾部（deferred/failed）归零——60Hz 稳定性显著改善。

## 后果

- 手册 docs/manual/reference/data.md 无需变更（对外契约未变；方法
  身份稳定属于实现细节，脚本不应依赖，但依赖它也不会跨 tick 出错）。
- Hot Swap 重建 VM 时 vmBindings 随候选 VM 整体重建，无跨 VM 借用
  （goja 禁止 Object 跨 Runtime）。
- `tickHooks.release()` 在 tick 结束清空帧引用，避免 64 个 runtime
  各持一份最后一帧 Observation 延迟回收。
- 后续若引入更多 L1 方法，直接加进 `newVMBindings`，勿在
  `buildTickContext` 内新建闭包。
- 未采纳方案：跨 tick 复用 scan 元素对象（违反手册「每次调用都给新
  对象」+ TestScanWallsNotSharedMutable 锁定）；goja freeze 共享墙
  （脚本可写属性需可变，freezer 语义与可写快照冲突）。

## 复现

```bash
# bit-333（GOPROXY=https://goproxy.cn,direct；perf 需
# sudo sysctl -w kernel.perf_event_paranoid=1，用完恢复 4）
go test -c ./server/internal/script/ -o omb.test
./omb.test -test.bench BenchmarkRunPool64Heavy -test.benchtime 30x -test.run XXX
GOGC=400 ./omb.test -test.bench BenchmarkRunPool64Heavy -test.benchtime 30x -test.run XXX
perf record -F 199 -g --call-graph dwarf,16384 -o pool.perf.data -- ./omb.test ...
perf report -i pool.perf.data --stdio --no-children --percent-limit 0.5
```

剖析要点：memprofile 不要用 `-test.memprofilerate=1`（会把帧预算全拖
垮，deferred 99%，只能用于归因不能用于计时）；perf 在该机内核符号
有限，函数级归因以 Go pprof 为主、perf top 为辅。
