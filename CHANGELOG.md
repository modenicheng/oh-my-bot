# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0-rc.2](https://github.com/modenicheng/oh-my-bot/compare/v1.1.0...v1.1.0-rc.2) (2026-10-17)


### ⚠ BREAKING CHANGES

* **sim:** v4 gameplay rebalance with acceleration-limited dash
* **mapgen:** player-adaptive map skeleton (GeneratorVer 8) with ArenaRadius in MapDef

### Features

* add host spectator rooms and direct rematches ([9b3ee30](https://github.com/modenicheng/oh-my-bot/commit/9b3ee3054c1d2dfc6f8d770bb88b5e9c983d0fa4))
* add landscape mobile controls and responsive game layouts ([93462d2](https://github.com/modenicheng/oh-my-bot/commit/93462d20f0cfe4dc9c27d4cab158f9177ff4c4dc))
* add script console and flat bot API ([965d628](https://github.com/modenicheng/oh-my-bot/commit/965d628896d73e216ab1c538a1483694029616d7))
* add snippets AI assistance and deterministic navigation ([4987f14](https://github.com/modenicheng/oh-my-bot/commit/4987f142e3dbde5d082d7c54cad55cf02206d27c))
* ai + stats service contracts (plan A4) — T5/T-stats freeze targets ([dc90c6d](https://github.com/modenicheng/oh-my-bot/commit/dc90c6d4a64c98ccd505a3e6eeeddae3f4193e10))
* ai agent service — quota, deepseek provider, mock (T5) ([946ac2f](https://github.com/modenicheng/oh-my-bot/commit/946ac2f6149678db6033eced0369e892d78569cc))
* ai-prompt + resync routing (Phase D part 5) ([e341457](https://github.com/modenicheng/oh-my-bot/commit/e341457ecc023b72608f09d2f437631a9c4080f6))
* **art:** pixel medkit health pack, sized between core and robot ([390ce82](https://github.com/modenicheng/oh-my-bot/commit/390ce823def81bf2b570f8e249327955be0b20ca))
* **auth:** add OIDC login authentication ([6694b0a](https://github.com/modenicheng/oh-my-bot/commit/6694b0a1241e0b2824dd90b023abedde635ce554))
* **beta:** finalize arena feedback and core scaling ([e5a7bd2](https://github.com/modenicheng/oh-my-bot/commit/e5a7bd292ec02863e82c403b5223284c93403213))
* **bot-api:** expose projectile owner/heading in scan() and add predictive-shield example ([4b03cb0](https://github.com/modenicheng/oh-my-bot/commit/4b03cb0381606b1cfd991863d5bf95c2409182aa))
* **bots:** add Oracle combat script — orienteering route planner, linear health weighting, second-order lead fire control ([1c2d5ee](https://github.com/modenicheng/oh-my-bot/commit/1c2d5eebef73b89a5b3b448ecec8836015182af9))
* **bots:** expose static map walls to scripts ([2e7c870](https://github.com/modenicheng/oh-my-bot/commit/2e7c870718fb33e5cab0a80d1321b46085b78ea7))
* **ci:** add GHCR image build ([#19](https://github.com/modenicheng/oh-my-bot/issues/19)) ([e6b6408](https://github.com/modenicheng/oh-my-bot/commit/e6b6408d4ac1a0a44259750edaf1eac7fe245833))
* client game view — canvas render, input, HUD, replay-ready world (Phase C) ([474b473](https://github.com/modenicheng/oh-my-bot/commit/474b473e04b5d666400be4e86e0f0ee93e7691c6))
* client probe decodes protobuf downlink frames ([633243f](https://github.com/modenicheng/oh-my-bot/commit/633243f3532feb64c033aa287f7d69aa5bac02f6))
* client room page — join form + lobby, STYLE.md tokens ([53a9768](https://github.com/modenicheng/oh-my-bot/commit/53a9768f0c05c0bd16ece94ae525f3ec73e68a7d))
* **client:** add animated ASCII startup and trusted audio gate ([b68524d](https://github.com/modenicheng/oh-my-bot/commit/b68524d68e4bca7bf829f49cfa97fe27ab87118e))
* **client:** add desktop skill HUD and combat audiovisual feedback ([1e13c8a](https://github.com/modenicheng/oh-my-bot/commit/1e13c8a47afd7d5dbd3f371e9fb5d1d3825705c7))
* **client:** add in-game options and explicit leave ([ee5ca72](https://github.com/modenicheng/oh-my-bot/commit/ee5ca7247237135f32ae1dd60b87572d69c2cf37))
* **client:** add read-only live room spectator view ([f5f5bd9](https://github.com/modenicheng/oh-my-bot/commit/f5f5bd9c66db4f9b9995ed1d3e3525b180a2c6a8))
* **client:** add read-only recorded spectator view ([c7d0a8e](https://github.com/modenicheng/oh-my-bot/commit/c7d0a8e91a462095fb22954ed4800caa3ff02716))
* **client:** add read-only recorded spectator view ([6e9d363](https://github.com/modenicheng/oh-my-bot/commit/6e9d363af867ab95ff5eb779f4bbd53b053b3bb3))
* **client:** add stacked manual and script editor sidebar ([ad4d39f](https://github.com/modenicheng/oh-my-bot/commit/ad4d39fcda3ab1f574ce3e89c27f7f496000c8fb))
* **client:** announce match events with pixel banners and audio cues ([dfc4625](https://github.com/modenicheng/oh-my-bot/commit/dfc4625c1149814ea17d4088dec93b07c284b545))
* **client:** batch kills into a bounded tactical feed ([707f3ed](https://github.com/modenicheng/oh-my-bot/commit/707f3edab8df4586f24683fd2fa2f6c269e1db40))
* **client:** compile TypeScript bots before submit ([4768de5](https://github.com/modenicheng/oh-my-bot/commit/4768de58ed14b6f67120fc41385444b1249950d6))
* **client:** complete health pack and title experience ([21a334d](https://github.com/modenicheng/oh-my-bot/commit/21a334dbe6063ba3a71e5140e925f8df01535446))
* **client:** distinguish the main uplink ([522e446](https://github.com/modenicheng/oh-my-bot/commit/522e44650f5b10c372752e7fa1ab13755c671a0f))
* **client:** finish scoreboard redesign ([0833144](https://github.com/modenicheng/oh-my-bot/commit/0833144aba7c5cdc41399d672c9efe881ad0d56f))
* **client:** focus game controls and resize the coding sidebar ([8132902](https://github.com/modenicheng/oh-my-bot/commit/81329022f462330777db4b2926880b9e77e7a88c))
* **client:** host ESC controls, pause overlay, duration form, direct next match ([55f1e49](https://github.com/modenicheng/oh-my-bot/commit/55f1e492104ccc5ee34e34155aaa70203339acab))
* **client:** integrate scoreboards and stage music in modular app ([6294ca7](https://github.com/modenicheng/oh-my-bot/commit/6294ca791dfd6a6312cb8efe99cc9d8de9266e24))
* **client:** make script console DevTools-like ([a2e0745](https://github.com/modenicheng/oh-my-bot/commit/a2e0745df8fc6eef53775e919c90cd4cd68d8b50))
* **client:** per-axis manual takeover HUD and single-Space restore ([180b610](https://github.com/modenicheng/oh-my-bot/commit/180b610d20a2ab5d3fc101fdc3e401d186120b75))
* **client:** R seizes the turret axis; mouse aim yields to script aim (guard) ([742ff53](https://github.com/modenicheng/oh-my-bot/commit/742ff5315023a4812c11dec671e84c1d1ad2a7da))
* **client:** redesign death and settlement UI with accessible title evidence ([1425d10](https://github.com/modenicheng/oh-my-bot/commit/1425d103e4eca55de89f7bf67392ed842d404938))
* **client:** suppress text selection in main panels and HUD ([421a9b9](https://github.com/modenicheng/oh-my-bot/commit/421a9b9e1d3cb15694305120292f3fab5545860f))
* **client:** vision fog and defeat camera shake ([2303f0b](https://github.com/modenicheng/oh-my-bot/commit/2303f0bb3d01e30d3512ea68b2b0a7a4e19c6b8a))
* **client:** 为可购买升级添加轻量扫光提示 ([6cd267d](https://github.com/modenicheng/oh-my-bot/commit/6cd267d2d9e30a14bb06d021c6f91368d1f10dfe))
* **client:** 升级玩法 UI——黄色菱形技能点/五行升级面板/晶片渲染/按键购买 ([69c010e](https://github.com/modenicheng/oh-my-bot/commit/69c010e360709b128c32c841b1016dc72de35123))
* **combat:** replace partners with damage-share attribution ([e22b231](https://github.com/modenicheng/oh-my-bot/commit/e22b23153380b6902585600e44ea800ea39905c4))
* **control:** make bot intent tick-scoped and dash held ([07035fe](https://github.com/modenicheng/oh-my-bot/commit/07035fe7b6e0f730b8ac990e3429c6feac6070b6))
* **debug:** show server tick telemetry in F3 panel ([152a39c](https://github.com/modenicheng/oh-my-bot/commit/152a39cd28e0badd06ecdd2707394052eb5d3ecb))
* **deploy:** bake large-room defaults into image and add compose recipe ([111fff8](https://github.com/modenicheng/oh-my-bot/commit/111fff81535ac619b1e6ab8efa05cac6fd425d7c))
* deterministic visual replay export and interpolated playback ([a17429a](https://github.com/modenicheng/oh-my-bot/commit/a17429a638f8d0cd35f83c87fdbbbb4cf726ae34))
* expose bounded simulation stage timings ([a3e4065](https://github.com/modenicheng/oh-my-bot/commit/a3e4065994592a3b3cc2bb1feb3610ac19980a21))
* **game:** add host-controlled scripted test opponents ([7147954](https://github.com/modenicheng/oh-my-bot/commit/7147954aa37a5ceef2ebcf5f7fc9ea520d015bdc))
* **game:** improve feedback objectives and map generation ([1301cdc](https://github.com/modenicheng/oh-my-bot/commit/1301cdcf16523e722213b8d607d0646d4ee2bdd7))
* gameplay systems — arbitration, combat, objectives, partners (T1) ([2402b34](https://github.com/modenicheng/oh-my-bot/commit/2402b340c10e0e7a380be38505d4369bbc376734))
* **gameplay:** add deterministic health packs ([a883dfa](https://github.com/modenicheng/oh-my-bot/commit/a883dfaac739b3c06f305c11d72dce1f01ae3c54))
* **game:** 随机资源供给、人数自适应 SP 与局部感知 ([94abd9e](https://github.com/modenicheng/oh-my-bot/commit/94abd9ea05f2ea7edaac0139f774517c572769d0))
* glue layer — full-chain integration (Phase D part 1) ([bab4c48](https://github.com/modenicheng/oh-my-bot/commit/bab4c4808ddfaa20420848472989c5a2febac731))
* **glue,snapshot:** 升级玩法传输层——SelfState.upgrade 私密下发/RobotState 公开上限/PointDrop 通道/UpgradeRequest 路由 ([9ed1962](https://github.com/modenicheng/oh-my-bot/commit/9ed19620b48be033d74c1dcd8fdfe5d9223861da))
* **glue:** host pause/resume/finish controls with paused broadcast ([34cfeaa](https://github.com/modenicheng/oh-my-bot/commit/34cfeaace7154537dc991f73330ea652b418b438))
* hot-reload dev loop (vite /ws proxy, disk FS overrides, air) ([cb2e4ef](https://github.com/modenicheng/oh-my-bot/commit/cb2e4ef734d94665e9bebd4d4e832a3b377480e3))
* improve spawn and respawn placement ([fd0f748](https://github.com/modenicheng/oh-my-bot/commit/fd0f748c1619eae0942e9d3cfb2837aea8871651))
* keep room-scoped bot script and assist across matches ([c9ba157](https://github.com/modenicheng/oh-my-bot/commit/c9ba15773c026afc21b01b5c656b512aa802e8f4))
* manual API — embed FS tree + markdown passthrough (ADR-0011) ([336e030](https://github.com/modenicheng/oh-my-bot/commit/336e0309a3819a040403b928c1d065d5c1ae2366))
* manual reader + multi-language code tabs (client) ([1a40c70](https://github.com/modenicheng/oh-my-bot/commit/1a40c7041fc42d34ef9214f2175ed8da60881f98))
* **manual:** add generated visual gallery ([f50aafd](https://github.com/modenicheng/oh-my-bot/commit/f50aafdcf24fd583a28c8a4fb960f9cffa42959a))
* **manual:** add navigation frontmatter metadata foundation ([a7ff4ce](https://github.com/modenicheng/oh-my-bot/commit/a7ff4cefecad8ac2b5bff2898ab2ebbab682301d))
* **manual:** parse tag/tags/order frontmatter and show tags on page title ([0cc1f3d](https://github.com/modenicheng/oh-my-bot/commit/0cc1f3dfc3d00bf2e09087880ecdcaedfcf1153d))
* **map:** add inner cover and denser core refresh ([73b9e16](https://github.com/modenicheng/oh-my-bot/commit/73b9e164a2f738fea685e0686981c32d26741473))
* mapgen — deterministic eight-spoke map generator (T0) ([c863a64](https://github.com/modenicheng/oh-my-bot/commit/c863a643bb032a164a91d50188099897f15e1f11))
* **mapgen:** player-adaptive map skeleton (GeneratorVer 8) with ArenaRadius in MapDef ([85b9074](https://github.com/modenicheng/oh-my-bot/commit/85b907407dbf68f8c2187c25ac4d8975acf24f28))
* **mapgen:** two-piece L cover silhouettes in gen4 ([fe598d1](https://github.com/modenicheng/oh-my-bot/commit/fe598d12cd62349c9bb38eebeaae5f8f6b3e350b))
* **mapgen:** v9 外环 pad 配额保底 ≥ TargetAlive——大房升级点数经济不再被面积配额封顶 ([b6f01d2](https://github.com/modenicheng/oh-my-bot/commit/b6f01d2c24c7daaafbb808367606dd4b049516f5))
* match event log persistence wired (v1 goal: full event recording) ([df291db](https://github.com/modenicheng/oh-my-bot/commit/df291db6c080a3dbcc998e305e2f424bba2544c6))
* match launch chain + fix room-mutex deadlock (Phase D part 2) ([e8d3c53](https://github.com/modenicheng/oh-my-bot/commit/e8d3c53cf52e50bdc0112287415897131ad9c779))
* monorepo skeleton — go server + ts workspace ([dfa9abd](https://github.com/modenicheng/oh-my-bot/commit/dfa9abd93723a991fbad0606cb16f5897b57f589))
* monorepo skeleton + ui style tokens ([ef43e40](https://github.com/modenicheng/oh-my-bot/commit/ef43e400f3e9948dec1c78433a908d3c0863bdc2))
* **music:** quantize stage switches to beat/bar boundaries ([f7fc36d](https://github.com/modenicheng/oh-my-bot/commit/f7fc36d3358b7aedd0414b9c520080716e533e45))
* netws dual-channel transport (plan A2) + proto contract revisions (A1) ([aaf1511](https://github.com/modenicheng/oh-my-bot/commit/aaf15112265a64fe0804db0b2b4e6faddc99f4d9))
* **observability:** add configurable structured logging ([3c8cbd1](https://github.com/modenicheng/oh-my-bot/commit/3c8cbd14554ef77a251d0e87eed4a02ebac9836d))
* **omb:** /api/stats observability endpoint and gated pprof ([7b1f0cb](https://github.com/modenicheng/oh-my-bot/commit/7b1f0cb5f4057d991cf0d64aaa130a84339912a7))
* **omb:** parse join-time duration settings at room creation ([8a778a1](https://github.com/modenicheng/oh-my-bot/commit/8a778a11802b36caa37e16296132a8d90b55ae28))
* optimize mobile battle controls ([30fa088](https://github.com/modenicheng/oh-my-bot/commit/30fa0887ecba2a98579cfdd854e0244b665952aa))
* polish HUD and improve assist takeover ([4f8f74d](https://github.com/modenicheng/oh-my-bot/commit/4f8f74d32874617c3466ad420d405c8590af7e83))
* protobuf schema + cross-language golden contract tests ([6719c03](https://github.com/modenicheng/oh-my-bot/commit/6719c03e7e18766b6f0f7ed25bba1e1c153556b5))
* **protocol:** add compact binary snapshots and bounded event batching ([0e94f1a](https://github.com/modenicheng/oh-my-bot/commit/0e94f1a4b8e7a7272c49dab3870477b85b671d0e))
* **protocol:** add read-only spectator join message ([3278600](https://github.com/modenicheng/oh-my-bot/commit/3278600c4bef50d1a823ecc07482ff423cf3b62e))
* **protocol:** authoritative replay record schema for TS and Go (X-6) ([51cec6e](https://github.com/modenicheng/oh-my-bot/commit/51cec6ea86a397f28bc61c8e9cb63f30abd7e95f))
* **protocol:** authoritative SimTuning payload and structured control notices (X-3+X-4) ([dbd7c66](https://github.com/modenicheng/oh-my-bot/commit/dbd7c6620780f330d5a38be1608480f393afc99d))
* **protocol:** carry projectile visual color metadata ([7b5b306](https://github.com/modenicheng/oh-my-bot/commit/7b5b306c0ee16b4ecaab9b6a388fa633b1a719d2))
* **protocol:** host PAUSE/RESUME/FINISH actions, paused flag and join-time durations ([0cc476a](https://github.com/modenicheng/oh-my-bot/commit/0cc476ac9650e2463d61baa2a08ec20e0022b08a))
* **protocol:** integrate authoritative live scoreboard foundation ([93cdf3b](https://github.com/modenicheng/oh-my-bot/commit/93cdf3bbe37c663a53c4092982f1ecf5a2d041f3))
* **protocol:** 升级玩法消息——UpgradeRequest/UpgradeSelf/PointDrop/UpgradeTuning 与双侧 golden 互钉 ([6e409c7](https://github.com/modenicheng/oh-my-bot/commit/6e409c74f6a09986071abf096b4c54a2ac0d7950))
* replay API — match list + NDJSON event stream (v1 goal: full replay) ([2329a85](https://github.com/modenicheng/oh-my-bot/commit/2329a8538074699ea3df38add97ff1a7632d893e))
* replay UI — library, timeline, event markers, score tracking (v1 goal complete) ([8973f72](https://github.com/modenicheng/oh-my-bot/commit/8973f72ac20ed06bcbb6740e589b1f03e62b19d7))
* **replay:** restore checkpoints and replay authoritative logs ([b8cb828](https://github.com/modenicheng/oh-my-bot/commit/b8cb828f1f7fbef0dfa3999e3e480b12091e28e9))
* room state machine — private rooms + session scores ([db557ea](https://github.com/modenicheng/oh-my-bot/commit/db557eaf2ec85bbd81991a48fbd66ebaabe9e0db))
* **room:** configurable seat cap via OMB_MAX_PLAYERS ([4808174](https://github.com/modenicheng/oh-my-bot/commit/48081746bbc1e4f8eb332483a26d77229d8d231d))
* **room:** host duration config captured at room creation window ([e7a51b4](https://github.com/modenicheng/oh-my-bot/commit/e7a51b4a08e52491a51941819b6c6c37fa0c1d8e))
* script pipeline + async match launch (Phase D part 3) ([9140cef](https://github.com/modenicheng/oh-my-bot/commit/9140cefbd0336afab1c9f80d6fefca35135c56c8))
* script runtime — goja sandbox, quota, hot swap, parallel pool (T2) ([00db00c](https://github.com/modenicheng/oh-my-bot/commit/00db00c8b37a15df59ef81fd3de0ed277372fe30))
* **script:** AI code auto-fills editor with room-scoped version rollback ([2eb909a](https://github.com/modenicheng/oh-my-bot/commit/2eb909a8834258fc0eb2c63407f0b78b35091454))
* **script:** preserve editor language in version records ([4a1dbde](https://github.com/modenicheng/oh-my-bot/commit/4a1dbdefeae391b1d9204ede02044488271a02c1))
* **server:** add isolated read-only live spectator feed ([8044782](https://github.com/modenicheng/oh-my-bot/commit/80447822f8dd5b288449cc858ad67b0ff6dfcb78))
* **server:** default to loopback and support unix listeners ([0f0f023](https://github.com/modenicheng/oh-my-bot/commit/0f0f023dba3d39e03fe92504cf58cc6811e9f2ff))
* **server:** honor OMB_CONFIG_DIR for runtime config lookup ([4a64d4f](https://github.com/modenicheng/oh-my-bot/commit/4a64d4f76a4f87f9bc02bd25f152a740aed84242))
* **server:** queue manual say with shared cooldown and replay records ([e406705](https://github.com/modenicheng/oh-my-bot/commit/e406705dce7b11eab8ec8fcaf3cf929a46ffde2d))
* sim contract package (plan A3) — cross-package types frozen ([e160be9](https://github.com/modenicheng/oh-my-bot/commit/e160be9167221119277759d26f4642706c987a97))
* **sim:** add bounded damped robot contact impulses ([d9655a8](https://github.com/modenicheng/oh-my-bot/commit/d9655a83d9b553dc17d3e4edff0911c3c5591bbb))
* **sim:** add tangential collision sliding and authoritative skill feedback ([e8349a1](https://github.com/modenicheng/oh-my-bot/commit/e8349a1e7ef884e08ab7d425e6d5cdd091c4d723))
* **sim:** configurable match durations and early-finish settlement ([5de3d64](https://github.com/modenicheng/oh-my-bot/commit/5de3d6411ef99e743385d578d0ef6d92ab3cbdbc))
* **sim:** fine-grained manual takeover with single-Space restore ([955647e](https://github.com/modenicheng/oh-my-bot/commit/955647ec33354e3e94b84050e78d2cab47d42b3e))
* **sim:** swept circle pickup for cores and health packs ([fb07b59](https://github.com/modenicheng/oh-my-bot/commit/fb07b59053d71dde05c9556adc98ad369c5a4dcc))
* simulation core — 60Hz fixed-step loop + event-sourced JSONL log ([aa2c886](https://github.com/modenicheng/oh-my-bot/commit/aa2c8864d70cbf29d4f3f464c2434a847d2fa6d7))
* **sim:** v4 gameplay rebalance with acceleration-limited dash ([6d9c035](https://github.com/modenicheng/oh-my-bot/commit/6d9c0356a3d5a28bff2a0709f78e15c71659f298))
* **sim:** 局内升级系统——五维成长/技能点经济/赏金阵亡散落 PointDrop（SimulationVersion 5） ([a4a2828](https://github.com/modenicheng/oh-my-bot/commit/a4a2828c3efa129a0a5cfa22e141310d55826ab3))
* snapshot package — AOI observation + delta encoding (T3) ([b26eb4e](https://github.com/modenicheng/oh-my-bot/commit/b26eb4e260a2b82f0aeaf273ba98ee0f3294efec))
* **snippet:** serve catalog metadata from the server (X-2/D8) ([81ce9dc](https://github.com/modenicheng/oh-my-bot/commit/81ce9dceabd317fd038c9e5e59af194afa393651))
* **snippet:** trim catalog to six modules; autoAim becomes pure direct aim ([5bbe31f](https://github.com/modenicheng/oh-my-bot/commit/5bbe31f4f2403a850bbb57fc01806931a47d59db))
* **startup:** animate truthful character loader ([0a0177d](https://github.com/modenicheng/oh-my-bot/commit/0a0177da7d370643dd94cc33f67077118fae54ee))
* stats projector — all 13 titles + replay recomputation (T-stats) ([076440e](https://github.com/modenicheng/oh-my-bot/commit/076440e9b9062ade55a1d06e7c5e73cf3b7bfd10))
* stream AI responses into the workbench panel ([9e4a103](https://github.com/modenicheng/oh-my-bot/commit/9e4a10336e8e1da04f329154a7742f9838683edf))
* **testing:** fill local rooms to 64 bots ([2e5e74f](https://github.com/modenicheng/oh-my-bot/commit/2e5e74f8ac8a975a2a1edf06c08bcf18ed1017e4))
* **tools:** omb-load single-room WS load driver ([3fd892c](https://github.com/modenicheng/oh-my-bot/commit/3fd892cc19fc88f07abc7d47b734a8e9a2ddadb9))
* **tools:** omb-load WAN entry, pong reply and per-conn read diagnostics ([2679afd](https://github.com/modenicheng/oh-my-bot/commit/2679afdb5afbeea2f40e3facf42a913ff0d1255b))
* warmup mode — full-sim practice instance (Phase D part 4) ([46baf0a](https://github.com/modenicheng/oh-my-bot/commit/46baf0afa3ffd1338bf45fc6d41d9b9e69afea06))
* **workbench:** language-aware script versions with body-portal overlay ([90d5819](https://github.com/modenicheng/oh-my-bot/commit/90d58191a6415ff7583af71e16fc0bb1614fb850))
* **workbench:** preload editor module from startup gesture ([813c205](https://github.com/modenicheng/oh-my-bot/commit/813c2051bc1069d14ab2aa06eb0f54e172253369))
* ws transport endpoint (adr-0012) — server /ws + echo session ([f272614](https://github.com/modenicheng/oh-my-bot/commit/f272614f3190d32bd78db72c29b45496e0b8dc47))


### Bug Fixes

* **ai:** reread script rev inside the serial section before submit ([4e7e311](https://github.com/modenicheng/oh-my-bot/commit/4e7e311661fd9fb8438f9af4d795f125b44bb206))
* align Docker Go version with go.mod ([11d0015](https://github.com/modenicheng/oh-my-bot/commit/11d0015ffe0f95ae03c7ceb46e98ccefce43c61f))
* **auth:** replace WS 401 gate with terminal join-failed notice to stop reconnect loops ([e388da8](https://github.com/modenicheng/oh-my-bot/commit/e388da89d62e3da92161dbfaee8405be1e6be395))
* **ci:** check Close errors in omb-load and stats test (errcheck) ([5b11564](https://github.com/modenicheng/oh-my-bot/commit/5b11564b7a01911970e115e61b694bca0f0b35b0))
* **ci:** compute image tags explicitly for workflow_dispatch releases ([922ca1b](https://github.com/modenicheng/oh-my-bot/commit/922ca1b226a46718d5d7b7fa8d01269e9fb2d301))
* **ci:** emit image tags newline-separated for build-push-action ([0142fc2](https://github.com/modenicheng/oh-my-bot/commit/0142fc2ddf92d24708c3433c4fe07b115a4272c1))
* client P1s — lobby start/warmup controls, member list, hp bars, settlement ([f3be4f5](https://github.com/modenicheng/oh-my-bot/commit/f3be4f5a09d4e460d4711069b8872309d3ea698b))
* **client:** aim guard engages on local script capability, not turret_src echo ([b62c4d0](https://github.com/modenicheng/oh-my-bot/commit/b62c4d003bac97e076599a338ac9397d9af6ece7))
* **client:** cache cameraZoom per tick and converge scattered gameplay constants ([efb8217](https://github.com/modenicheng/oh-my-bot/commit/efb8217e976c83040749d4aaff89f722b37eb23d))
* **client:** chat/comms overlap, dark color-scheme, replay tail tolerance (C-36/C-37/C-45) ([56ddccb](https://github.com/modenicheng/oh-my-bot/commit/56ddccb9a082ce7bb74413a77c841bbfc26c195c))
* **client:** clarify damage and invulnerability feedback ([737fd3c](https://github.com/modenicheng/oh-my-bot/commit/737fd3c14d8e95dd9c2095592db8d8169b7a8c04))
* **client:** clear replay titles when leaving settlement ([6308e76](https://github.com/modenicheng/oh-my-bot/commit/6308e76c9283fae688d17a9ef750d079c72f6eb1))
* **client:** escape layering and Safari audio unlock (C-32/C-43) ([2c070dc](https://github.com/modenicheng/oh-my-bot/commit/2c070dcf89ab5a0463554b8e4606682ca8b58be0))
* **client:** float scoreboard title details ([97f7bbe](https://github.com/modenicheng/oh-my-bot/commit/97f7bbe979db16d6731cccf8a4277c6cbcc6ceff))
* **client:** harden live spectator recovery and narrow layouts ([e521f27](https://github.com/modenicheng/oh-my-bot/commit/e521f2770245e1bd784bd93ee19c461834aeba60))
* **client:** keep console count slots stable across digit growth ([8cb6f54](https://github.com/modenicheng/oh-my-bot/commit/8cb6f54ff324a3848aea6f1446821ccd5b77c7e2))
* **client:** keep monaco out of vite dep optimizer to prevent double registry load ([#8](https://github.com/modenicheng/oh-my-bot/issues/8)) ([5a5f9f3](https://github.com/modenicheng/oh-my-bot/commit/5a5f9f345b4dcf90b882cb33fdd77c52ded6200c))
* **client:** keep released controls neutral ([45e9a7c](https://github.com/modenicheng/oh-my-bot/commit/45e9a7c8393ca27caa662dfa23e6edb3755b7d0d))
* **client:** persist invulnerability and trim 64-player render work ([91182f2](https://github.com/modenicheng/oh-my-bot/commit/91182f253bfcee4d66706e87e6aa63ed4081cde0))
* **client:** preserve locked vision mask fill rule ([7ddad88](https://github.com/modenicheng/oh-my-bot/commit/7ddad88dd1cc0bf73a655c409712823b0520dc28))
* **client:** preserve wall shadow union and replay names ([6044747](https://github.com/modenicheng/oh-my-bot/commit/60447478284864817ce6a82a3f3ef0c97825f6ae))
* **client:** preserve wall shadows and replay settlement names ([7e28841](https://github.com/modenicheng/oh-my-bot/commit/7e28841065cdfbe2430623cc6e7cf940b3732b79))
* cmd/omb echo session adapted to dual-channel Handler signature ([50fd817](https://github.com/modenicheng/oh-my-bot/commit/50fd81741d82c5eb396b87561108f6c0d90b6ef9))
* **contracts:** pin TS/Go protocol constants and add drift guards ([71925db](https://github.com/modenicheng/oh-my-bot/commit/71925dbbf2d438e9710247522e00f6c99e2b51b0))
* **dash:** require release after energy exhaustion ([0297657](https://github.com/modenicheng/oh-my-bot/commit/029765713dc8be9226bfea640305f82ddb1c9a47))
* expose health packs in bot runtime ([26e0b6d](https://github.com/modenicheng/oh-my-bot/commit/26e0b6d3ebef7569faf45e8ddde06285b0a782c0))
* **feedback:** keep hacking camera stationary ([3c5588d](https://github.com/modenicheng/oh-my-bot/commit/3c5588d360248dadce3472e31da0ae0d6b44f28c))
* **gameplay:** preserve projectile colors and avoid static walls ([d23dcf7](https://github.com/modenicheng/oh-my-bot/commit/d23dcf78cbf78059387f8e82ea864c77ee33e8d3))
* **glue:** nanosecond tick stats resolution and stable stats test ([d7c7970](https://github.com/modenicheng/oh-my-bot/commit/d7c7970377968a3affd2de12476ca39125a4d289))
* **glue:** skip roster bootstrap for sessions bound mid-publish (S-27) ([87179de](https://github.com/modenicheng/oh-my-bot/commit/87179def42d8a255cb5e6b28db1595ebb9e497a4))
* harden script console delivery ([f7b4660](https://github.com/modenicheng/oh-my-bot/commit/f7b46604ef8ced1f6362b9a8f110eb2f0bf73c60))
* make OIDC match startup recoverable ([c3d6b74](https://github.com/modenicheng/oh-my-bot/commit/c3d6b741cd321eefc60d0151cd0608ba512de779))
* manual navigation chain — three-layer path bug (eighth audit) ([1a67de7](https://github.com/modenicheng/oh-my-bot/commit/1a67de75885a02aab8fa57f1036b8370c4b176a5))
* **mapgen:** constrain overlap exemptions to sibling pieces ([ca3e6c5](https://github.com/modenicheng/oh-my-bot/commit/ca3e6c58e1f626a12ec6e67558bb3c3176b5e633))
* **mapgen:** widen cover candidate lattice for scaled layouts ([26279a2](https://github.com/modenicheng/oh-my-bot/commit/26279a20c98e5a1e21085fca017b630afb069393))
* **music:** adapt synth engine to strict client TypeScript ([c0dfdb4](https://github.com/modenicheng/oh-my-bot/commit/c0dfdb45ff5dd674a28dd21523e4d7116e195970))
* **music:** duplicate pending stage request keeps original schedule ([7da40c1](https://github.com/modenicheng/oh-my-bot/commit/7da40c1eb9df90b94623957fcac80a822b3da9ec))
* **net:** reconnect room sessions with bounded backoff and liveness checks ([47df783](https://github.com/modenicheng/oh-my-bot/commit/47df7834134e16437d6d482e53ce037efd50d52f))
* **observability:** retain logging across mobile merge ([669292c](https://github.com/modenicheng/oh-my-bot/commit/669292c5a9e5837f6be1d1e69d41992713116cd9))
* per-connection session isolation via netws session factory ([930e3e4](https://github.com/modenicheng/oh-my-bot/commit/930e3e4d9c1e3ebf54c900c251ce2680907d910f))
* **protocol:** raise script submit frame limit to 64 KiB ([502419e](https://github.com/modenicheng/oh-my-bot/commit/502419e2d6c97626d0fbc88431a8bc768086c655))
* reconnect button performs actual rejoin with last params ([cb79a75](https://github.com/modenicheng/oh-my-bot/commit/cb79a75a7e7526f41b97bda82ff84ee790bff957))
* recover OIDC match startup and publish diagnostics ([c76bf6c](https://github.com/modenicheng/oh-my-bot/commit/c76bf6c17334b306a7631db2941ddb694001742f))
* **replay:** persist identities and final settled match ([c9a8996](https://github.com/modenicheng/oh-my-bot/commit/c9a8996f1a4830a4ef016a0225ca78b3f1bb1e4c))
* **replay:** reject inconsistent checkpoints and sequence regression ([42ee370](https://github.com/modenicheng/oh-my-bot/commit/42ee3709c2c4645ba2c0c6bfcea97a7a593858f3))
* **replay:** sample input-only tails after health events ([7a1c45d](https://github.com/modenicheng/oh-my-bot/commit/7a1c45df0418e963ae38b8c71bc78524467983d4))
* **room:** accept full A-Z0-9 room codes, drop confusable exclusion ([7135574](https://github.com/modenicheng/oh-my-bot/commit/7135574b634844564253b5edc410bb4c623d1d55))
* **room:** allow START from Ended to launch the next scored match directly ([56142e3](https://github.com/modenicheng/oh-my-bot/commit/56142e34779753366f06b23d53f3692a9450b6cb))
* **script:** expose static walls in scan() and make solo bots steer around walls ([b321f81](https://github.com/modenicheng/oh-my-bot/commit/b321f8141b68ce6217b495eb937825c43d42047d))
* **script:** freeze deadline results before returning from collection ([637613c](https://github.com/modenicheng/oh-my-bot/commit/637613c11e56450409beef598d3fb4bff856ff75))
* **script:** remove runtime console drop limits ([0567b7d](https://github.com/modenicheng/oh-my-bot/commit/0567b7d7a69ec2faa4d6ce9acf1e4dabffe914ee))
* server P0s from e2e audit — matchEnd idempotent + robot identity ([75f935c](https://github.com/modenicheng/oh-my-bot/commit/75f935c2fafb062aa4b952978ade450ef86449ee))
* **server:** idle-room janitor, mid-match bootstrap gating (S-26/S-27) ([1f36dc7](https://github.com/modenicheng/oh-my-bot/commit/1f36dc7051d3234f7d8214933645e27b970e13d3))
* **server:** preserve pulse vision and complete replay sinks ([463e36e](https://github.com/modenicheng/oh-my-bot/commit/463e36e41bfcbdd5d20030cff2bf7d67c61e8f9f))
* **server:** replay checkpoint and log hardening (S-28/S-29) ([af01b8d](https://github.com/modenicheng/oh-my-bot/commit/af01b8d93431ab6f360cf604d779f085aae1aa87))
* **server:** session hardening batch (S-30~S-34) ([4e0a842](https://github.com/modenicheng/oh-my-bot/commit/4e0a8423562749c3c635ef49d9bb56089c444b49))
* seventh-audit blockers — manual tree crash, real-replay data, room code ([3317a3a](https://github.com/modenicheng/oh-my-bot/commit/3317a3ae4ca1352712e25c8c80e77ecf6b542303))
* **sim:** block pickup through locked zones and cover ([6ff31db](https://github.com/modenicheng/oh-my-bot/commit/6ff31db44a7ae7323893a0ab6fdec792b0597a46))
* **sim:** Space clears same-tick in-flight takeover; add live takeover check ([b4e89eb](https://github.com/modenicheng/oh-my-bot/commit/b4e89eb65b810afd720c843f3036cceaf24d660c))
* **sim:** stabilize damage shares and validate health bounds ([ff689ae](https://github.com/modenicheng/oh-my-bot/commit/ff689ae4aab8aeac7e98e761c1aae9033b07c588))
* **sim:** 移除被 shotDamageOf 取代的旧 shotDamage 访问器（golangci unused） ([2ad49be](https://github.com/modenicheng/oh-my-bot/commit/2ad49bee630d3421d39885052f0d8fc0aa21bd61))
* **snapshot:** sort delta tombstones by entity id ([0724afe](https://github.com/modenicheng/oh-my-bot/commit/0724afeb9499da9b84b4fa4ffadc6c67b41a0c00))
* stabilize arena sessions and refresh the game UI ([4ee8469](https://github.com/modenicheng/oh-my-bot/commit/4ee84694d1240a5acf8b1ba442b12e91c299c95d))
* **startup:** adapt loader across viewports ([11c3cf5](https://github.com/modenicheng/oh-my-bot/commit/11c3cf5572f18fdd3e658b9fba068c5998bb553d))
* visual audit rework — 4 P0/P1 + style items ([f1f523f](https://github.com/modenicheng/oh-my-bot/commit/f1f523f3832c2d7d63ef233943486d445f5521fc))
* visual audit round 2 — same-origin WS, pong watchdog feed, form gap ([a3b3cfd](https://github.com/modenicheng/oh-my-bot/commit/a3b3cfd39246735ca9fc0f5d2e7cfd0244c085e3))
* warmup button visible in R_IDLE lobby (was ENDED-only) ([1e7a7ed](https://github.com/modenicheng/oh-my-bot/commit/1e7a7ed7868ba0e54b8ba6f4a4401d824f06940a))
* warmup launches + crash lock + host nick + member list (audit round 5) ([f90a07c](https://github.com/modenicheng/oh-my-bot/commit/f90a07c0a16498d8e2861b8c0eb50f62f9b68c7b))


### Performance Improvements

* avoid repeated script roster lookups ([3601fb2](https://github.com/modenicheng/oh-my-bot/commit/3601fb2668638efba5124246d9b676ad8e04e8f2))
* cache boundary tessellation samples ([8bc781e](https://github.com/modenicheng/oh-my-bot/commit/8bc781e766e71701f43788a2a6bd0432494def2d))
* **client:** cut per-frame allocations and shrink the first-screen bundle ([cb35c9e](https://github.com/modenicheng/oh-my-bot/commit/cb35c9e37377c3f7ef99c854d8da96904909d48b))
* **client:** project exact wall shadows ([4b91488](https://github.com/modenicheng/oh-my-bot/commit/4b914881850a394d9eecffa06861248ba459bf58))
* **client:** split feedback module, idle frame skip on canvas stage (C-17/C-26) ([2e42be3](https://github.com/modenicheng/oh-my-bot/commit/2e42be32b01a1790cd30c0dbfe571d801723a2a1))
* **client:** 将游戏展示预处理移出绘制回调 ([7d95597](https://github.com/modenicheng/oh-my-bot/commit/7d955977a5d250b788828692c69d49a9dd0b57fd))
* **client:** 移除局内击杀通知 ([9fd92b6](https://github.com/modenicheng/oh-my-bot/commit/9fd92b66c45e5528da200019ebee167566a3c18b))
* **client:** 跳过未变化的排行榜更新 ([d3f46ac](https://github.com/modenicheng/oh-my-bot/commit/d3f46ac0957d4eb3fcdae94c19999e369ac5233d))
* **glue:** parallelize per-observer AOI and delta encoding for large rooms ([35ebd97](https://github.com/modenicheng/oh-my-bot/commit/35ebd97a4529d0b5f74a4d2fc665b4430a08c798))
* **glue:** pre-marshal room broadcasts, share one frame across connections ([3c63eb7](https://github.com/modenicheng/oh-my-bot/commit/3c63eb752781ec64fa7ba6d0bf934c1e814986d9))
* **glue:** scale per-script tick quota with roster size ([b76dfb7](https://github.com/modenicheng/oh-my-bot/commit/b76dfb79a68134dc89fd35e09884f86362b3a5c0))
* lazily materialize script observations ([be847f2](https://github.com/modenicheng/oh-my-bot/commit/be847f21ad6f3d2ae5b0ed8ebb620ec0f5603669))
* narrow local map wall candidates ([5a2073d](https://github.com/modenicheng/oh-my-bot/commit/5a2073d78c72d931396365dcd2a43840d3996f4c))
* optimize large-room perception scheduling ([9d1d2b1](https://github.com/modenicheng/oh-my-bot/commit/9d1d2b1ffec4832e2100d7c5439a801285ed7050))
* reduce perception geometry math ([8757bd6](https://github.com/modenicheng/oh-my-bot/commit/8757bd6cf32bcb1e367e6da53018560bddb836e7))
* reject distant pickups before collision sweeps ([a8e102a](https://github.com/modenicheng/oh-my-bot/commit/a8e102a64027097615f1894f412fad8aaeccf066))
* **render:** canvas stage host, hot-path allocation cuts, replay races (S-6/C-26/C-31/C-33/C-40) ([ce05ccf](https://github.com/modenicheng/oh-my-bot/commit/ce05ccfe23387cc61fd12696bff29a3344f97458))
* reuse private perception geometry scratch ([42a5c44](https://github.com/modenicheng/oh-my-bot/commit/42a5c449bd5b8c11e1e9ad08cb74ea498fb9ca0a))
* **server:** root-cause script frame allocs and make GC tunable (ADR-0015) ([b60d086](https://github.com/modenicheng/oh-my-bot/commit/b60d0862a1c1af1916af6c9aa2a69ee96f7a6567))
* **sim:** uniform wall grid index for collision sweeps ([2a5e4c5](https://github.com/modenicheng/oh-my-bot/commit/2a5e4c57e32d413e41d73c9e49a98f7ccb242536))
* **startup:** preload editor with splash resources ([cdbeb14](https://github.com/modenicheng/oh-my-bot/commit/cdbeb141d55d1f7ad9a0c4ac07b89eb279a101e4))

## [1.1.0](https://github.com/modenicheng/oh-my-bot/compare/v1.0.0...v1.1.0) (2026-10-17)

### Stable Release

* Promote the 1.1 release series to the stable channel. This release includes
  host spectator rooms and rematches, mobile controls, compact binary snapshots,
  configurable logging, spawn improvements, and the server performance work
  completed through private perception scratch reuse.
* Reuse private wall-corner and boundary clipping buffers while keeping returned
  observations independent. Preserve map geometry, endpoint tolerance, and replay
  behavior with regression tests.
* Expose bounded per-stage tick timings and reject distant resource pickups
  before collision sweeps.
* The 200-heavy-script target of stable tick p95 below 12ms remains under
  investigation; this release does not claim that target has been met.

## [1.2.0-rc.5](https://github.com/modenicheng/oh-my-bot/compare/v1.1.0-rc.5...v1.2.0-rc.5) (2026-10-17)


### Features

* expose bounded simulation stage timings ([a3e4065](https://github.com/modenicheng/oh-my-bot/commit/a3e4065994592a3b3cc2bb1feb3610ac19980a21))
* optimize mobile battle controls ([30fa088](https://github.com/modenicheng/oh-my-bot/commit/30fa0887ecba2a98579cfdd854e0244b665952aa))


### Performance Improvements

* avoid repeated script roster lookups ([3601fb2](https://github.com/modenicheng/oh-my-bot/commit/3601fb2668638efba5124246d9b676ad8e04e8f2))
* cache boundary tessellation samples ([8bc781e](https://github.com/modenicheng/oh-my-bot/commit/8bc781e766e71701f43788a2a6bd0432494def2d))
* lazily materialize script observations ([be847f2](https://github.com/modenicheng/oh-my-bot/commit/be847f21ad6f3d2ae5b0ed8ebb620ec0f5603669))
* narrow local map wall candidates ([5a2073d](https://github.com/modenicheng/oh-my-bot/commit/5a2073d78c72d931396365dcd2a43840d3996f4c))
* optimize large-room perception scheduling ([9d1d2b1](https://github.com/modenicheng/oh-my-bot/commit/9d1d2b1ffec4832e2100d7c5439a801285ed7050))
* reduce perception geometry math ([8757bd6](https://github.com/modenicheng/oh-my-bot/commit/8757bd6cf32bcb1e367e6da53018560bddb836e7))
* reject distant pickups before collision sweeps ([a8e102a](https://github.com/modenicheng/oh-my-bot/commit/a8e102a64027097615f1894f412fad8aaeccf066))

## [1.1.0-rc.5](https://github.com/modenicheng/oh-my-bot/compare/v1.1.0-rc.4...v1.1.0-rc.5) (2026-10-17)


### Features

* improve spawn and respawn placement ([fd0f748](https://github.com/modenicheng/oh-my-bot/commit/fd0f748c1619eae0942e9d3cfb2837aea8871651))


### Bug Fixes

* align Docker Go version with go.mod ([11d0015](https://github.com/modenicheng/oh-my-bot/commit/11d0015ffe0f95ae03c7ceb46e98ccefce43c61f))

## [1.1.0-rc.4](https://github.com/modenicheng/oh-my-bot/compare/v1.1.0-rc.3...v1.1.0-rc.4) (2026-10-17)


### Features

* add host spectator rooms and direct rematches ([9b3ee30](https://github.com/modenicheng/oh-my-bot/commit/9b3ee3054c1d2dfc6f8d770bb88b5e9c983d0fa4))
* add landscape mobile controls and responsive game layouts ([93462d2](https://github.com/modenicheng/oh-my-bot/commit/93462d20f0cfe4dc9c27d4cab158f9177ff4c4dc))
* **debug:** show server tick telemetry in F3 panel ([152a39c](https://github.com/modenicheng/oh-my-bot/commit/152a39cd28e0badd06ecdd2707394052eb5d3ecb))
* **observability:** add configurable structured logging ([3c8cbd1](https://github.com/modenicheng/oh-my-bot/commit/3c8cbd14554ef77a251d0e87eed4a02ebac9836d))
* **protocol:** add compact binary snapshots and bounded event batching ([0e94f1a](https://github.com/modenicheng/oh-my-bot/commit/0e94f1a4b8e7a7272c49dab3870477b85b671d0e))


### Bug Fixes

* **observability:** retain logging across mobile merge ([669292c](https://github.com/modenicheng/oh-my-bot/commit/669292c5a9e5837f6be1d1e69d41992713116cd9))

## [1.1.0-rc.3](https://github.com/modenicheng/oh-my-bot/compare/v1.1.0-rc.2...v1.1.0-rc.3) (2026-10-16)


### Bug Fixes

* **client:** preserve locked vision mask fill rule ([7ddad88](https://github.com/modenicheng/oh-my-bot/commit/7ddad88dd1cc0bf73a655c409712823b0520dc28))
* make OIDC match startup recoverable ([c3d6b74](https://github.com/modenicheng/oh-my-bot/commit/c3d6b741cd321eefc60d0151cd0608ba512de779))
* recover OIDC match startup and publish diagnostics ([c76bf6c](https://github.com/modenicheng/oh-my-bot/commit/c76bf6c17334b306a7631db2941ddb694001742f))


### Performance Improvements

* **client:** 将游戏展示预处理移出绘制回调 ([7d95597](https://github.com/modenicheng/oh-my-bot/commit/7d955977a5d250b788828692c69d49a9dd0b57fd))
* **client:** 移除局内击杀通知 ([9fd92b6](https://github.com/modenicheng/oh-my-bot/commit/9fd92b66c45e5528da200019ebee167566a3c18b))
* **client:** 跳过未变化的排行榜更新 ([d3f46ac](https://github.com/modenicheng/oh-my-bot/commit/d3f46ac0957d4eb3fcdae94c19999e369ac5233d))

## [1.1.0-rc.2](https://github.com/modenicheng/oh-my-bot/compare/v1.1.0-rc.1...v1.1.0-rc.2) (2026-10-15)


### Features

* **client:** 为可购买升级添加轻量扫光提示 ([6cd267d](https://github.com/modenicheng/oh-my-bot/commit/6cd267d2d9e30a14bb06d021c6f91368d1f10dfe))
* **client:** 升级玩法 UI——黄色菱形技能点/五行升级面板/晶片渲染/按键购买 ([69c010e](https://github.com/modenicheng/oh-my-bot/commit/69c010e360709b128c32c841b1016dc72de35123))
* **game:** 随机资源供给、人数自适应 SP 与局部感知 ([94abd9e](https://github.com/modenicheng/oh-my-bot/commit/94abd9ea05f2ea7edaac0139f774517c572769d0))
* **glue,snapshot:** 升级玩法传输层——SelfState.upgrade 私密下发/RobotState 公开上限/PointDrop 通道/UpgradeRequest 路由 ([9ed1962](https://github.com/modenicheng/oh-my-bot/commit/9ed19620b48be033d74c1dcd8fdfe5d9223861da))
* **mapgen:** v9 外环 pad 配额保底 ≥ TargetAlive——大房升级点数经济不再被面积配额封顶 ([b6f01d2](https://github.com/modenicheng/oh-my-bot/commit/b6f01d2c24c7daaafbb808367606dd4b049516f5))
* **protocol:** 升级玩法消息——UpgradeRequest/UpgradeSelf/PointDrop/UpgradeTuning 与双侧 golden 互钉 ([6e409c7](https://github.com/modenicheng/oh-my-bot/commit/6e409c74f6a09986071abf096b4c54a2ac0d7950))
* **sim:** 局内升级系统——五维成长/技能点经济/赏金阵亡散落 PointDrop（SimulationVersion 5） ([a4a2828](https://github.com/modenicheng/oh-my-bot/commit/a4a2828c3efa129a0a5cfa22e141310d55826ab3))
* **tools:** omb-load WAN entry, pong reply and per-conn read diagnostics ([2679afd](https://github.com/modenicheng/oh-my-bot/commit/2679afdb5afbeea2f40e3facf42a913ff0d1255b))


### Bug Fixes

* **sim:** 移除被 shotDamageOf 取代的旧 shotDamage 访问器（golangci unused） ([2ad49be](https://github.com/modenicheng/oh-my-bot/commit/2ad49bee630d3421d39885052f0d8fc0aa21bd61))

## [1.1.0-rc.1](https://github.com/modenicheng/oh-my-bot/compare/v1.0.1-rc.1...v1.1.0-rc.1) (2026-10-14)


### Features

* **client:** host ESC controls, pause overlay, duration form, direct next match ([55f1e49](https://github.com/modenicheng/oh-my-bot/commit/55f1e492104ccc5ee34e34155aaa70203339acab))
* **deploy:** bake large-room defaults into image and add compose recipe ([111fff8](https://github.com/modenicheng/oh-my-bot/commit/111fff81535ac619b1e6ab8efa05cac6fd425d7c))
* **glue:** host pause/resume/finish controls with paused broadcast ([34cfeaa](https://github.com/modenicheng/oh-my-bot/commit/34cfeaace7154537dc991f73330ea652b418b438))
* **omb:** parse join-time duration settings at room creation ([8a778a1](https://github.com/modenicheng/oh-my-bot/commit/8a778a11802b36caa37e16296132a8d90b55ae28))
* **protocol:** host PAUSE/RESUME/FINISH actions, paused flag and join-time durations ([0cc476a](https://github.com/modenicheng/oh-my-bot/commit/0cc476ac9650e2463d61baa2a08ec20e0022b08a))
* **room:** host duration config captured at room creation window ([e7a51b4](https://github.com/modenicheng/oh-my-bot/commit/e7a51b4a08e52491a51941819b6c6c37fa0c1d8e))
* **sim:** configurable match durations and early-finish settlement ([5de3d64](https://github.com/modenicheng/oh-my-bot/commit/5de3d6411ef99e743385d578d0ef6d92ab3cbdbc))


### Bug Fixes

* **ci:** check Close errors in omb-load and stats test (errcheck) ([5b11564](https://github.com/modenicheng/oh-my-bot/commit/5b11564b7a01911970e115e61b694bca0f0b35b0))
* **glue:** skip roster bootstrap for sessions bound mid-publish (S-27) ([87179de](https://github.com/modenicheng/oh-my-bot/commit/87179def42d8a255cb5e6b28db1595ebb9e497a4))
* **room:** accept full A-Z0-9 room codes, drop confusable exclusion ([7135574](https://github.com/modenicheng/oh-my-bot/commit/7135574b634844564253b5edc410bb4c623d1d55))
* **room:** allow START from Ended to launch the next scored match directly ([56142e3](https://github.com/modenicheng/oh-my-bot/commit/56142e34779753366f06b23d53f3692a9450b6cb))

## [1.0.1-rc.1](https://github.com/modenicheng/oh-my-bot/compare/v1.0.0...v1.0.1-rc.1) (2026-10-14)


### ⚠ BREAKING CHANGES

* **sim:** v4 gameplay rebalance with acceleration-limited dash
* **mapgen:** player-adaptive map skeleton (GeneratorVer 8) with ArenaRadius in MapDef

### Features

* **mapgen:** player-adaptive map skeleton (GeneratorVer 8) with ArenaRadius in MapDef ([85b9074](https://github.com/modenicheng/oh-my-bot/commit/85b907407dbf68f8c2187c25ac4d8975acf24f28))
* **omb:** /api/stats observability endpoint and gated pprof ([7b1f0cb](https://github.com/modenicheng/oh-my-bot/commit/7b1f0cb5f4057d991cf0d64aaa130a84339912a7))
* **room:** configurable seat cap via OMB_MAX_PLAYERS ([4808174](https://github.com/modenicheng/oh-my-bot/commit/48081746bbc1e4f8eb332483a26d77229d8d231d))
* **sim:** v4 gameplay rebalance with acceleration-limited dash ([6d9c035](https://github.com/modenicheng/oh-my-bot/commit/6d9c0356a3d5a28bff2a0709f78e15c71659f298))
* **tools:** omb-load single-room WS load driver ([3fd892c](https://github.com/modenicheng/oh-my-bot/commit/3fd892cc19fc88f07abc7d47b734a8e9a2ddadb9))


### Bug Fixes

* **auth:** replace WS 401 gate with terminal join-failed notice to stop reconnect loops ([e388da8](https://github.com/modenicheng/oh-my-bot/commit/e388da89d62e3da92161dbfaee8405be1e6be395))
* **ci:** compute image tags explicitly for workflow_dispatch releases ([922ca1b](https://github.com/modenicheng/oh-my-bot/commit/922ca1b226a46718d5d7b7fa8d01269e9fb2d301))
* **ci:** emit image tags newline-separated for build-push-action ([0142fc2](https://github.com/modenicheng/oh-my-bot/commit/0142fc2ddf92d24708c3433c4fe07b115a4272c1))
* **glue:** nanosecond tick stats resolution and stable stats test ([d7c7970](https://github.com/modenicheng/oh-my-bot/commit/d7c7970377968a3affd2de12476ca39125a4d289))
* **mapgen:** widen cover candidate lattice for scaled layouts ([26279a2](https://github.com/modenicheng/oh-my-bot/commit/26279a20c98e5a1e21085fca017b630afb069393))
* **snapshot:** sort delta tombstones by entity id ([0724afe](https://github.com/modenicheng/oh-my-bot/commit/0724afeb9499da9b84b4fa4ffadc6c67b41a0c00))


### Performance Improvements

* **glue:** parallelize per-observer AOI and delta encoding for large rooms ([35ebd97](https://github.com/modenicheng/oh-my-bot/commit/35ebd97a4529d0b5f74a4d2fc665b4430a08c798))
* **glue:** pre-marshal room broadcasts, share one frame across connections ([3c63eb7](https://github.com/modenicheng/oh-my-bot/commit/3c63eb752781ec64fa7ba6d0bf934c1e814986d9))
* **glue:** scale per-script tick quota with roster size ([b76dfb7](https://github.com/modenicheng/oh-my-bot/commit/b76dfb79a68134dc89fd35e09884f86362b3a5c0))
* **sim:** uniform wall grid index for collision sweeps ([2a5e4c5](https://github.com/modenicheng/oh-my-bot/commit/2a5e4c57e32d413e41d73c9e49a98f7ccb242536))

## [1.0.0](https://github.com/modenicheng/oh-my-bot/compare/v1.0.0-rc.2...v1.0.0) (2026-10-11)


### Features

* **auth:** add OIDC login authentication ([6694b0a](https://github.com/modenicheng/oh-my-bot/commit/6694b0a1241e0b2824dd90b023abedde635ce554))
* **ci:** add GHCR image build ([#19](https://github.com/modenicheng/oh-my-bot/issues/19)) ([e6b6408](https://github.com/modenicheng/oh-my-bot/commit/e6b6408d4ac1a0a44259750edaf1eac7fe245833))

## [1.0.0-rc.2](https://github.com/modenicheng/oh-my-bot/compare/v1.0.0-rc.1...v1.0.0-rc.2) (2026-10-10)


### Bug Fixes

* **client:** chat/comms overlap, dark color-scheme, replay tail tolerance (C-36/C-37/C-45) ([56ddccb](https://github.com/modenicheng/oh-my-bot/commit/56ddccb9a082ce7bb74413a77c841bbfc26c195c))
* **server:** replay checkpoint and log hardening (S-28/S-29) ([af01b8d](https://github.com/modenicheng/oh-my-bot/commit/af01b8d93431ab6f360cf604d779f085aae1aa87))
* **server:** session hardening batch (S-30~S-34) ([4e0a842](https://github.com/modenicheng/oh-my-bot/commit/4e0a8423562749c3c635ef49d9bb56089c444b49))


### Performance Improvements

* **client:** split feedback module, idle frame skip on canvas stage (C-17/C-26) ([2e42be3](https://github.com/modenicheng/oh-my-bot/commit/2e42be32b01a1790cd30c0dbfe571d801723a2a1))

## [1.0.0-rc.1](https://github.com/modenicheng/oh-my-bot/compare/v1.0.0-beta.2...v1.0.0-rc.1) (2026-10-10)


### Features

* polish HUD and improve assist takeover ([4f8f74d](https://github.com/modenicheng/oh-my-bot/commit/4f8f74d32874617c3466ad420d405c8590af7e83))
* **snippet:** serve catalog metadata from the server (X-2/D8) ([81ce9dc](https://github.com/modenicheng/oh-my-bot/commit/81ce9dceabd317fd038c9e5e59af194afa393651))


### Bug Fixes

* **client:** escape layering and Safari audio unlock (C-32/C-43) ([2c070dc](https://github.com/modenicheng/oh-my-bot/commit/2c070dcf89ab5a0463554b8e4606682ca8b58be0))
* **server:** idle-room janitor, mid-match bootstrap gating (S-26/S-27) ([1f36dc7](https://github.com/modenicheng/oh-my-bot/commit/1f36dc7051d3234f7d8214933645e27b970e13d3))


### Performance Improvements

* **render:** canvas stage host, hot-path allocation cuts, replay races (S-6/C-26/C-31/C-33/C-40) ([ce05ccf](https://github.com/modenicheng/oh-my-bot/commit/ce05ccfe23387cc61fd12696bff29a3344f97458))

## [1.0.0-beta.2](https://github.com/modenicheng/oh-my-bot/compare/v1.0.0-beta.1...v1.0.0-beta.2) (2026-10-05)


### Features

* **client:** batch kills into a bounded tactical feed ([707f3ed](https://github.com/modenicheng/oh-my-bot/commit/707f3ed))
* **client:** finish the high-density live and replay scoreboard redesign ([0833144](https://github.com/modenicheng/oh-my-bot/commit/0833144))
* **client:** redesign death and settlement UI with accessible title evidence ([1425d10](https://github.com/modenicheng/oh-my-bot/commit/1425d10))
* **testing:** support local 64-player rooms with up to 63 solo bots ([2e5e74f](https://github.com/modenicheng/oh-my-bot/commit/2e5e74f))

### Bug Fixes

* **client:** clear replay title nodes when seeking away from settlement ([6308e76](https://github.com/modenicheng/oh-my-bot/commit/6308e76))
* **client:** float scoreboard title evidence, keep tags horizontal, and remove nested scrollbars ([97f7bbe](https://github.com/modenicheng/oh-my-bot/commit/97f7bbe))
* **client:** keep Console count slots stable as counts grow ([8cb6f54](https://github.com/modenicheng/oh-my-bot/commit/8cb6f54))
* **client:** persist authoritative invulnerability state and reduce 64-player render work ([91182f2](https://github.com/modenicheng/oh-my-bot/commit/91182f2))
* **protocol:** raise script submission frame limit to 64 KiB ([502419e](https://github.com/modenicheng/oh-my-bot/commit/502419e))


## [1.0.0-beta.1](https://github.com/modenicheng/oh-my-bot/compare/v1.0.0-alpha.3...v1.0.0-beta.1) (2026-10-04)


### Features

* **bot-api:** single-source Monaco declarations, AI prompts, and Go runtime contracts ([62d675b](https://github.com/modenicheng/oh-my-bot/commit/62d675b))
* **bots:** add the Oracle combat bot with route planning and predictive fire control ([dfbb8fc](https://github.com/modenicheng/oh-my-bot/commit/dfbb8fc))
* **protocol:** deliver authoritative simulation tuning and structured control notices ([dbd7c66](https://github.com/modenicheng/oh-my-bot/commit/dbd7c66))
* **protocol:** single-source heartbeat, frame, and replay schema versions across TypeScript and Go ([ceb69bd](https://github.com/modenicheng/oh-my-bot/commit/ceb69bd), [51cec6e](https://github.com/modenicheng/oh-my-bot/commit/51cec6e))
* **script:** preserve JavaScript/TypeScript editor sources through version history and rollback ([4a1dbde](https://github.com/modenicheng/oh-my-bot/commit/4a1dbde))
* **workbench:** add language-aware script versions in an anchored body-portal overlay ([90d5819](https://github.com/modenicheng/oh-my-bot/commit/90d5819))
* **startup:** add a truthful resource-driven character loader with responsive layouts ([0a0177d](https://github.com/modenicheng/oh-my-bot/commit/0a0177d), [11c3cf5](https://github.com/modenicheng/oh-my-bot/commit/11c3cf5))

### Bug Fixes

* **feedback:** keep the camera stationary while hacking ([3c5588d](https://github.com/modenicheng/oh-my-bot/commit/3c5588d))
* **manual:** restore battlefield focus before global shortcuts ([c646a80](https://github.com/modenicheng/oh-my-bot/commit/c646a80))
* **startup:** prevent loading progress and resource text from being selected

### Performance

* **startup:** preload Monaco with splash resources so entering a room adds no editor module waterfall ([cdbeb14](https://github.com/modenicheng/oh-my-bot/commit/cdbeb14))

### Refactoring

* **client:** share Live and Replay spectator controls ([10ec947](https://github.com/modenicheng/oh-my-bot/commit/10ec947))
* **client:** unify takeover state, aim ownership, deterministic hashes, and locked-core fog ([5087ce8](https://github.com/modenicheng/oh-my-bot/commit/5087ce8))
* **server:** deduplicate room launch preparation, runtime assembly, and score ordering ([436f46d](https://github.com/modenicheng/oh-my-bot/commit/436f46d))

## [1.0.0-alpha.3](https://github.com/modenicheng/oh-my-bot/compare/v1.0.0-alpha.2...v1.0.0-alpha.3) (2026-10-04)


### Features

* **bot-api:** expose projectile owner/heading in scan() and add predictive-shield example ([4b03cb0](https://github.com/modenicheng/oh-my-bot/commit/4b03cb0381606b1cfd991863d5bf95c2409182aa))
* **client:** R seizes the turret axis; mouse aim yields to script aim (guard) ([742ff53](https://github.com/modenicheng/oh-my-bot/commit/742ff5315023a4812c11dec671e84c1d1ad2a7da))
* **client:** suppress text selection in main panels and HUD ([421a9b9](https://github.com/modenicheng/oh-my-bot/commit/421a9b9e1d3cb15694305120292f3fab5545860f))
* **game:** improve feedback objectives and map generation ([1301cdc](https://github.com/modenicheng/oh-my-bot/commit/1301cdcf16523e722213b8d607d0646d4ee2bdd7))
* **snippet:** trim catalog to six modules; autoAim becomes pure direct aim ([5bbe31f](https://github.com/modenicheng/oh-my-bot/commit/5bbe31f4f2403a850bbb57fc01806931a47d59db))

### Bug Fixes

* **client:** aim guard engages on local script capability, not turret_src echo ([b62c4d0](https://github.com/modenicheng/oh-my-bot/commit/b62c4d003bac97e076599a338ac9397d9af6ece7))

## [1.0.0-alpha.2](https://github.com/modenicheng/oh-my-bot/compare/v1.0.0-alpha.1...v1.0.0-alpha.2) (2026-10-03)


### Bug Fixes

* **ai:** reread script rev inside the serial section before submit ([4e7e311](https://github.com/modenicheng/oh-my-bot/commit/4e7e311661fd9fb8438f9af4d795f125b44bb206))
* **client:** keep monaco out of vite dep optimizer to prevent double registry load ([#8](https://github.com/modenicheng/oh-my-bot/issues/8)) ([5a5f9f3](https://github.com/modenicheng/oh-my-bot/commit/5a5f9f345b4dcf90b882cb33fdd77c52ded6200c))

## [1.0.0-alpha.1](https://github.com/modenicheng/oh-my-bot/compare/v0.2.0...v1.0.0-alpha.1) (2026-10-03)


### Features

* add snippets AI assistance and deterministic navigation ([4987f14](https://github.com/modenicheng/oh-my-bot/commit/4987f142e3dbde5d082d7c54cad55cf02206d27c))
* **client:** vision fog and defeat camera shake ([2303f0b](https://github.com/modenicheng/oh-my-bot/commit/2303f0bb3d01e30d3512ea68b2b0a7a4e19c6b8a))
* deterministic visual replay export and interpolated playback ([a17429a](https://github.com/modenicheng/oh-my-bot/commit/a17429a638f8d0cd35f83c87fdbbbb4cf726ae34))
* keep room-scoped bot script and assist across matches ([c9ba157](https://github.com/modenicheng/oh-my-bot/commit/c9ba15773c026afc21b01b5c656b512aa802e8f4))
* **server:** honor OMB_CONFIG_DIR for runtime config lookup ([4a64d4f](https://github.com/modenicheng/oh-my-bot/commit/4a64d4f76a4f87f9bc02bd25f152a740aed84242))
* stream AI responses into the workbench panel ([9e4a103](https://github.com/modenicheng/oh-my-bot/commit/9e4a10336e8e1da04f329154a7742f9838683edf))

## [0.2.0](https://github.com/modenicheng/oh-my-bot/compare/v0.1.0...v0.2.0) (2026-10-02)


### Features

* add script console and flat bot API ([965d628](https://github.com/modenicheng/oh-my-bot/commit/965d628896d73e216ab1c538a1483694029616d7))
* **art:** pixel medkit health pack, sized between core and robot ([390ce82](https://github.com/modenicheng/oh-my-bot/commit/390ce823def81bf2b570f8e249327955be0b20ca))
* **bots:** expose static map walls to scripts ([2e7c870](https://github.com/modenicheng/oh-my-bot/commit/2e7c870718fb33e5cab0a80d1321b46085b78ea7))
* **client:** add animated ASCII startup and trusted audio gate ([b68524d](https://github.com/modenicheng/oh-my-bot/commit/b68524d68e4bca7bf829f49cfa97fe27ab87118e))
* **client:** add desktop skill HUD and combat audiovisual feedback ([1e13c8a](https://github.com/modenicheng/oh-my-bot/commit/1e13c8a47afd7d5dbd3f371e9fb5d1d3825705c7))
* **client:** add in-game options and explicit leave ([ee5ca72](https://github.com/modenicheng/oh-my-bot/commit/ee5ca7247237135f32ae1dd60b87572d69c2cf37))
* **client:** add read-only live room spectator view ([f5f5bd9](https://github.com/modenicheng/oh-my-bot/commit/f5f5bd9c66db4f9b9995ed1d3e3525b180a2c6a8))
* **client:** add read-only recorded spectator view ([c7d0a8e](https://github.com/modenicheng/oh-my-bot/commit/c7d0a8e91a462095fb22954ed4800caa3ff02716))
* **client:** add read-only recorded spectator view ([6e9d363](https://github.com/modenicheng/oh-my-bot/commit/6e9d363af867ab95ff5eb779f4bbd53b053b3bb3))
* **client:** add stacked manual and script editor sidebar ([ad4d39f](https://github.com/modenicheng/oh-my-bot/commit/ad4d39fcda3ab1f574ce3e89c27f7f496000c8fb))
* **client:** announce match events with pixel banners and audio cues ([dfc4625](https://github.com/modenicheng/oh-my-bot/commit/dfc4625c1149814ea17d4088dec93b07c284b545))
* **client:** compile TypeScript bots before submit ([4768de5](https://github.com/modenicheng/oh-my-bot/commit/4768de58ed14b6f67120fc41385444b1249950d6))
* **client:** complete health pack and title experience ([21a334d](https://github.com/modenicheng/oh-my-bot/commit/21a334dbe6063ba3a71e5140e925f8df01535446))
* **client:** focus game controls and resize the coding sidebar ([8132902](https://github.com/modenicheng/oh-my-bot/commit/81329022f462330777db4b2926880b9e77e7a88c))
* **client:** integrate scoreboards and stage music in modular app ([6294ca7](https://github.com/modenicheng/oh-my-bot/commit/6294ca791dfd6a6312cb8efe99cc9d8de9266e24))
* **client:** make script console DevTools-like ([a2e0745](https://github.com/modenicheng/oh-my-bot/commit/a2e0745df8fc6eef53775e919c90cd4cd68d8b50))
* **client:** per-axis manual takeover HUD and single-Space restore ([180b610](https://github.com/modenicheng/oh-my-bot/commit/180b610d20a2ab5d3fc101fdc3e401d186120b75))
* **combat:** replace partners with damage-share attribution ([e22b231](https://github.com/modenicheng/oh-my-bot/commit/e22b23153380b6902585600e44ea800ea39905c4))
* **control:** make bot intent tick-scoped and dash held ([07035fe](https://github.com/modenicheng/oh-my-bot/commit/07035fe7b6e0f730b8ac990e3429c6feac6070b6))
* **game:** add host-controlled scripted test opponents ([7147954](https://github.com/modenicheng/oh-my-bot/commit/7147954aa37a5ceef2ebcf5f7fc9ea520d015bdc))
* **gameplay:** add deterministic health packs ([a883dfa](https://github.com/modenicheng/oh-my-bot/commit/a883dfaac739b3c06f305c11d72dce1f01ae3c54))
* hot-reload dev loop (vite /ws proxy, disk FS overrides, air) ([cb2e4ef](https://github.com/modenicheng/oh-my-bot/commit/cb2e4ef734d94665e9bebd4d4e832a3b377480e3))
* **manual:** add generated visual gallery ([f50aafd](https://github.com/modenicheng/oh-my-bot/commit/f50aafdcf24fd583a28c8a4fb960f9cffa42959a))
* **manual:** add navigation frontmatter metadata foundation ([a7ff4ce](https://github.com/modenicheng/oh-my-bot/commit/a7ff4cefecad8ac2b5bff2898ab2ebbab682301d))
* **manual:** parse tag/tags/order frontmatter and show tags on page title ([0cc1f3d](https://github.com/modenicheng/oh-my-bot/commit/0cc1f3dfc3d00bf2e09087880ecdcaedfcf1153d))
* **map:** add inner cover and denser core refresh ([73b9e16](https://github.com/modenicheng/oh-my-bot/commit/73b9e164a2f738fea685e0686981c32d26741473))
* **mapgen:** two-piece L cover silhouettes in gen4 ([fe598d1](https://github.com/modenicheng/oh-my-bot/commit/fe598d12cd62349c9bb38eebeaae5f8f6b3e350b))
* **music:** quantize stage switches to beat/bar boundaries ([f7fc36d](https://github.com/modenicheng/oh-my-bot/commit/f7fc36d3358b7aedd0414b9c520080716e533e45))
* **protocol:** add read-only spectator join message ([3278600](https://github.com/modenicheng/oh-my-bot/commit/3278600c4bef50d1a823ecc07482ff423cf3b62e))
* **protocol:** carry projectile visual color metadata ([7b5b306](https://github.com/modenicheng/oh-my-bot/commit/7b5b306c0ee16b4ecaab9b6a388fa633b1a719d2))
* **protocol:** integrate authoritative live scoreboard foundation ([93cdf3b](https://github.com/modenicheng/oh-my-bot/commit/93cdf3bbe37c663a53c4092982f1ecf5a2d041f3))
* **replay:** restore checkpoints and replay authoritative logs ([b8cb828](https://github.com/modenicheng/oh-my-bot/commit/b8cb828f1f7fbef0dfa3999e3e480b12091e28e9))
* **server:** add isolated read-only live spectator feed ([8044782](https://github.com/modenicheng/oh-my-bot/commit/80447822f8dd5b288449cc858ad67b0ff6dfcb78))
* **server:** default to loopback and support unix listeners ([0f0f023](https://github.com/modenicheng/oh-my-bot/commit/0f0f023dba3d39e03fe92504cf58cc6811e9f2ff))
* **server:** queue manual say with shared cooldown and replay records ([e406705](https://github.com/modenicheng/oh-my-bot/commit/e406705dce7b11eab8ec8fcaf3cf929a46ffde2d))
* **sim:** add bounded damped robot contact impulses ([d9655a8](https://github.com/modenicheng/oh-my-bot/commit/d9655a83d9b553dc17d3e4edff0911c3c5591bbb))
* **sim:** add tangential collision sliding and authoritative skill feedback ([e8349a1](https://github.com/modenicheng/oh-my-bot/commit/e8349a1e7ef884e08ab7d425e6d5cdd091c4d723))
* **sim:** fine-grained manual takeover with single-Space restore ([955647e](https://github.com/modenicheng/oh-my-bot/commit/955647ec33354e3e94b84050e78d2cab47d42b3e))
* **sim:** swept circle pickup for cores and health packs ([fb07b59](https://github.com/modenicheng/oh-my-bot/commit/fb07b59053d71dde05c9556adc98ad369c5a4dcc))


### Bug Fixes

* **client:** harden live spectator recovery and narrow layouts ([e521f27](https://github.com/modenicheng/oh-my-bot/commit/e521f2770245e1bd784bd93ee19c461834aeba60))
* **client:** keep released controls neutral ([45e9a7c](https://github.com/modenicheng/oh-my-bot/commit/45e9a7c8393ca27caa662dfa23e6edb3755b7d0d))
* **dash:** require release after energy exhaustion ([0297657](https://github.com/modenicheng/oh-my-bot/commit/029765713dc8be9226bfea640305f82ddb1c9a47))
* expose health packs in bot runtime ([26e0b6d](https://github.com/modenicheng/oh-my-bot/commit/26e0b6d3ebef7569faf45e8ddde06285b0a782c0))
* **gameplay:** preserve projectile colors and avoid static walls ([d23dcf7](https://github.com/modenicheng/oh-my-bot/commit/d23dcf78cbf78059387f8e82ea864c77ee33e8d3))
* harden script console delivery ([f7b4660](https://github.com/modenicheng/oh-my-bot/commit/f7b46604ef8ced1f6362b9a8f110eb2f0bf73c60))
* **mapgen:** constrain overlap exemptions to sibling pieces ([ca3e6c5](https://github.com/modenicheng/oh-my-bot/commit/ca3e6c58e1f626a12ec6e67558bb3c3176b5e633))
* **music:** adapt synth engine to strict client TypeScript ([c0dfdb4](https://github.com/modenicheng/oh-my-bot/commit/c0dfdb45ff5dd674a28dd21523e4d7116e195970))
* **music:** duplicate pending stage request keeps original schedule ([7da40c1](https://github.com/modenicheng/oh-my-bot/commit/7da40c1eb9df90b94623957fcac80a822b3da9ec))
* **net:** reconnect room sessions with bounded backoff and liveness checks ([47df783](https://github.com/modenicheng/oh-my-bot/commit/47df7834134e16437d6d482e53ce037efd50d52f))
* **replay:** persist identities and final settled match ([c9a8996](https://github.com/modenicheng/oh-my-bot/commit/c9a8996f1a4830a4ef016a0225ca78b3f1bb1e4c))
* **replay:** reject inconsistent checkpoints and sequence regression ([42ee370](https://github.com/modenicheng/oh-my-bot/commit/42ee3709c2c4645ba2c0c6bfcea97a7a593858f3))
* **replay:** sample input-only tails after health events ([7a1c45d](https://github.com/modenicheng/oh-my-bot/commit/7a1c45df0418e963ae38b8c71bc78524467983d4))
* **script:** expose static walls in scan() and make solo bots steer around walls ([b321f81](https://github.com/modenicheng/oh-my-bot/commit/b321f8141b68ce6217b495eb937825c43d42047d))
* **script:** freeze deadline results before returning from collection ([637613c](https://github.com/modenicheng/oh-my-bot/commit/637613c11e56450409beef598d3fb4bff856ff75))
* **script:** remove runtime console drop limits ([0567b7d](https://github.com/modenicheng/oh-my-bot/commit/0567b7d7a69ec2faa4d6ce9acf1e4dabffe914ee))
* **server:** preserve pulse vision and complete replay sinks ([463e36e](https://github.com/modenicheng/oh-my-bot/commit/463e36e41bfcbdd5d20030cff2bf7d67c61e8f9f))
* **sim:** block pickup through locked zones and cover ([6ff31db](https://github.com/modenicheng/oh-my-bot/commit/6ff31db44a7ae7323893a0ab6fdec792b0597a46))
* **sim:** Space clears same-tick in-flight takeover; add live takeover check ([b4e89eb](https://github.com/modenicheng/oh-my-bot/commit/b4e89eb65b810afd720c843f3036cceaf24d660c))
* **sim:** stabilize damage shares and validate health bounds ([ff689ae](https://github.com/modenicheng/oh-my-bot/commit/ff689ae4aab8aeac7e98e761c1aae9033b07c588))
* stabilize arena sessions and refresh the game UI ([4ee8469](https://github.com/modenicheng/oh-my-bot/commit/4ee84694d1240a5acf8b1ba442b12e91c299c95d))

## [Unreleased]

- 历史 `v0.1.0` tag 作为 release-please 基线；后续 release PR 从该 tag 之后的提交生成。
