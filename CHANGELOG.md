# Changelog

## [0.25.1](https://github.com/ahembree/librariarr/compare/v0.25.0...v0.25.1) (2026-06-24)


### Bug Fixes

* **lifecycle:** fix progress bar and seerr gating ([3bd6926](https://github.com/ahembree/librariarr/commit/3bd69261ac48a9af16705f94834ecf547cf49070))
* **lifecycle:** fix progress bar and seerr gating ([9a9f88c](https://github.com/ahembree/librariarr/commit/9a9f88cfc5c0b97bbe989ca6a10b19446c321955))

## [0.25.0](https://github.com/ahembree/librariarr/compare/v0.24.0...v0.25.0) (2026-06-17)


### Features

* **lifecycle:** re-fire a reconfigured action without recreating the rule ([2f75a40](https://github.com/ahembree/librariarr/commit/2f75a40657fbf3051738dcfe31a15c6241d823b6))


### Bug Fixes

* **lifecycle:** cleanup pending actions on stale/removed content ([bc4e301](https://github.com/ahembree/librariarr/commit/bc4e301cbae2623c2c46e7b337f09c63b536a3da))
* **lifecycle:** cleanup pending actions on stale/removed content ([55a72db](https://github.com/ahembree/librariarr/commit/55a72db1912cda1c7ddfb81c92f357a754eeb678))
* **lifecycle:** count delete matches with a prior non-delete action in stats ([71d7c1e](https://github.com/ahembree/librariarr/commit/71d7c1eac1e263b3facc48bb9749ec4f1dfeacd7))
* **lifecycle:** re-schedule actions for re-added items ([3fe7adf](https://github.com/ahembree/librariarr/commit/3fe7adf980c626540a7123a3b865cf60e4dd1c2c))
* **lifecycle:** scope completed-action re-schedule guard to action type ([7f3a6a8](https://github.com/ahembree/librariarr/commit/7f3a6a811da30c86fbe227d21eadaebc3f785169))
* **lifecycle:** sync pending actions when a rule's action changes ([1d8cf8a](https://github.com/ahembree/librariarr/commit/1d8cf8a7507fba99fa40b7b2beb08a7ba8da3c08))

## [0.24.0](https://github.com/ahembree/librariarr/compare/v0.23.0...v0.24.0) (2026-06-15)


### Features

* **lifecycle:** color media-type chips on matches & pending pages ([3a9db99](https://github.com/ahembree/librariarr/commit/3a9db99be49fd9887dee4b9db0634ec728242d3b))
* **query:** show total and selected result sizes ([fabf671](https://github.com/ahembree/librariarr/commit/fabf6711fd4b43be86df96fda7f6daead4efa195))


### Bug Fixes

* **lifecycle:** close series/episode action-targeting gaps in query + detection ([5142262](https://github.com/ahembree/librariarr/commit/5142262c9305e233ffc4613bf6028cda376db0e6))
* **lifecycle:** correct Sonarr series rating mapping ([bf9efb1](https://github.com/ahembree/librariarr/commit/bf9efb1e492718e9e4299d8872c98262910a2b99))
* **lifecycle:** fail-closed NULL handling for Arr rule fields ([6db4167](https://github.com/ahembree/librariarr/commit/6db4167cbbe8a2dc10628a2c5d3e5746d6748fa8))
* **lifecycle:** read Radarr quality cutoff from nested movieFile ([d7971d8](https://github.com/ahembree/librariarr/commit/d7971d891310895c126113027720de21eec5c2c8))
* **lifecycle:** restrict series members to matching episodes for seriesScope=false + aggregate ([d2fed24](https://github.com/ahembree/librariarr/commit/d2fed24a61f48ca7bc953d83b85b1d5c9d287027))
* **lifecycle:** stop year guard blocking valid series episode deletes ([9c48ece](https://github.com/ahembree/librariarr/commit/9c48ece2f9b67a899dfb1bc9c518f8831cd60295))
* **query:** evaluate series-aggregate fields in episode view; count whole-series deletes ([6878a1a](https://github.com/ahembree/librariarr/commit/6878a1adbcae5df3e604fb8de9e52d7fd2d1d7de))
* **query:** rename local plural label map to avoid shared-name collision ([dd7905d](https://github.com/ahembree/librariarr/commit/dd7905d42c95f950cd76a154b11de6c9eb749659))
* **sync:** never persist episode-level TVDB ids as a series id ([fc33975](https://github.com/ahembree/librariarr/commit/fc33975d81f70227d56255d99ed2569f3f80cc33))

## [0.23.0](https://github.com/ahembree/librariarr/compare/v0.22.0...v0.23.0) (2026-06-14)


### Features

* **builder:** group-level NOT and negation folded into the operator picker ([da48955](https://github.com/ahembree/librariarr/commit/da48955722ab7df7fc759101da706cb306174024))
* **builder:** make rule logic legible without changing how rules evaluate ([210297f](https://github.com/ahembree/librariarr/commit/210297ff842a8774696ba359b7c86650ab5132b5))
* **dashboard:** add hover tooltips to library tile sparklines ([a10877e](https://github.com/ahembree/librariarr/commit/a10877e8d0c2475278b350b6d8a29d487f6c1bf5))
* **dashboard:** apply overhaul design language to hero and KPI cards ([fbab513](https://github.com/ahembree/librariarr/commit/fbab513decb928e3d3b12925be3c711f279b3b77))
* **dashboard:** name unreachable instances on the integrations tile ([ca74797](https://github.com/ahembree/librariarr/commit/ca7479774ef858bc0fce8e2a9dcfb9a597ab690e))
* **dashboard:** rework Recently Added into a poster shelf ([3674640](https://github.com/ahembree/librariarr/commit/3674640e8a88f8066838b797c8af255f22ff3bf4))
* **dashboard:** rework the dashboard into purpose-built zones ([9c46804](https://github.com/ahembree/librariarr/commit/9c46804911d6b2056b60aa988965caa7704b3888))
* **dashboard:** show library size over time on the size tile sparkline ([502dac6](https://github.com/ahembree/librariarr/commit/502dac6f8e6622239127ef4995264720f8580b00))
* **dashboard:** unify and rework all insight cards ([51cf360](https://github.com/ahembree/librariarr/commit/51cf36099f6e3670d0aa779ccd0d4268ca31eb25))
* **detail:** mono field grids and eyebrow section headers ([243558b](https://github.com/ahembree/librariarr/commit/243558b6b8405d7ac55cef3906933ffd576260f0))
* **library:** align media-card hover and radius with the handoff ([1daacb2](https://github.com/ahembree/librariarr/commit/1daacb221b26ca4632534c96c92e3e3fab58aa96))
* **library:** align the detail pages with the design system ([3090048](https://github.com/ahembree/librariarr/commit/30900480373cf7cfcc5b350e87e4ed329a73cdc7))
* **library:** brand-accent active state on the view toggle ([4a2f3b1](https://github.com/ahembree/librariarr/commit/4a2f3b1c33d89e935be7fbb8ca9e8bcb2ba7b2b8))
* **library:** rework the browse experience across all library pages ([d86e66f](https://github.com/ahembree/librariarr/commit/d86e66f3c100eeff8aafbbd9d2a9f9515c144985))
* **lifecycle:** allow deleting a collection from its last rule ([b8c539b](https://github.com/ahembree/librariarr/commit/b8c539b68556451a42422130de15eea142cb64c4))
* **lifecycle:** delete collections, guarded against in-use ([90069e1](https://github.com/ahembree/librariarr/commit/90069e157f55562f0d4bf6e4825e8e77667d1947))
* **lifecycle:** merge multiple rules into shared Plex collections ([5f390fe](https://github.com/ahembree/librariarr/commit/5f390fea5c0ef3c2a3889b50f0f2f817ac674f4e))
* **lifecycle:** unify chrome across the lifecycle pages ([0b6e46a](https://github.com/ahembree/librariarr/commit/0b6e46a4d1b9dd0a3ef32a079475ceb1cefdf4d6))
* **logs:** convert log view to the handoff mono console ([92c2b10](https://github.com/ahembree/librariarr/commit/92c2b10b546eee828001b4101914d02160159654))
* **logs:** replace loading spinner with console-shaped skeleton ([a31379a](https://github.com/ahembree/librariarr/commit/a31379a29dc4269e4c1c258bf41b3ccb5a6f2fab))
* **mobile:** add bottom tab bar and PWA safe-area support ([9576360](https://github.com/ahembree/librariarr/commit/957636090008a7436068cae11a809fdcf5b73903))
* **mobile:** remove the bottom tab bar in favor of the drawer ([6f0d019](https://github.com/ahembree/librariarr/commit/6f0d019d0d3bd2811c348ff600f36e8312d0ea77))
* **query:** add select-all toggle for card view results ([6fddd60](https://github.com/ahembree/librariarr/commit/6fddd6079c9d5ffc684f8c016c46b8dbec5ed144))
* **query:** determinate fetch sub-progress + redesigned phase bar ([4193ce3](https://github.com/ahembree/librariarr/commit/4193ce3fc7386bcca7741cbe9f0e6f44c8f889e0))
* **query:** keep an unsaved query draft across navigation ([a7d1046](https://github.com/ahembree/librariarr/commit/a7d1046592d1303238ed7361f156072d83e9a960))
* **query:** narrate the action "Validating selection" phase ([60d24e9](https://github.com/ahembree/librariarr/commit/60d24e9097630c351be473c94ec050db63997c6e))
* **query:** offer search-after for quality profile changes in the action bar ([f6a5cda](https://github.com/ahembree/librariarr/commit/f6a5cda463f764b0362cff98ae4c8288b48e3f38))
* **query:** show per-item count and live sub-step in action progress ([5a10fca](https://github.com/ahembree/librariarr/commit/5a10fca2d7613111811b7e688b3e1f610e263cc8))
* **query:** stream live progress bar for query-page actions ([1881ecc](https://github.com/ahembree/librariarr/commit/1881ecc7032d6e69bf61e1f921a614174a7b16a1))
* **query:** stream phase progress for query and rule preview ([16ecb06](https://github.com/ahembree/librariarr/commit/16ecb06626a0aa35d99089345e9dffc2eadcc314))
* **rules:** add Custom Format Score criterion for query and rule builders ([155887c](https://github.com/ahembree/librariarr/commit/155887ca609ee51a731a0e3f674389585c8eeb8f))
* **search:** polish the search palette modal ([4d89977](https://github.com/ahembree/librariarr/commit/4d89977efbfebe24b0b9c615311716e847550f67))
* **search:** replace sidebar query link with a global title search palette ([3b16d8b](https://github.com/ahembree/librariarr/commit/3b16d8b8b0fc0c6488104d7a3aa5eae350522911))
* **settings:** add SetRow/SettingsSection primitives; convert 2 tabs ([880be41](https://github.com/ahembree/librariarr/commit/880be41d3792013521e9ba75a041cb18dafe994e))
* **settings:** confirm destructive actions and surface mutation feedback ([af45055](https://github.com/ahembree/librariarr/commit/af45055f256763c4ad4b8e1d09e9540e58ec84a2))
* **settings:** convert General tab to SettingsSection ([de95c23](https://github.com/ahembree/librariarr/commit/de95c234778b0195c8e8acf61f34f7af09810182))
* **settings:** convert System and Authentication tabs to SettingsSection ([ad553b0](https://github.com/ahembree/librariarr/commit/ad553b02d8c5f2ea277a9496dcfbaa05f20eab53))
* **settings:** sticky 2-col sub-nav layout per the handoff ([1aafe70](https://github.com/ahembree/librariarr/commit/1aafe7019598122c43de3dc92b728fcfe9aa87ea))
* **streams:** redesign the active session cards ([bfa137d](https://github.com/ahembree/librariarr/commit/bfa137d5b76ceabb9de035813e3e08f4058547be))
* **tables:** mono-uppercase headers per the handoff ([ba2fd18](https://github.com/ahembree/librariarr/commit/ba2fd18babcd39251f84c73f93908c63e566f8ae))
* **tools:** align Streams/Prerolls amber states to the design token ([5532fdb](https://github.com/ahembree/librariarr/commit/5532fdb5099b31f0f68098351a76a0242772a7c1))
* **ui:** accent backdrops (login/onboarding) + rules group spine ([86c2c92](https://github.com/ahembree/librariarr/commit/86c2c92c3e7e0f37b75d4be663f857e7feee9259))
* **ui:** accent underline on active tab ([cd54cbc](https://github.com/ahembree/librariarr/commit/cd54cbc91c3dcd6e4c7c72827b6ee32fa08fe9e8))
* **ui:** accent-primary buttons/toggles + mono pending headers ([1dd6730](https://github.com/ahembree/librariarr/commit/1dd6730a190e93d1bc058364a6c2e12c9f75cb2e))
* **ui:** align lifecycle status colors to design tokens ([00f432c](https://github.com/ahembree/librariarr/commit/00f432cb4ef3c33574de75f484225f637ad24092))
* **ui:** align semantic warning/success/info colors to tokens ([59b94d3](https://github.com/ahembree/librariarr/commit/59b94d3200dbd227e2ca0c3049852672d1e8aff6))
* **ui:** align status-indicator colors to design tokens ([541db56](https://github.com/ahembree/librariarr/commit/541db56dfdb035960cd9c72a5e99d5f8c4817603))
* **ui:** establish overhaul design tokens and rebuild app shell ([44bf3e8](https://github.com/ahembree/librariarr/commit/44bf3e80db91e352059d08599be5e2a054bf3895))
* **ui:** expand toast coverage and make toasts mobile-friendly ([5d21606](https://github.com/ahembree/librariarr/commit/5d216067fad78aca8d095574b34e8c6cc16c672d))
* **ui:** remove the bell shortcut from the topbar ([9ed35b3](https://github.com/ahembree/librariarr/commit/9ed35b3866cf8be1ca2e9464d873dacb806bca45))
* **ui:** rework the media hover popover into a cinematic card ([49c5797](https://github.com/ahembree/librariarr/commit/49c5797ac9cecb96652442d04967b4bd82516a1e))


### Bug Fixes

* **a11y:** add accessible names to icon buttons and aria-sort to tables ([f60c0de](https://github.com/ahembree/librariarr/commit/f60c0de3ecda704c4784d5f92bf494775f767585))
* address medium/low-severity findings and CI/Docker hardening ([f26ee28](https://github.com/ahembree/librariarr/commit/f26ee28cd643c236445dc3fa98edb73f210aa318))
* bound image-cache disk growth + document lifecycle behaviors ([e6cd31d](https://github.com/ahembree/librariarr/commit/e6cd31d79bd70c45c52e6cbc0b05a5ffbe4eda57))
* **cache,validation:** centralize media cache invalidation; validate test-connection body ([72bcd19](https://github.com/ahembree/librariarr/commit/72bcd19fbe36860d3aaa69c08139384265a7d005))
* comprehensive bug-fix sweep across sync, lifecycle, media, integrations, UI ([75032b1](https://github.com/ahembree/librariarr/commit/75032b1e6b9a29a28ff97dc2a1a2e9be3dc247c6))
* **core:** harden cache, sanitize, validation, discord; add lifecycle indexes ([1276c12](https://github.com/ahembree/librariarr/commit/1276c12d0d5dab06d070e253c7f7c1576d1c6ddb))
* **dashboard:** resolve bug-hunt findings across the dashboard ([06c32e5](https://github.com/ahembree/librariarr/commit/06c32e5f5a5e81d999a7e0a6289542cf73174e0e))
* **dashboard:** restore hover popovers and accent propagation ([78f1307](https://github.com/ahembree/librariarr/commit/78f13079d6f8ba8e2d0ab422a2e1d6e504a6c3d9))
* **deps:** repair pnpm-lock.yaml duplicate key breaking frozen install ([e010612](https://github.com/ahembree/librariarr/commit/e010612cf774759cacbead60cde15e4dd60baa2e))
* **e2e:** drop postgres tmpfs mount that breaks postgres:18 ([f3dc25e](https://github.com/ahembree/librariarr/commit/f3dc25e8e8e943c716d99a1abcb7cb08c4c0db75))
* **e2e:** make the Playwright suite actually run + pass (validated with a real browser) ([445df96](https://github.com/ahembree/librariarr/commit/445df964286dc2fb5e01c0bf1924ed0de9a6130c))
* **e2e:** reach the app over 127.0.0.1 so Chromium doesn't force HTTPS ([b82b539](https://github.com/ahembree/librariarr/commit/b82b53974f8a1f877d0e920fd45c94de7bc8c2e2))
* **e2e:** wait for the setup button instead of a one-shot visibility check ([38b1cd2](https://github.com/ahembree/librariarr/commit/38b1cd2e583d8edf46dcef38de8b8f7bf242ca42))
* **engine:** close fail-open and phase-divergence bugs found in the deep audit ([13add00](https://github.com/ahembree/librariarr/commit/13add006e13c8ff4a96b8cfe21c3ea49164a03e9))
* **engine:** close remaining genre, hasExternalId, and select-gap fail-opens ([480041a](https://github.com/ahembree/librariarr/commit/480041a0ee2404e63dcdeba4fead2a1c459080be))
* **engine:** resolve all remaining audit findings across both engines ([38396ae](https://github.com/ahembree/librariarr/commit/38396aeeb945e1ec02ff3eb34df2689636d96f68))
* frontend medium/low-severity findings ([dbeb076](https://github.com/ahembree/librariarr/commit/dbeb0768f7a9a4986d5dc333374bf2f3faf8aca9))
* **jobs:** clear orphaned queue locks on boot so syncs survive a restart ([2615ced](https://github.com/ahembree/librariarr/commit/2615ced82532d8ed725976b497d38fff76a896f5))
* **library:** keep the filter toolbar sticky on desktop only ([3c46957](https://github.com/ahembree/librariarr/commit/3c469578eaa5431c66b9621a2ff81174e54ce2c8))
* **lifecycle:** close wrong-target and over-scope hazards in action execution ([292abc8](https://github.com/ahembree/librariarr/commit/292abc8a01615e52a054f66e22708f47abd8fae5))
* **lifecycle:** let the rules page scroll as one unit ([b58039d](https://github.com/ahembree/librariarr/commit/b58039d37b66867f7028813442f842e86dd22a07))
* **lifecycle:** populate Radarr custom format score for rule/query criteria ([77690b5](https://github.com/ahembree/librariarr/commit/77690b52d006dd2b1965ab3abeb83d5d25d8eac0))
* **lifecycle:** validate action configs and gate retries on exceptions ([8f798fd](https://github.com/ahembree/librariarr/commit/8f798fd962e39de6415876a32d3e9b8970b87ae2))
* **mobile:** library header layout and a hidden horizontal overflow ([036b14d](https://github.com/ahembree/librariarr/commit/036b14de5e28b9f6d7437107852aa9a4993eeada))
* **mobile:** stop the logout tooltip persisting when the drawer opens ([187c524](https://github.com/ahembree/librariarr/commit/187c52497eb81343cfeed55cf611356097e0630e))
* **query:** address review findings in action progress bar ([873d91c](https://github.com/ahembree/librariarr/commit/873d91ca3157630f476abe6691fdb568fe978e53))
* **query:** checkbox spacing, table hover, and add search action ([04774ff](https://github.com/ahembree/librariarr/commit/04774ff051ba6fd339ae0dff2742ef8fcc16e8ed))
* **query:** evaluate series-aggregate comparisons instead of always failing ([9783898](https://github.com/ahembree/librariarr/commit/97838984a186ddf2e1a92ad6db3a1adab42de827))
* **query:** support the between operator for numeric Arr criteria ([a2274ee](https://github.com/ahembree/librariarr/commit/a2274ee5eea4b9ce86534397310fe85a5aa761fb))
* relax node engines constraint to floor-only (&gt;=22) ([1432ec3](https://github.com/ahembree/librariarr/commit/1432ec34cf63a5b23dd3d122d87118be4f9e4bf6))
* resolve critical sync overflow and high-severity data-loss bugs ([d15a5e3](https://github.com/ahembree/librariarr/commit/d15a5e32572f5520068dff1f8f12b2369b836164))
* **search:** stop iOS zoom and focus theft breaking the mobile palette ([bce3716](https://github.com/ahembree/librariarr/commit/bce371615f9f109193010cdcee48e637dd8dfffc))
* **settings:** mobile tab scrolling, ARIA wiring, and chrome alignment ([ab10141](https://github.com/ahembree/librariarr/commit/ab10141ccc7633bfaf9ddf46c473eed11b636b68))
* **shell:** read sidebar collapse from a cookie and spotlight hovered groups ([654c3d4](https://github.com/ahembree/librariarr/commit/654c3d422135d4ec5617dea66d5da9ed2b5bfc3c))
* **skills:** correct stale commands and versions in Claude skills ([cb040a9](https://github.com/ahembree/librariarr/commit/cb040a93d3eef7ccac54f8cf405572dfa1ead51e))
* **test:** use Promise.resolve around WorkerUtils.release() ([8cba1e2](https://github.com/ahembree/librariarr/commit/8cba1e2bca3a32136fe03a98d67c6d0559febdc0))
* **ui:** correct toast attribution and false-success edge cases ([836c8c3](https://github.com/ahembree/librariarr/commit/836c8c3be919cf81f56bc6941b939decf0d67a33))
* **ui:** keep dialogs and popovers scrollable instead of clipped on mobile ([69e7a7d](https://github.com/ahembree/librariarr/commit/69e7a7d861e3a8c9042c54d02cc2c095c7395fce))
* watch-history full-replace exceeds the 5s transaction timeout ([066000a](https://github.com/ahembree/librariarr/commit/066000a8737d17478b9744176a960b2d7b5e9ad5))


### Reverts

* **library:** restore stacked icon metadata rows on media cards ([3696263](https://github.com/ahembree/librariarr/commit/3696263d851c99d375c12adddf5ff64dded6aa26))
* **ui:** restore the original palette and typography ([63c97c7](https://github.com/ahembree/librariarr/commit/63c97c7e1cc95f5591a148a09d5ccf63d23e1b4a))

## [0.22.0](https://github.com/ahembree/librariarr/compare/v0.21.0...v0.22.0) (2026-06-10)


### Features

* **jobs:** migrate background work to Graphile Worker ([75008a0](https://github.com/ahembree/librariarr/commit/75008a06a220f0f451ffafa04c96a2e1a345d5f0))


### Bug Fixes

* **jobs:** address bugs found in deep review ([ed571e9](https://github.com/ahembree/librariarr/commit/ed571e916bc8adf29e0e65b142b358ce432edf24))
* **settings:** refresh "Last run" timestamps after Run Now ([30ebe78](https://github.com/ahembree/librariarr/commit/30ebe78179bfe472f483a54e6fb3524446b5096c))
* **settings:** Run Now syncs all servers instead of aborting on first error ([09cf5e9](https://github.com/ahembree/librariarr/commit/09cf5e97ff12bd035dae95550c12537c1ba938da))

## [0.21.0](https://github.com/ahembree/librariarr/compare/v0.20.0...v0.21.0) (2026-06-07)


### Features

* **query:** always show the actions bar above results ([0291b8f](https://github.com/ahembree/librariarr/commit/0291b8f984578ab3bf260be2557b68e346d5e92d))
* **query:** redesign the query scope controls ([7f9af61](https://github.com/ahembree/librariarr/commit/7f9af613741bb6f901ba901a49d10bd877eda694))
* **query:** trigger lifecycle actions from the query page ([e6ef4f3](https://github.com/ahembree/librariarr/commit/e6ef4f32236750fa684d48d080223fca9e6fe65b))
* **rules:** server-side enforcement of field library-type validity ([ffcf03d](https://github.com/ahembree/librariarr/commit/ffcf03d73bd52a5562465f04c45ba70c221b575c))


### Bug Fixes

* **lifecycle:** merge media distinct-values instead of replacing ([4188a48](https://github.com/ahembree/librariarr/commit/4188a482d07d9413a1eca21f001971eaa76a23bb))
* **lifecycle:** populate Requested By Seerr dropdown reliably ([295d4f2](https://github.com/ahembree/librariarr/commit/295d4f236a21a2a6499e29f041e7259c04dab607))
* **lifecycle:** populate Requested By Seerr dropdown reliably ([c0a991d](https://github.com/ahembree/librariarr/commit/c0a991dfd038a29251ccd3f4fa285fd509eb16ca))
* **query:** correct grouped-series resolution and action validation ([b4c5403](https://github.com/ahembree/librariarr/commit/b4c5403b77a9e0564a589f99b3b686fbda9f8c3c))
* **query:** honor episode exceptions and tidy ad-hoc action bar state ([3e1dbad](https://github.com/ahembree/librariarr/commit/3e1dbad54ff1575a407c437dabdb6a89cda473be))
* **rules:** gate all type-specific Arr fields to their valid library types ([684f65f](https://github.com/ahembree/librariarr/commit/684f65f84f7bf4b5275bb3974c502782cec28d0e))
* **rules:** gate type-specific arr fields and populate arrStatus everywhere ([76b545e](https://github.com/ahembree/librariarr/commit/76b545ef80fce510b06616e511373811df013513))
* **rules:** populate all enumerable criteria dropdowns ([d6ee87f](https://github.com/ahembree/librariarr/commit/d6ee87f391e3e7eb5a4d3c2777f4083779abadd5))

## [0.20.0](https://github.com/ahembree/librariarr/compare/v0.19.0...v0.20.0) (2026-05-30)


### Features

* **rules:** add watchedByUser criterion for rule and query builders ([17be16d](https://github.com/ahembree/librariarr/commit/17be16deee7d0963c93c2bff4ad05efe4c19dbe8))
* **rules:** add watchedByUser criterion for rule and query builders ([e9b29e9](https://github.com/ahembree/librariarr/commit/e9b29e93a2e69aa614ae6438bb022de116f6b9e5))


### Bug Fixes

* **favicon:** serve favicon, apple-touch icon, and PWA manifest ([f903446](https://github.com/ahembree/librariarr/commit/f9034463849f73bea775a87a392e638095bb27eb))
* **logo:** import the SVG as an asset for content-hashed caching ([1ac1a8d](https://github.com/ahembree/librariarr/commit/1ac1a8d6dc5bf61baaf7e842a4432e99ed2e92e3))
* **proxy:** anchor static-asset bypass patterns ([454ee13](https://github.com/ahembree/librariarr/commit/454ee1343cc8f4fcba7cbf23373e07bcdff1d5e0))
* **pwa:** align splash colour, broaden iOS support, harden manifest ([129c3a8](https://github.com/ahembree/librariarr/commit/129c3a80110400751fcaa825cc545448df68c62d))
* **rules:** close watchedByUser correctness and isolation gaps ([439b3d8](https://github.com/ahembree/librariarr/commit/439b3d8903602a0795dfbdd9efa68dc84d026b99))
* **types:** declare *.svg module for type-check in CI ([2440075](https://github.com/ahembree/librariarr/commit/2440075d2fa506f43496184fd7c7a1c13b6be56c))


### Reverts

* drop multi-tenant defensiveness from distinct-values ([3e166db](https://github.com/ahembree/librariarr/commit/3e166db53fb2b2c4b5c8280006a45b318cb6fef7))

## [0.19.0](https://github.com/ahembree/librariarr/compare/v0.18.2...v0.19.0) (2026-05-23)


### Features

* **dashboard:** add Seerr request stats card ([c98188c](https://github.com/ahembree/librariarr/commit/c98188c03507a0d162668a66a74f0177e8246c65))
* **dashboard:** drill into a user's Seerr requests with library links ([a87f822](https://github.com/ahembree/librariarr/commit/a87f8226ccf9e468b43439759107ed042c8ecfd4))
* **dashboard:** redesign Seerr request stats card ([e28997a](https://github.com/ahembree/librariarr/commit/e28997aa463e46305043f34b5379ac640c10c9ea))
* **dashboard:** split Seerr watch % into movie, series, and overall ([d508988](https://github.com/ahembree/librariarr/commit/d508988ae79f9e33a3e2d45050c666e6da9a97ef))
* **query:** create rule from query ([5ec46d4](https://github.com/ahembree/librariarr/commit/5ec46d4b69b12e08e44a15c022f236be11f8e7ef))


### Bug Fixes

* **dashboard:** bug-fix pass on Seerr request stats card and modal ([3f5ca60](https://github.com/ahembree/librariarr/commit/3f5ca6061d417d0dfb9bce28c8de6e1ec24fbf29))
* **dashboard:** force Seerr requests modal to 75vw ([8ea528e](https://github.com/ahembree/librariarr/commit/8ea528ebd9ac966a1f57cbbe1479df0870e310b7))
* **dashboard:** resolve series via any canonical episode ([6217500](https://github.com/ahembree/librariarr/commit/6217500b74a956d6fd9b79fd91f9b6a81aab3abb))
* **dashboard:** show series request links and posters correctly ([28f7421](https://github.com/ahembree/librariarr/commit/28f7421fa8ce4e0d02c9d0b28e76e6d1b4922599))
* **query:** add value gate to rule conversion ([8179790](https://github.com/ahembree/librariarr/commit/8179790c1d724867dcd8fd6e89753b89f45c589a))
* **query:** query-to-rule conversion bug fixes ([58c04ec](https://github.com/ahembree/librariarr/commit/58c04ec46c5a82d9182982670c109084c916948f))
* **query:** query-to-rule conversion bug fixes ([4fbcbb3](https://github.com/ahembree/librariarr/commit/4fbcbb39fccb4e3b2296fe437c1b458c3f84ff45))

## [0.18.2](https://github.com/ahembree/librariarr/compare/v0.18.1...v0.18.2) (2026-05-22)


### Bug Fixes

* **builder:** guard against empty-string values in enumerable dropdowns ([298817d](https://github.com/ahembree/librariarr/commit/298817d578b62cdae3a67fd26b2cf2fe26d90504))
* **lifecycle:** context-aware Arr-missing tooltip in rule builder ([0986fb1](https://github.com/ahembree/librariarr/commit/0986fb1e19868cbc8a9eb78bffcb427eb9732c0e))
* **query:** align stream-query Phase 1/Phase 2 with rule engine ([e48bbf9](https://github.com/ahembree/librariarr/commit/e48bbf9d6b4c48a44bafb7f0b51c1e625e721b21))

## [0.18.1](https://github.com/ahembree/librariarr/compare/v0.18.0...v0.18.1) (2026-05-21)


### Bug Fixes

* **lifecycle:** snapshot title on manually executed actions ([57438a0](https://github.com/ahembree/librariarr/commit/57438a02483229f69358f34660ea5b4734b5d1a6))
* **tests:** use valid media item type in lifecycle action title test ([6b41476](https://github.com/ahembree/librariarr/commit/6b414767baa51136ee97501c158abb8c804b38dd))

## [0.18.0](https://github.com/ahembree/librariarr/compare/v0.17.1...v0.18.0) (2026-05-21)


### Features

* **lifecycle:** add Change Quality Profile action for Arr apps ([9bd2ad9](https://github.com/ahembree/librariarr/commit/9bd2ad97a743926374c821435ea4c64b561327e0))
* **lifecycle:** add Change Quality Profile action for Arr apps ([1ce9f61](https://github.com/ahembree/librariarr/commit/1ce9f61af9215ce4beade2316431d676a12c09b9))
* **lifecycle:** trigger Arr search after quality profile change ([36e7b9d](https://github.com/ahembree/librariarr/commit/36e7b9db1b7b56ea6317c19f3d1ffac7a842d6d1))


### Bug Fixes

* add additional guards and tests ([bbae71d](https://github.com/ahembree/librariarr/commit/bbae71d042b4741e17db7a667a13071660dbc5cd))
* **docs:** shadow root postcss config so astro build doesn't load tailwind plugin ([8641d3e](https://github.com/ahembree/librariarr/commit/8641d3eb20b0bdcbc35d7a4fc13e0d499252c741))
* **lifecycle:** fix bugs with quality profile changes ([21dc54b](https://github.com/ahembree/librariarr/commit/21dc54b737489686b5cdc0e92ad3e285e106c006))
* **lifecycle:** fix unicode diacritic matching ([c0759dd](https://github.com/ahembree/librariarr/commit/c0759ddce5b575bef38c064832ccc5682376ca7d))
* **lifecycle:** label new action type and reset profile list on switch ([96a6e9f](https://github.com/ahembree/librariarr/commit/96a6e9f6a591fd33b53bcfc909ba8e2aaf363b3c))
* **lifecycle:** surface stale quality profile + persist target id on failed exec ([14d8ff0](https://github.com/ahembree/librariarr/commit/14d8ff086035ed7b602ec91687b1672211378c75))
* **rules:** block match-all from unconfigured contains/notContains ([7ee03a3](https://github.com/ahembree/librariarr/commit/7ee03a39ed7c728c9786db337c09910d16216c39))
* **rules:** block match-all from unknown operator, type mismatch, or malformed value ([6ca88b2](https://github.com/ahembree/librariarr/commit/6ca88b2d4225e56461e22ad250efa394aa85257c))
* **rules:** handle isNull/isNotNull on non-nullable text fields ([6a092a5](https://github.com/ahembree/librariarr/commit/6a092a52eb776947663282ada2a108716e374eb8))
* **rules:** handle pipe-separated multi-select for genre and labels ([3168e7e](https://github.com/ahembree/librariarr/commit/3168e7e70e90dd160c103973a9c76305ffb8f164))
* **rules:** use list membership for contains on enumerable fields ([3b1278e](https://github.com/ahembree/librariarr/commit/3b1278e0c5440c8691a616599fedb513be8ec13c))

## [0.17.1](https://github.com/ahembree/librariarr/compare/v0.17.0...v0.17.1) (2026-05-16)


### Bug Fixes

* **build:** disable verifyDepsBeforeRun for multi-stage Docker ([74f5e16](https://github.com/ahembree/librariarr/commit/74f5e169e7dcc047b4d497562d47f6000fad6f43))

## [0.17.0](https://github.com/ahembree/librariarr/compare/v0.16.2...v0.17.0) (2026-05-15)


### Features

* **auth:** add plexLoginEnabled toggle — keep Plex linked, hide login button ([5c2f54d](https://github.com/ahembree/librariarr/commit/5c2f54dab8241396160f7e10f46f1bc3aa4c2ba2))
* **auth:** add SSO support via OIDC and forward-auth ([a420dc8](https://github.com/ahembree/librariarr/commit/a420dc8a1258d0f7822b9efffecb39841d968473))
* **auth:** add SSO support via OIDC and forward-auth ([58d3f65](https://github.com/ahembree/librariarr/commit/58d3f657101d15ccb24c6c428a6e20c8f6eb447f))
* **auth:** proactive lockout warning on local-auth toggle ([71d0e1b](https://github.com/ahembree/librariarr/commit/71d0e1bbac265340500b71ff648156b3241c5461))
* **recovery:** add reset-password command to reset-auth.js ([d8e3b81](https://github.com/ahembree/librariarr/commit/d8e3b81f7f2f014358de4655b40bedc939a1d94f))
* **sso:** add SSO_DISABLE_OVERRIDE env var for break-glass recovery ([2256f10](https://github.com/ahembree/librariarr/commit/2256f105eacf3d932cbdc0111b2d916c3da3d05f))
* **sso:** in-app revert + cli/sql recovery for the locked-out case ([8dbe99a](https://github.com/ahembree/librariarr/commit/8dbe99ab78e8b85c54d19bc44898e2f190923306))
* **sso:** three-step wizard ui + hide plex login when no plex linked ([9d430d4](https://github.com/ahembree/librariarr/commit/9d430d4fde7cd3e12f46c405bef9111df5eb0371))
* **sso:** verify-and-link via real oidc round-trip to catch bad creds early ([16970b4](https://github.com/ahembree/librariarr/commit/16970b4818a05ad558029824e8295ab53cb867c1))


### Bug Fixes

* **auth:** harden session, csrf, rate-limit, and idp-fetch surface ([346fe65](https://github.com/ahembree/librariarr/commit/346fe65817e1be91250461efe088d282740e5a64))
* **auth:** override re-surfaces credentials even when toggles are off; docs ([2c1f969](https://github.com/ahembree/librariarr/commit/2c1f9694ff087a13c3a21ab8bff46221d2fddb9f))
* **auth:** plex-first user creation creates AppSettings; sso route upserts ([77ab307](https://github.com/ahembree/librariarr/commit/77ab307d857d1c220899eb78c7cbc9cd8d622729))
* **auth:** revert COOKIE_SECURE default; add strict CSRF for forward-auth ([9da4ec7](https://github.com/ahembree/librariarr/commit/9da4ec785675e637c8530c802ae1efcd921943b8))
* **recovery:** reset-password requires interactive TTY only ([3fe26e4](https://github.com/ahembree/librariarr/commit/3fe26e48bdbe98247e181a4965f4e63ef0e19627))
* **settings:** replace alert() with inline error on Plex login toggle ([d0e8fff](https://github.com/ahembree/librariarr/commit/d0e8fff616bd7ca5cfb105258896fb0516e05b98))
* **sso:** bug-fish pass — lockout, coercion, and validation gaps ([4b28f15](https://github.com/ahembree/librariarr/commit/4b28f15be999376a7ced51dea41914e89080c1c8))
* **sso:** close 11 bugs from deep audit ([40297cd](https://github.com/ahembree/librariarr/commit/40297cd8e262581484b6519d57100551e823a673))
* **sso:** close auth-bypass, lockout, and race-condition gaps found in audit ([25fffad](https://github.com/ahembree/librariarr/commit/25fffad6bf5a5053fd88c1d226718359b81ba911))
* **sso:** close cross-idp collision, claim sync gaps, and header poisoning ([964dd46](https://github.com/ahembree/librariarr/commit/964dd46bd8a3fcad7a3a4eceee8258d527cc4313))
* **sso:** close five bugs from the deep audit ([c78a958](https://github.com/ahembree/librariarr/commit/c78a9587a18cc050df7d5e18455a92e43c355d49))
* **sso:** don't require Plex to unlink — accept local credentials ([de44529](https://github.com/ahembree/librariarr/commit/de44529fd722a24989776d182ba93dda92a3c4a3))
* **sso:** recovery script uses plain node + pg, not bundled in image ([75de5c5](https://github.com/ahembree/librariarr/commit/75de5c5c4a62059d5090198ead95c1129d06cd6d))
* **sso:** surface global-SSO auto-disable in the UI on unlink ([20f31d9](https://github.com/ahembree/librariarr/commit/20f31d92611721f69c81dd552110c00ee2d99008))
* **sso:** ui/ux consistency pass against the style guide ([5234209](https://github.com/ahembree/librariarr/commit/523420900664f94fb8a445161173d52e85dce168))
* **validation:** make webhookAvatarUrl truly optional under zod 4.4 ([2220ece](https://github.com/ahembree/librariarr/commit/2220ecefe084c061a6a8bf1561b0208538d5b5ce))


### Performance Improvements

* **sso:** cache OIDC discovery to cut login latency by ~1s ([a46c902](https://github.com/ahembree/librariarr/commit/a46c902345f3cf7cc88daf41d23df63dec090459))

## [0.16.2](https://github.com/ahembree/librariarr/compare/v0.16.1...v0.16.2) (2026-05-11)


### Bug Fixes

* **security:** update next to 16.2.6 to fix security issues ([3fa5f6b](https://github.com/ahembree/librariarr/commit/3fa5f6ba3bdb0e6bdef8be5847789e0e912bd88a))
* **security:** update next to 16.2.6 to fix security issues ([29811c1](https://github.com/ahembree/librariarr/commit/29811c147f835008fc061a3d33625d2a12da8814))

## [0.16.1](https://github.com/ahembree/librariarr/compare/v0.16.0...v0.16.1) (2026-05-11)


### Bug Fixes

* ai gaslight bug hunt ([6873ceb](https://github.com/ahembree/librariarr/commit/6873cebc8f7e9817bd61a871b3126ad131efd154))
* fix eslint issues and bump eslint-config-next ([009d5e8](https://github.com/ahembree/librariarr/commit/009d5e82e64de4c9278063b51749a7502e265ec2))

## [0.16.0](https://github.com/ahembree/librariarr/compare/v0.15.3...v0.16.0) (2026-05-10)


### Features

* **dashboard:** add hover popover cards ([6718234](https://github.com/ahembree/librariarr/commit/6718234e48d8f512f5ed85e5b29d6c454339733a))
* improve UI/UX for dashboard and cards ([963d27d](https://github.com/ahembree/librariarr/commit/963d27d830b029bb7e19912613afc372bebd3f6a))
* improve UI/UX for integrations ([21833d9](https://github.com/ahembree/librariarr/commit/21833d91a5390b7868fb1fa7a2238233f2a54a4a))
* improve UI/UX for integrations ([dac47df](https://github.com/ahembree/librariarr/commit/dac47df4556ebde291cea18b581f38defccac5f4))
* improve UI/UX for library pages ([7c6fa36](https://github.com/ahembree/librariarr/commit/7c6fa36e591a83f4fa2a01cb619933f68b58cc25))
* improve UI/UX for lifecycle pages ([cbc253a](https://github.com/ahembree/librariarr/commit/cbc253afbc39bd1dfbf0e662c98c1d997ca53c60))
* improve UI/UX for system pages ([d2e1e41](https://github.com/ahembree/librariarr/commit/d2e1e41b2d6843caa237618d554f65bc29d26244))
* improve UI/UX for tools pages ([8e834bf](https://github.com/ahembree/librariarr/commit/8e834bfdf3bf3af940a7ba5cba012fc8b5cab55f))
* recycle bin check for destructive actions ([5480c91](https://github.com/ahembree/librariarr/commit/5480c91f49a4e634e6ab051f71bc58b1e0ab2a18))
* unify query and rule builder, add arr precheck ([34c2094](https://github.com/ahembree/librariarr/commit/34c209457219258c71bdddbbc5bfe148ad9634fa))


### Bug Fixes

* ai gaslight bug fixes ([d25151d](https://github.com/ahembree/librariarr/commit/d25151d53e04ba5fcdd146478abacb771d46e6c0))
* ai gaslighting bug hunt ([bed7e57](https://github.com/ahembree/librariarr/commit/bed7e57867d357f3a03bce7b4a59b8a7448f59f4))
* breaker if media server unreachable ([9b85330](https://github.com/ahembree/librariarr/commit/9b853303e3b36c8afa8a28ff2f3c6832b4170f0c))
* cards and build error ([da0f8b2](https://github.com/ahembree/librariarr/commit/da0f8b287a3704d4219401e09d0706b516631fe6))
* **dashboard:** fix series hover to use series artwork and not episode ([fdbc50b](https://github.com/ahembree/librariarr/commit/fdbc50bcd0ce70509498dd240eee4d0d117ea711))
* fix media detail items ([be4b2b2](https://github.com/ahembree/librariarr/commit/be4b2b2b1765d162f820af44e3d733a59204a7ed))
* fix rating labels ([92973fb](https://github.com/ahembree/librariarr/commit/92973fbac981572fd2ba38a892bed2d594ffaa5f))
* **lifecycle:** fix rule saving with same name across different media type ([01cc8cd](https://github.com/ahembree/librariarr/commit/01cc8cdb22313f9a75134f7a2f80d37f6842e255))
* **series:** fix series summaries ([071419e](https://github.com/ahembree/librariarr/commit/071419e740ab1ea9c8d73890219c663ac5345d2d))
* **types:** narrow axios response header type for content-type read ([ab738d7](https://github.com/ahembree/librariarr/commit/ab738d736b6207404b7cb63e10b47b142cc6b502))

## [0.15.3](https://github.com/ahembree/librariarr/compare/v0.15.2...v0.15.3) (2026-04-11)


### Bug Fixes

* **lifecycle:** include memberIds for series/music scope so stats compute file sizes ([3d72c25](https://github.com/ahembree/librariarr/commit/3d72c25ec1d2a917d306380c7bcc9dddb2e71ac7))
* **lifecycle:** make deletion tracker stats contextual to active tab ([f27877c](https://github.com/ahembree/librariarr/commit/f27877c0c38bc30ea22874c5b4f8175f7efefcdb))
* **lifecycle:** show aggregated series/music data in pending actions page ([4f5192e](https://github.com/ahembree/librariarr/commit/4f5192e1b1e1343bde6537f339a4bace445f4f2e))
* **query:** map resolution display labels for contains/notContains in query builder ([200e708](https://github.com/ahembree/librariarr/commit/200e708be83d69bd18539f1381f85b6eccd25019))
* **rules,query:** support pipe-separated multi-select for resolution contains/notContains ([4be1992](https://github.com/ahembree/librariarr/commit/4be1992524b5d0d732d378c03ad090cef124ab81))
* **rules,query:** support pipe-separated multi-select for stream field contains/notContains ([e7a1940](https://github.com/ahembree/librariarr/commit/e7a1940d0634bdffc431077b6b07883de071805d))
* **rules:** map resolution display labels for contains/notContains operators ([9a312e4](https://github.com/ahembree/librariarr/commit/9a312e4c692fdf93de4df6f765384a740ebf8e02))
* **rules:** map resolution display labels for contains/notContains operators ([989a5bc](https://github.com/ahembree/librariarr/commit/989a5bcba98d62f2bb9f61efd037e3a05da8a550))

## [0.15.2](https://github.com/ahembree/librariarr/compare/v0.15.1...v0.15.2) (2026-04-09)


### Bug Fixes

* **db:** fix db push invocation and add schema validation guard ([1440347](https://github.com/ahembree/librariarr/commit/1440347b1d5fae11c1db14cf1d52e1147fa4ceee))

## [0.15.1](https://github.com/ahembree/librariarr/compare/v0.15.0...v0.15.1) (2026-04-09)


### Bug Fixes

* **db:** always run db push after migrate deploy to apply schema-only columns ([c900d76](https://github.com/ahembree/librariarr/commit/c900d76ef661a347e1579db7b0dd873827529bc2))
* **lifecycle:** schedule actions during manual re-evaluation and guard null actionType ([a74397c](https://github.com/ahembree/librariarr/commit/a74397c5d59f930f9454c8ae1f1bb3cf73b263f1))

## [0.15.0](https://github.com/ahembree/librariarr/compare/v0.14.2...v0.15.0) (2026-04-09)


### Features

* **lifecycle:** add file size column to pending actions table ([7984ce1](https://github.com/ahembree/librariarr/commit/7984ce1d85debed7978dec729e4f62622bc62abd))
* **unraid:** add external database template for existing PostgreSQL users ([9114930](https://github.com/ahembree/librariarr/commit/9114930e9352663481845d7062706a834d342fff))


### Bug Fixes

* allow duplicate server names and disambiguate in UI ([624554f](https://github.com/ahembree/librariarr/commit/624554ffc41e8958e124018e4c5e958faf6748a1))
* disambiguate server names in dashboard and lifecycle rule picker ([63b9d21](https://github.com/ahembree/librariarr/commit/63b9d215fcf578df5be1ac566768e77ead35d38c))
* **history:** map resolution display labels to DB values in watch history route ([301cdcc](https://github.com/ahembree/librariarr/commit/301cdccd060b4ad118684cdcdbf190433917c0bb))
* **lifecycle:** address remaining bugs in server deletion cleanup ([f6aadf5](https://github.com/ahembree/librariarr/commit/f6aadf5c1e6991af9a8a21a381b5eb5bbceac66d))
* **lifecycle:** allow re-scheduling actions for previously actioned items ([d364a61](https://github.com/ahembree/librariarr/commit/d364a611684a4e068966c01d892c03c622944fd0))
* **lifecycle:** clean up orphaned rule set serverIds and pending actions on server deletion ([35e22de](https://github.com/ahembree/librariarr/commit/35e22de8cd4c245b20116825c6415e50cd6a74f4))
* **lifecycle:** include upcoming matches in pending deletion stats ([85e2779](https://github.com/ahembree/librariarr/commit/85e2779d89d6456a7f1eed35b1ce6cbaac6bf1e6))
* **lifecycle:** only allow re-scheduling for completed delete actions ([6ae32e1](https://github.com/ahembree/librariarr/commit/6ae32e1a8830d1cdfe8853787d6749562b29bd86))
* **query:** map resolution display labels to DB values in query engine ([9ad007e](https://github.com/ahembree/librariarr/commit/9ad007ed8c70b387b8ec84767dffb40325a33fa7))
* **rules:** default to false for unsupported operators in Arr/Seerr evaluation ([b142fcf](https://github.com/ahembree/librariarr/commit/b142fcf2383913e8c52f30b796daf8fd26dd3563))
* **rules:** map resolution display labels to DB values in lifecycle rule engine ([4d44d84](https://github.com/ahembree/librariarr/commit/4d44d846b9814a5055a78924235074b34e9beec7))
* **test:** correct server deletion cleanup tests to exercise new code ([23cb250](https://github.com/ahembree/librariarr/commit/23cb250a41518ecdbdc598f275b709b52a97b4b1))
* use ServerTypeChip in servers settings tab ([2bb08d9](https://github.com/ahembree/librariarr/commit/2bb08d976e75768ed061f0fe5b125e50694808b7))

## [0.14.2](https://github.com/ahembree/librariarr/compare/v0.14.1...v0.14.2) (2026-04-06)


### Bug Fixes

* apply dedup filtering to recently-added and timeline stats ([253b0c5](https://github.com/ahembree/librariarr/commit/253b0c58bd564170027cd6e908b8cf90ffbf1d4b))
* apply dedupCanonical filter to dashboard breakdown stats ([3c104bc](https://github.com/ahembree/librariarr/commit/3c104bc6df7811678cd8d074fb4016820c962444))

## [0.14.1](https://github.com/ahembree/librariarr/compare/v0.14.0...v0.14.1) (2026-04-05)


### Bug Fixes

* ui fixes ([eb30d52](https://github.com/ahembree/librariarr/commit/eb30d52b022970ac5bb770968c05ce4569919d2a))
* **ui:** use Link for card navigation to prevent image loading blocking clicks ([942f70b](https://github.com/ahembree/librariarr/commit/942f70b917c013ec39ddf579e4d3908f20cf9548))
* **ui:** use Link for remaining card view navigations ([e788f33](https://github.com/ahembree/librariarr/commit/e788f33fce5df8bdeda82846e67d8702a0e08997))

## [0.14.0](https://github.com/ahembree/librariarr/compare/v0.13.0...v0.14.0) (2026-04-05)


### Features

* **lifecycle:** add hover popover to pending actions and align table styling ([cb2dd1a](https://github.com/ahembree/librariarr/commit/cb2dd1a841a25c33d4f3d6c138c88bc190206b8d))
* **lifecycle:** add hover popovers and card view to matches, pending, and rule preview ([13fade6](https://github.com/ahembree/librariarr/commit/13fade64958fc48cff1da37df5690e2d83370e48))
* **lifecycle:** show full media details in hover popovers ([ab86b7c](https://github.com/ahembree/librariarr/commit/ab86b7c8efdc0d4f98e3ea4a5d4ce4c69ffab0a7))
* **ui:** use correct rating source labels in hover popovers ([e34e20f](https://github.com/ahembree/librariarr/commit/e34e20f781e8ddb90c208686707937242ec0815b))
* unify grouped view popovers with full available data ([5357a1d](https://github.com/ahembree/librariarr/commit/5357a1d8617e7cd9c8f0101b0a7cb5f484f63bb7))
* unify hover popover content across all pages ([b85c721](https://github.com/ahembree/librariarr/commit/b85c721ae3b50d2dc152e65fc8996130d8a6e14e))


### Bug Fixes

* add missing fields to album and season card view popovers ([b601340](https://github.com/ahembree/librariarr/commit/b60134018c2f6b143cf299b8a30b648ab19a2118))
* add summary and genres to movies, series, and music list APIs ([619088d](https://github.com/ahembree/librariarr/commit/619088da2563193bfc18543ecbdea081391f9606))
* align hover card details ([c455587](https://github.com/ahembree/librariarr/commit/c4555870185e5f143f1ef0dc8ff7ffa619483835))
* preserve scroll position and active tab on series/music library pages ([0466b2f](https://github.com/ahembree/librariarr/commit/0466b2f77e708f97b2f83e03d54b3aad5a22593d))
* **ui:** move card hover effects from custom CSS to Tailwind utilities ([368c6b7](https://github.com/ahembree/librariarr/commit/368c6b7f0542881ab26d2114144cdb95117cc6bf))


### Performance Improvements

* **lifecycle:** virtualize pending actions card grid ([3c6b85e](https://github.com/ahembree/librariarr/commit/3c6b85eebc550333ed5ff1cf038a26b91ef0ecf8))

## [0.13.0](https://github.com/ahembree/librariarr/compare/v0.12.2...v0.13.0) (2026-04-04)


### Features

* **tracks:** add server chips to track cards ([ec68daf](https://github.com/ahembree/librariarr/commit/ec68dafc7def5891b03e86aa9893e96a58a2dcd7))


### Bug Fixes

* add server chips to seasons/episodes/albums cards, fix card layout issues ([bc29075](https://github.com/ahembree/librariarr/commit/bc290756de92d1fb467feb3c818ccf3f218f9a7d))
* always render quality bar container for consistent card height ([104b564](https://github.com/ahembree/librariarr/commit/104b5642a607662ddb8fe805ba676fe1d605ac79))
* **tracks:** fix card view by using correct scroll container ([e6d9390](https://github.com/ahembree/librariarr/commit/e6d9390b266a6a7cdabdec11c12008486eb47718))
* use calculated fallback in virtualizer estimateSize instead of hardcoded values ([91a89fc](https://github.com/ahembree/librariarr/commit/91a89fc793362793182384e149414ba17093b50e))
* use virtualizer measureElement for pixel-perfect row spacing ([ab09434](https://github.com/ahembree/librariarr/commit/ab0943460d227b7aed25d6b9d9f712327b98d0f0))

## [0.12.2](https://github.com/ahembree/librariarr/compare/v0.12.1...v0.12.2) (2026-04-04)


### Bug Fixes

* disable backdrop-filter blur on mobile to fix scroll lag ([a01a627](https://github.com/ahembree/librariarr/commit/a01a627f58464d9018e881dbeeb38d4ece09b72f))
* exceptions fixes ([7f555f0](https://github.com/ahembree/librariarr/commit/7f555f0d409df0f686f116c2d1842faab70d496f))
* exceptions fixes ([77a2a4e](https://github.com/ahembree/librariarr/commit/77a2a4e2e9ba3d0026d00e98939135378b99df3d))


### Performance Improvements

* fix mobile scroll lag and virtualize all library pages ([6885483](https://github.com/ahembree/librariarr/commit/6885483800394edf5db2c7f1aa7af755b6a1f1ae))
* gate expensive hover effects behind [@media](https://github.com/media) (hover: hover) ([11f86f9](https://github.com/ahembree/librariarr/commit/11f86f95a171e86a1f705b82ae6fb1c92fef8bc5))
* virtualize all seasons, episodes, albums, and tracks pages ([ec1b5b7](https://github.com/ahembree/librariarr/commit/ec1b5b76d0bcaf26f9b7f23e315334ea4af2452b))
* virtualize lifecycle exceptions and system logs tables ([883dac9](https://github.com/ahembree/librariarr/commit/883dac93731a9113725f3aa2637515180a9d7e65))

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
