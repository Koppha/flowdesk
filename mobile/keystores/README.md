# Release signing keystore

`flowdesk-release.keystore` and `release-signing.properties` live here,
gitignored (see `mobile/.gitignore`) — never commit either one.

Generated once on 2026-09-25 (RSA 2048, 10,000-day validity, alias
`flowdesk`). `android/app/build.gradle` reads `release-signing.properties`
at build time to sign `assembleRelease` builds; without this file present,
release builds silently fall back to the debug key (see the comment in
`build.gradle`'s `signingConfigs` block).

**This keystore IS the app's identity from Android's perspective.** Losing
it means every future release is a different app to any device that
already has this one installed — no in-place update, users have to
uninstall and reinstall. Back it up somewhere durable outside this
machine (a password manager or secrets vault), not just here.

`android/` is regenerated from scratch by `expo prebuild --clean`
(Continuous Native Generation) - if that ever wipes the signing block out
of `build.gradle`, the fix is a config plugin
(`withAppBuildGradle` from `@expo/config-plugins`) that re-injects it on
every prebuild, not hand-editing the generated file again. Not built yet
since prebuild hasn't needed to run again since this was set up.
