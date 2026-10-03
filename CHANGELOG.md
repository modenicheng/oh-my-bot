# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0-alpha.2](https://github.com/modenicheng/oh-my-bot/compare/v1.0.0-alpha.2...v1.1.0-alpha.2) (2026-10-03)


### Features

* **bot-api:** expose projectile owner/heading in scan() and add predictive-shield example ([4b03cb0](https://github.com/modenicheng/oh-my-bot/commit/4b03cb0381606b1cfd991863d5bf95c2409182aa))
* **client:** R seizes the turret axis; mouse aim yields to script aim (guard) ([742ff53](https://github.com/modenicheng/oh-my-bot/commit/742ff5315023a4812c11dec671e84c1d1ad2a7da))
* **snippet:** trim catalog to six modules; autoAim becomes pure direct aim ([5bbe31f](https://github.com/modenicheng/oh-my-bot/commit/5bbe31f4f2403a850bbb57fc01806931a47d59db))


### Bug Fixes

* **client:** aim guard engages on local script capability, not turret_src echo ([b62c4d0](https://github.com/modenicheng/oh-my-bot/commit/b62c4d003bac97e076599a338ac9397d9af6ece7))


### Performance Improvements

* **client:** cut per-frame allocations and shrink the first-screen bundle ([cb35c9e](https://github.com/modenicheng/oh-my-bot/commit/cb35c9e37377c3f7ef99c854d8da96904909d48b))
* **server:** root-cause script frame allocs and make GC tunable (ADR-0015) ([b60d086](https://github.com/modenicheng/oh-my-bot/commit/b60d0862a1c1af1916af6c9aa2a69ee96f7a6567))

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
