# Changelog

## [0.12.1](https://github.com/ahembree/librariarr/compare/v0.12.0...v0.12.1) (2026-04-04)


### Bug Fixes

* scrolling bug fixes ([dd32bca](https://github.com/ahembree/librariarr/commit/dd32bca7f6bce0737f0cdef3343a3b6f5eb5ea9e))
* scrolling fixes ([4613671](https://github.com/ahembree/librariarr/commit/46136712493c402914b8cf45f11eecd671d6af66))

## [0.12.0](https://github.com/ahembree/librariarr/compare/v0.11.3...v0.12.0) (2026-04-04)


### Features

* add card hover popover ([06f06ca](https://github.com/ahembree/librariarr/commit/06f06caf951ed2dd5f0a482627203ae7670db2f8))
* **lifecycle:** add toast and Discord notifications for failed manual actions ([532c8e0](https://github.com/ahembree/librariarr/commit/532c8e0166e205880ecf23dbc5ed60c1bec51871))
* **settings:** add changelog/release notes to System tab ([e3eb02b](https://github.com/ahembree/librariarr/commit/e3eb02ba10790360ac8d1e14f717406309cf0e3d))
* **settings:** show last 10 versions in changelog ([81dfb87](https://github.com/ahembree/librariarr/commit/81dfb87bd102bc2fb65687e37805ce17a43d9fcf))
* update and standardize styling ([35fe4c3](https://github.com/ahembree/librariarr/commit/35fe4c370ce8bb07826b1207371de4a56a09ee16))
* update and standardize styling ([1a6b6c1](https://github.com/ahembree/librariarr/commit/1a6b6c11a7e50ea29c1df5a951d1b019b7a8dfe1))


### Bug Fixes

* allow macOS trackpad swipe-back navigation ([7ad5252](https://github.com/ahembree/librariarr/commit/7ad52521168ea80f3671f9a0695d5aba722066f4))
* change quality chips to a barfor standard sizing ([656ba7a](https://github.com/ahembree/librariarr/commit/656ba7a23f38af78543af34354ff714b18869589))
* clear sync jobs on start ([d65f34a](https://github.com/ahembree/librariarr/commit/d65f34ae4f007ded6ce4f232028d0fb521f3b634))
* **dashboard:** add appCache mock to stats test and invalidate on server delete ([f380998](https://github.com/ahembree/librariarr/commit/f38099882e98ed97a31f1d34cae12e6b76636530))
* **dashboard:** fix Promise.all type safety and cache key for stats ([49fd8b5](https://github.com/ahembree/librariarr/commit/49fd8b53fa7f3c397e0242e2db9e12dc3d05b3bf))
* increase card content height to show all metadata ([c8c12df](https://github.com/ahembree/librariarr/commit/c8c12df27df5391fe457b6566c676d537f51d165))
* **lifecycle:** fix failure notification bugs in manual execution ([12c2d85](https://github.com/ahembree/librariarr/commit/12c2d85184796834e8b79ae5dcb548eb12dc0a22))
* **lifecycle:** fix failure notification bugs in manual execution ([5cd4ee5](https://github.com/ahembree/librariarr/commit/5cd4ee571d8dfddc6362ed9f636f9cd58fb09439))
* mount postgres volume to /var/lib/postgresql and remove PGDATA env var ([5c201ec](https://github.com/ahembree/librariarr/commit/5c201ecc07e3da568697dd8b24871e8b7d1c9e9b))
* override CardHeader gap to prevent metadata clipping ([ea2e9bf](https://github.com/ahembree/librariarr/commit/ea2e9bf21bbe3729aac461bd5c36dbd0c4e4a2be))
* prevent broken momentum scrolling after back-navigation on mobile ([c2a9754](https://github.com/ahembree/librariarr/commit/c2a97542ea9593c03defa0a2b8b7b46d0f2f1884))
* **settings:** handle release-please markdown format in changelog ([7620e4c](https://github.com/ahembree/librariarr/commit/7620e4cf3163450b6aa83025cae10d603c902a3f))
* standardize card heights and remove useStatusBarScroll ([4f06794](https://github.com/ahembree/librariarr/commit/4f06794e6b553cf43e6bb94f978a386e12a28d5e))


### Performance Improvements

* **dashboard:** cache stats API and parallelize all DB queries ([5f1d8fd](https://github.com/ahembree/librariarr/commit/5f1d8fda0c1893835a071599346c2971b3e162a7))

## [0.11.3](https://github.com/ahembree/librariarr/compare/v0.11.2...v0.11.3) (2026-04-02)


### Performance Improvements

* add missing indexes to MediaItem for frequently-filtered fields ([2719c59](https://github.com/ahembree/librariarr/commit/2719c590bafbde0f934ac345c5bb91501f3ac845))
* add missing indexes to MediaItem schema ([f1cc41f](https://github.com/ahembree/librariarr/commit/f1cc41ffbc4a9921a290f2e4acf86b7881122b24))

## [0.11.2](https://github.com/ahembree/librariarr/compare/v0.11.1...v0.11.2) (2026-04-02)


### Bug Fixes

* **lifecycle:** only set lastPlayedAt when playCount &gt; 0 ([a16f286](https://github.com/ahembree/librariarr/commit/a16f2865718b63294e222bd386c7b58b3c0027bf))

## [0.11.1](https://github.com/ahembree/librariarr/compare/v0.11.0...v0.11.1) (2026-03-30)


### Bug Fixes

* dockerhub updates and force update image ([dae0186](https://github.com/ahembree/librariarr/commit/dae01860e07a785fc56439f0e95bd6735ddd3bbe))
* dockerhub updates and force update image ([2758e12](https://github.com/ahembree/librariarr/commit/2758e122734c7c6d0a34087771d84dca68b945ed))

## [0.11.0](https://github.com/ahembree/librariarr/compare/v0.10.0...v0.11.0) (2026-03-30)


### Features

* **docs:** improve hero and docs site styling to match app theme ([8abd327](https://github.com/ahembree/librariarr/commit/8abd327afedcda5d6861526b113ea267bda907b8))
* migrate to pnpm ([f897b67](https://github.com/ahembree/librariarr/commit/f897b67af68366ae4f5589f668f36c0fea5de3d6))
* migrate to pnpm ([bfba350](https://github.com/ahembree/librariarr/commit/bfba3501bf3bc99849f3177c84743ef96cb53a8f))


### Bug Fixes

* **backup:** clear active sync jobs when restoring from backup ([03e1d37](https://github.com/ahembree/librariarr/commit/03e1d37d8e930aabe258df51d6d69bd3e995fe3f))
* **docs:** add text labels to nav icons, fix sidebar, remove colored title ([3054eab](https://github.com/ahembree/librariarr/commit/3054eabc6ae8df4520a9a4ac17addb3e2a731d19))
* momentum scroll on mobile ([0b74d88](https://github.com/ahembree/librariarr/commit/0b74d88f20159726e6a0bc7bbdb267c2363e50e5))

## [0.10.0](https://github.com/ahembree/librariarr/compare/v0.9.1...v0.10.0) (2026-03-30)


### Features

* add Docker security hardening to compose files ([d53d498](https://github.com/ahembree/librariarr/commit/d53d4988ec7a3d55476f1b890f0f8d0408b11069))
* add Unraid compatibility ([694e465](https://github.com/ahembree/librariarr/commit/694e46588549c6d89fec953e770cfd5478523e41))
* **lifecycle:** improve exclusions with reason prompts, collection removal, manual add, and edit ([87eec70](https://github.com/ahembree/librariarr/commit/87eec70190dcd626b4535ff6b53d6ee155c53930))


### Bug Fixes

* default UMASK to 022 and always disable Next.js telemetry ([466994a](https://github.com/ahembree/librariarr/commit/466994a824a725b2594313298896570bd65f8409))
* preserve backward-compatible PostgreSQL volume mount path ([8d06269](https://github.com/ahembree/librariarr/commit/8d0626919ff46c58d66abe68cf85500123024dcc))
* use official PostgreSQL PGDATA subdirectory pattern ([5802b83](https://github.com/ahembree/librariarr/commit/5802b8356bd81e0602cc0f0f007aece9ddf44ae4))

## [0.9.1](https://github.com/ahembree/librariarr/compare/v0.9.0...v0.9.1) (2026-03-30)


### Bug Fixes

* fix play-url with external URL specified ([7ae83a6](https://github.com/ahembree/librariarr/commit/7ae83a6113b34bec96f8f2e5f96ed85157d5c15f))
* ui updates ([b8a1ed1](https://github.com/ahembree/librariarr/commit/b8a1ed1631e0ec84e3c6d11eccbe98006cc222db))

## [0.9.0](https://github.com/ahembree/librariarr/compare/v0.8.0...v0.9.0) (2026-03-29)


### Features

* ui updates ([5fc65a3](https://github.com/ahembree/librariarr/commit/5fc65a3139d6de875849958f66653d1499fb26f1))
* ui updates ([2324518](https://github.com/ahembree/librariarr/commit/232451892a0dfba86023223e39f8ca121a7451a4))


### Bug Fixes

* run frontend-builder skill ([eaa077c](https://github.com/ahembree/librariarr/commit/eaa077cadbfc97d586d4b782052f5d9244e82f5e))

## [0.8.0](https://github.com/ahembree/librariarr/compare/v0.7.0...v0.8.0) (2026-03-28)


### Features

* add seed data ([0d575f2](https://github.com/ahembree/librariarr/commit/0d575f2fd4ba255808754171c3a036c3f55f23b6))


### Bug Fixes

* dedup top play history ([e4666b6](https://github.com/ahembree/librariarr/commit/e4666b64938298ffe89d63343f681c9a3efe8610))
* fix lifecycle rule card rendering ([f60a569](https://github.com/ahembree/librariarr/commit/f60a5693979ec83c02cda6896dbe27feffff5f23))
* fix play history with multiple media servers ([d2bdfbf](https://github.com/ahembree/librariarr/commit/d2bdfbf4722a46cfa77cac9f4c0baa1fec235f36))
* lint issue in seed.ts ([501a4b9](https://github.com/ahembree/librariarr/commit/501a4b964a076dca2fe5adb192365357228ac46e))

## [0.7.0](https://github.com/ahembree/librariarr/compare/v0.6.0...v0.7.0) (2026-03-27)


### Features

* update hero page nav logo to new SVG design ([0b3534f](https://github.com/ahembree/librariarr/commit/0b3534f15b128c48e7f5c8b5d418e31dd1429818))
* update hero page nav logo to new SVG design ([01d0e6a](https://github.com/ahembree/librariarr/commit/01d0e6a5442b125ca555a3269fb2df588b177993))


### Bug Fixes

* update logo sizing ([c5772e6](https://github.com/ahembree/librariarr/commit/c5772e658d4525275de49d7f9eade8011f18888d))
* update logo sizing ([2d65daf](https://github.com/ahembree/librariarr/commit/2d65daf8adb5b3967e2de4f793067b91afc9f9a3))

## [0.6.0](https://github.com/ahembree/librariarr/compare/v0.5.2...v0.6.0) (2026-03-27)


### Features

* update logo to new SVG design ([78e3409](https://github.com/ahembree/librariarr/commit/78e3409a7795a1ce57e5653c254f183134996f11))

## [0.5.2](https://github.com/ahembree/librariarr/compare/v0.5.1...v0.5.2) (2026-03-27)


### Bug Fixes

* ci build ([8e0df82](https://github.com/ahembree/librariarr/commit/8e0df82c5fdd18d42587a125f171cf6ef506a274))
* cleanup log level selector ([27a167a](https://github.com/ahembree/librariarr/commit/27a167aa7db346b2d773c42f7400f8cd416e8e6f))
* cleanup logging ([7825a96](https://github.com/ahembree/librariarr/commit/7825a96879e7d7224af63591b1b04ae6d4d0dc6c))
* identify lifecycle diff that caused item to lose match ([ffaee8b](https://github.com/ahembree/librariarr/commit/ffaee8bb7670e768d2b6a64ec4de37212a25b422))
* improve log retention ([2bd73d8](https://github.com/ahembree/librariarr/commit/2bd73d89acd5b5af50f20f3cbd41a4f161753731))
* most played series click now navs to series item ([316a3bc](https://github.com/ahembree/librariarr/commit/316a3bccd6f7a37ac4a357d0de1c8404827d44bc))
* update sidebar ([daf31f2](https://github.com/ahembree/librariarr/commit/daf31f24ad264fa8734428775bb8e45aa1db6534))

## [0.5.1](https://github.com/ahembree/librariarr/compare/v0.5.0...v0.5.1) (2026-03-26)


### Bug Fixes

* add preset edit control ([d42a4f1](https://github.com/ahembree/librariarr/commit/d42a4f1fbb79cfd9f5dc9e37df0f62cf0755b766))

## [0.5.0](https://github.com/ahembree/librariarr/compare/v0.4.0...v0.5.0) (2026-03-25)


### Features

* **auth:** auto-generate SESSION_SECRET when not configured ([846e789](https://github.com/ahembree/librariarr/commit/846e7892e1047af869eb00be3f02a21ad2b53d0b))
* **auth:** auto-generate SESSION_SECRET when not configured ([cc3bcbb](https://github.com/ahembree/librariarr/commit/cc3bcbb7a58f374cac921e62ad3463fe9c4ce31f))


### Bug Fixes

* **auth:** use correct logger signature for session secret messages ([c5ba213](https://github.com/ahembree/librariarr/commit/c5ba213f2694606d2a879e8934b2eeaf605987df))

## [0.4.0](https://github.com/ahembree/librariarr/compare/v0.3.1...v0.4.0) (2026-03-20)


### Features

* new dashboard timeline card, fix dashboard UI bugs ([448017e](https://github.com/ahembree/librariarr/commit/448017e8768458faa95ea724ddcf01ac073474d9))
* new dashboard timeline card, fix dashboard UI bugs ([187d2ad](https://github.com/ahembree/librariarr/commit/187d2ad1b0fe5b3891fdf99bb991489873a62327))

## [0.3.1](https://github.com/ahembree/librariarr/compare/v0.3.0...v0.3.1) (2026-03-20)


### Bug Fixes

* fix invalid migration file ([0d1d49f](https://github.com/ahembree/librariarr/commit/0d1d49fd67ad4360f0bc51c4d9062515388bff36))
* resolve restore from config-only backup issue ([b39cc33](https://github.com/ahembree/librariarr/commit/b39cc3363c03bddd0c92cb3c90c056fe7361466e))
* sanitize restore messages ([682ea37](https://github.com/ahembree/librariarr/commit/682ea3743c3aa7fb1ccbfd2cfbced2b7c6a72798))

## [0.3.0](https://github.com/ahembree/librariarr/compare/v0.2.4...v0.3.0) (2026-03-19)


### Features

* add emby and jellyfin to onboard flow ([c777f53](https://github.com/ahembree/librariarr/commit/c777f53b194add2aea69eb07b7e7b42464b1e013))

## [0.2.4](https://github.com/ahembree/librariarr/compare/v0.2.3...v0.2.4) (2026-03-19)


### Bug Fixes

* preroll clear button ([c85f89f](https://github.com/ahembree/librariarr/commit/c85f89f52e0a2606f803a3f7cd140b3e8b275e48))
* various preroll bugs ([269ce96](https://github.com/ahembree/librariarr/commit/269ce96591bd6be5bd3cdcea59c44bee3130e35f))

## [0.2.3](https://github.com/ahembree/librariarr/compare/v0.2.2...v0.2.3) (2026-03-19)


### Bug Fixes

* **lint:** set explicit React version for ESLint 10 compatibility ([54fbf00](https://github.com/ahembree/librariarr/commit/54fbf005c6eae5d402b91726545e9439a9d61118))

## [0.2.2](https://github.com/ahembree/librariarr/compare/v0.2.1...v0.2.2) (2026-03-19)


### Bug Fixes

* split arm64 and amd64 builds ([e57ca98](https://github.com/ahembree/librariarr/commit/e57ca98e060c7491eb70e6238602e9e346eae138))
* split arm64 and amd64 builds ([f4377f5](https://github.com/ahembree/librariarr/commit/f4377f58aec051dac74175a8f657a38677ff8ffb))

## [0.2.1](https://github.com/ahembree/librariarr/compare/v0.2.0...v0.2.1) (2026-03-19)


### Bug Fixes

* fix enforcement tests ([8d9ef16](https://github.com/ahembree/librariarr/commit/8d9ef16522c8e57e415103fd177553a5588b8e63))
* resolve docker image build and push when new tag comes from other action ([12aec83](https://github.com/ahembree/librariarr/commit/12aec83f17178e6e46de86891c9c2bc219e001e7))

## [0.2.0](https://github.com/ahembree/librariarr/compare/v0.1.1...v0.2.0) (2026-03-19)


### Features

* add update checker ([864cb55](https://github.com/ahembree/librariarr/commit/864cb55700288753186cc39c4c767d812534e097))


### Bug Fixes

* fix flaky enforcer test ([bc4f075](https://github.com/ahembree/librariarr/commit/bc4f075c94618023d3a08813e0d1e2b630354ab2))

## [0.1.1](https://github.com/ahembree/librariarr/compare/v0.1.0...v0.1.1) (2026-03-19)


### Bug Fixes

* downgrade eslint ([b56eb51](https://github.com/ahembree/librariarr/commit/b56eb517a0aa1babd993ace365b3d5407cd3370b))
* downgrade eslint ([5e33d26](https://github.com/ahembree/librariarr/commit/5e33d26de073e69465607004aa3a26c0558e608b))
