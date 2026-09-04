# Changelog

## [0.7.0](https://github.com/stefanpantic/local-review-vscode-extension/compare/agentic-review-v0.6.0...agentic-review-v0.7.0) (2026-09-04)


### Features

* add emoji reactions to comments ([#75](https://github.com/stefanpantic/local-review-vscode-extension/issues/75)) ([bc276b5](https://github.com/stefanpantic/local-review-vscode-extension/commit/bc276b5bbc3d38f2f6b76bff4133bea2ce6474a4))


### Bug Fixes

* let an agent revise its own comments after they are submitted ([#69](https://github.com/stefanpantic/local-review-vscode-extension/issues/69)) ([e6f5f48](https://github.com/stefanpantic/local-review-vscode-extension/commit/e6f5f4820d81404f527743f0a555cc1b2677bce7))

## [0.6.0](https://github.com/stefanpantic/local-review-vscode-extension/compare/agentic-review-v0.5.0...agentic-review-v0.6.0) (2026-08-11)


### Features

* include the pull request description and commits in get_diff ([#67](https://github.com/stefanpantic/local-review-vscode-extension/issues/67)) ([2b8c753](https://github.com/stefanpantic/local-review-vscode-extension/commit/2b8c7534ed0b992de2df14cef010b7e13bb40366))

## [0.5.0](https://github.com/stefanpantic/local-review-vscode-extension/compare/agentic-review-v0.4.2...agentic-review-v0.5.0) (2026-08-09)


### Features

* filter, sort, and group review comments ([#61](https://github.com/stefanpantic/local-review-vscode-extension/issues/61)) ([01edf22](https://github.com/stefanpantic/local-review-vscode-extension/commit/01edf22456ce501a73700bc7d82a1e008ec89fe3))


### Bug Fixes

* refresh pull request metadata on sync and fix second reviews ([#66](https://github.com/stefanpantic/local-review-vscode-extension/issues/66)) ([bdc9c6a](https://github.com/stefanpantic/local-review-vscode-extension/commit/bdc9c6a04c224ae56417df80fa23fc711671c9bc))

## [0.4.2](https://github.com/stefanpantic/local-review-vscode-extension/compare/agentic-review-v0.4.1...agentic-review-v0.4.2) (2026-07-31)


### Bug Fixes

* stop a build from reloading the review ([#56](https://github.com/stefanpantic/local-review-vscode-extension/issues/56)) ([70bd2ed](https://github.com/stefanpantic/local-review-vscode-extension/commit/70bd2ed71a7234d274edcd09ff4662635b962e88))

## [0.4.1](https://github.com/stefanpantic/local-review-vscode-extension/compare/agentic-review-v0.4.0...agentic-review-v0.4.1) (2026-07-30)


### Bug Fixes

* wrap suggestion code in comments so the diff tint covers long lines ([#53](https://github.com/stefanpantic/local-review-vscode-extension/issues/53)) ([b32a5b7](https://github.com/stefanpantic/local-review-vscode-extension/commit/b32a5b748c45ead263fca96dfc25273e483c8ccc))

## [0.4.0](https://github.com/stefanpantic/local-review-vscode-extension/compare/agentic-review-v0.3.1...agentic-review-v0.4.0) (2026-07-29)


### Features

* let an agent edit and delete its own review comments over MCP ([#50](https://github.com/stefanpantic/local-review-vscode-extension/issues/50)) ([813fd00](https://github.com/stefanpantic/local-review-vscode-extension/commit/813fd00c7b8210550c7fc93fb40c74a0a551b4ea))


### Bug Fixes

* flag comments that sit in an unsubmitted GitHub review ([#49](https://github.com/stefanpantic/local-review-vscode-extension/issues/49)) ([165027a](https://github.com/stefanpantic/local-review-vscode-extension/commit/165027a79ee7f73d724120485ac3767cbaf086e9))

## [0.3.1](https://github.com/stefanpantic/local-review-vscode-extension/compare/agentic-review-v0.3.0...agentic-review-v0.3.1) (2026-07-28)


### Bug Fixes

* match team review requests in the pull request filter ([#47](https://github.com/stefanpantic/local-review-vscode-extension/issues/47)) ([367bc7c](https://github.com/stefanpantic/local-review-vscode-extension/commit/367bc7cd3f1c3967ff2ebf859b660ed94d30929a))

## [0.3.0](https://github.com/stefanpantic/local-review-vscode-extension/compare/agentic-review-v0.2.0...agentic-review-v0.3.0) (2026-07-28)


### Features

* filter the pull request list ([#45](https://github.com/stefanpantic/local-review-vscode-extension/issues/45)) ([55e6a2a](https://github.com/stefanpantic/local-review-vscode-extension/commit/55e6a2a6fffb2d98571b9195a1f55ca1ce28b515))

## [0.2.0](https://github.com/stefanpantic/local-review-vscode-extension/compare/agentic-review-v0.1.0...agentic-review-v0.2.0) (2026-07-27)


### Features

* find in the diff with Ctrl+F ([#43](https://github.com/stefanpantic/local-review-vscode-extension/issues/43)) ([676a512](https://github.com/stefanpantic/local-review-vscode-extension/commit/676a512a93ca9e350aeef2363a388811f69a8e80))


### Bug Fixes

* highlight Kotlin and other unregistered languages in the diff ([#42](https://github.com/stefanpantic/local-review-vscode-extension/issues/42)) ([7cf1248](https://github.com/stefanpantic/local-review-vscode-extension/commit/7cf1248e3bc7c37ef4aede1c50eb0fea55aeaad4))

## [0.1.0](https://github.com/stefanpantic/local-review-vscode-extension/compare/agentic-review-v0.0.8...agentic-review-v0.1.0) (2026-07-27)


### Features

* harden GitHub pull request write-back and sync ([#39](https://github.com/stefanpantic/local-review-vscode-extension/issues/39)) ([cbe7eec](https://github.com/stefanpantic/local-review-vscode-extension/commit/cbe7eec4ae308b3dc5aa5d6c509cb7c1fb4b9f6e))
* rename the extension to ReviewMate ([#40](https://github.com/stefanpantic/local-review-vscode-extension/issues/40)) ([11dfd82](https://github.com/stefanpantic/local-review-vscode-extension/commit/11dfd823a5fdda81e8e08865b7fb992111d322f4))
* review GitHub pull requests locally ([#34](https://github.com/stefanpantic/local-review-vscode-extension/issues/34)) ([e4e5b30](https://github.com/stefanpantic/local-review-vscode-extension/commit/e4e5b3001252ae277b553ed1804111b80333cf0d))
* write your pull request review back to GitHub ([#36](https://github.com/stefanpantic/local-review-vscode-extension/issues/36)) ([284dbb5](https://github.com/stefanpantic/local-review-vscode-extension/commit/284dbb543b5753fac3e332ba2daf14966d0df570))

## [0.0.8](https://github.com/stefanpantic/local-review-vscode-extension/compare/agentic-review-v0.0.7...agentic-review-v0.0.8) (2026-07-10)


### Features

* badge only unviewed files so the count tracks review progress ([#28](https://github.com/stefanpantic/local-review-vscode-extension/issues/28)) ([6fda14d](https://github.com/stefanpantic/local-review-vscode-extension/commit/6fda14d350baf6b6545dd4ae6e98734d5680eb99))

## [0.0.7](https://github.com/stefanpantic/local-review-vscode-extension/compare/agentic-review-v0.0.6...agentic-review-v0.0.7) (2026-07-08)


### Features

* badge the activity-bar icon with the changed-file count ([#26](https://github.com/stefanpantic/local-review-vscode-extension/issues/26)) ([f0c2b27](https://github.com/stefanpantic/local-review-vscode-extension/commit/f0c2b27a30e70a95b848f93b96d6dde05ee72e2b))

## [0.0.6](https://github.com/stefanpantic/local-review-vscode-extension/compare/agentic-review-v0.0.5...agentic-review-v0.0.6) (2026-07-06)


### Bug Fixes

* sort sidebar comments by line and focus outdated comments on click ([#24](https://github.com/stefanpantic/local-review-vscode-extension/issues/24)) ([9f18099](https://github.com/stefanpantic/local-review-vscode-extension/commit/9f1809968c7cd4da1393638da4067df24d0d249f))

## [0.0.5](https://github.com/stefanpantic/local-review-vscode-extension/compare/agentic-review-v0.0.4...agentic-review-v0.0.5) (2026-07-06)


### Features

* wrap-lines toggle and whole-diff horizontal scrolling ([#21](https://github.com/stefanpantic/local-review-vscode-extension/issues/21)) ([a2dd31b](https://github.com/stefanpantic/local-review-vscode-extension/commit/a2dd31b5e4aa9b31e4edc0d60964fac4cdfd637a))


### Bug Fixes

* update hero image ([#23](https://github.com/stefanpantic/local-review-vscode-extension/issues/23)) ([220ff09](https://github.com/stefanpantic/local-review-vscode-extension/commit/220ff093bc8cbd6d63321ffba13eb6e51fd9e6f6))

## [0.0.4](https://github.com/stefanpantic/local-review-vscode-extension/compare/agentic-review-v0.0.3...agentic-review-v0.0.4) (2026-07-05)


### Features

* add iteration 1 foundation (unified local diff) ([f69c08e](https://github.com/stefanpantic/local-review-vscode-extension/commit/f69c08ec5b5ffe56dce5211d8205a550373cfabb))
* add iteration 2 (diff sources, navigation, viewed-collapse) ([969835c](https://github.com/stefanpantic/local-review-vscode-extension/commit/969835cacff3acd1c7720bbe7908243d3e869c32))
* add iteration 3 (split view, whitespace toggle, syntax highlighting) ([1ecba96](https://github.com/stefanpantic/local-review-vscode-extension/commit/1ecba96e354d61376f675520dd54c33fd67b5bfa))
* add iteration 4 (inline commenting, line drift, comments sidebar) ([975fc0c](https://github.com/stefanpantic/local-review-vscode-extension/commit/975fc0c5e2d57d0d15227256f2974bf90d7c8d3a))
* add iteration 4b (block comments & suggestions) ([5da7d08](https://github.com/stefanpantic/local-review-vscode-extension/commit/5da7d08b622f49e59e6ed460791c840428a9daf1))
* add iteration 5 (branch-tied review sessions) ([c59e91a](https://github.com/stefanpantic/local-review-vscode-extension/commit/c59e91a7e677a5217552a042965eecc829a533ee))
* add iteration 6 (structured Markdown export) ([e9cc9a7](https://github.com/stefanpantic/local-review-vscode-extension/commit/e9cc9a7fc5d5df54162fdbe3adaf1be195cc2ebd))
* add iteration 7 (intra-line diff, expand/collapse context, auto-refresh, keyboard nav) ([5ab12f1](https://github.com/stefanpantic/local-review-vscode-extension/commit/5ab12f1bbaea31f4608931b5e6ad941643429ee9))
* add tooling, CI/CD and project docs ([d5957cd](https://github.com/stefanpantic/local-review-vscode-extension/commit/d5957cd824a2ab9933aeb167787ebaefaf6ea161))
* agentic integration via in-process MCP server ([#4](https://github.com/stefanpantic/local-review-vscode-extension/issues/4)) ([677ec92](https://github.com/stefanpantic/local-review-vscode-extension/commit/677ec927cd378f3a83d5dcf25a7298bf86153630))
* make MCP setup client-agnostic ([#6](https://github.com/stefanpantic/local-review-vscode-extension/issues/6)) ([d2abb12](https://github.com/stefanpantic/local-review-vscode-extension/commit/d2abb12b29f1b5f3f3d81bdd68ed2c6f2d42a970))
* publish to the VS Code Marketplace ([#17](https://github.com/stefanpantic/local-review-vscode-extension/issues/17)) ([57a3a41](https://github.com/stefanpantic/local-review-vscode-extension/commit/57a3a41d786a8ea621e0f6cac2ada92e0123f1df))


### Bug Fixes

* remove em-dashes from user-facing text ([#7](https://github.com/stefanpantic/local-review-vscode-extension/issues/7)) ([9529f34](https://github.com/stefanpantic/local-review-vscode-extension/commit/9529f34c0c1fd8ea11a9c30d4163461a9caa9590))
* rename the extension to Agentic Review ([#18](https://github.com/stefanpantic/local-review-vscode-extension/issues/18)) ([0b64120](https://github.com/stefanpantic/local-review-vscode-extension/commit/0b6412030a15f8443a211649fb97610f4a77c514))
* source-aware empty states, aligned source picker, tree-matched order ([c1185d5](https://github.com/stefanpantic/local-review-vscode-extension/commit/c1185d583b38fa4867e7cbe94a38ced00f41f6e7))

## [0.0.3](https://github.com/stefanpantic/local-review-vscode-extension/compare/local-review-v0.0.2...local-review-v0.0.3) (2026-07-05)


### Features

* agentic integration via in-process MCP server ([#4](https://github.com/stefanpantic/local-review-vscode-extension/issues/4)) ([677ec92](https://github.com/stefanpantic/local-review-vscode-extension/commit/677ec927cd378f3a83d5dcf25a7298bf86153630))
* make MCP setup client-agnostic ([#6](https://github.com/stefanpantic/local-review-vscode-extension/issues/6)) ([d2abb12](https://github.com/stefanpantic/local-review-vscode-extension/commit/d2abb12b29f1b5f3f3d81bdd68ed2c6f2d42a970))
* publish to the VS Code Marketplace ([#17](https://github.com/stefanpantic/local-review-vscode-extension/issues/17)) ([57a3a41](https://github.com/stefanpantic/local-review-vscode-extension/commit/57a3a41d786a8ea621e0f6cac2ada92e0123f1df))


### Bug Fixes

* remove em-dashes from user-facing text ([#7](https://github.com/stefanpantic/local-review-vscode-extension/issues/7)) ([9529f34](https://github.com/stefanpantic/local-review-vscode-extension/commit/9529f34c0c1fd8ea11a9c30d4163461a9caa9590))

## [0.0.2](https://github.com/stefanpantic/local-review-vscode-extension/compare/local-review-v0.0.1...local-review-v0.0.2) (2026-07-04)


### Features

* add iteration 1 foundation (unified local diff) ([f69c08e](https://github.com/stefanpantic/local-review-vscode-extension/commit/f69c08ec5b5ffe56dce5211d8205a550373cfabb))
* add iteration 2 (diff sources, navigation, viewed-collapse) ([969835c](https://github.com/stefanpantic/local-review-vscode-extension/commit/969835cacff3acd1c7720bbe7908243d3e869c32))
* add iteration 3 (split view, whitespace toggle, syntax highlighting) ([1ecba96](https://github.com/stefanpantic/local-review-vscode-extension/commit/1ecba96e354d61376f675520dd54c33fd67b5bfa))
* add iteration 4 (inline commenting, line drift, comments sidebar) ([975fc0c](https://github.com/stefanpantic/local-review-vscode-extension/commit/975fc0c5e2d57d0d15227256f2974bf90d7c8d3a))
* add iteration 4b (block comments & suggestions) ([5da7d08](https://github.com/stefanpantic/local-review-vscode-extension/commit/5da7d08b622f49e59e6ed460791c840428a9daf1))
* add iteration 5 (branch-tied review sessions) ([c59e91a](https://github.com/stefanpantic/local-review-vscode-extension/commit/c59e91a7e677a5217552a042965eecc829a533ee))
* add iteration 6 (structured Markdown export) ([e9cc9a7](https://github.com/stefanpantic/local-review-vscode-extension/commit/e9cc9a7fc5d5df54162fdbe3adaf1be195cc2ebd))
* add iteration 7 (intra-line diff, expand/collapse context, auto-refresh, keyboard nav) ([5ab12f1](https://github.com/stefanpantic/local-review-vscode-extension/commit/5ab12f1bbaea31f4608931b5e6ad941643429ee9))
* add tooling, CI/CD and project docs ([d5957cd](https://github.com/stefanpantic/local-review-vscode-extension/commit/d5957cd824a2ab9933aeb167787ebaefaf6ea161))


### Bug Fixes

* source-aware empty states, aligned source picker, tree-matched order ([c1185d5](https://github.com/stefanpantic/local-review-vscode-extension/commit/c1185d583b38fa4867e7cbe94a38ced00f41f6e7))
