# SQLite workspaces cannot load the native prebuild on Rocky Linux 8

The installed `better-sqlite3@11.10.0` native module requires
`GLIBCXX_3.4.31`, while Rocky Linux 8.10's system `libstdc++.so.6` provides
symbols only through `GLIBCXX_3.4.25`. Tests that construct a database
therefore fail before exercising YA behavior:

```text
/lib64/libstdc++.so.6: version `GLIBCXX_3.4.31' not found
```

The failure reproduces from both the existing pnpm 9 installation and a fresh
pnpm 10 frozen install. It affects the direct `better-sqlite3` consumers
`@yep-anywhere/push-broker` and `@yep-anywhere/relay`; the initial load error
causes additional teardown failures where an uncreated database or relay is
closed.

Decide whether Rocky Linux 8 remains a supported development/runtime host. If
it does, verify whether building `better-sqlite3` from source, selecting a
compatible upstream prebuild, or changing the dependency restores clean frozen
installs without weakening supported newer hosts. If it does not, document and
enforce the native runtime floor so installation fails with a direct diagnostic
rather than dozens of database-test failures.

Found 2026-08-11 while validating the pnpm 10 toolchain upgrade under Node 20
and Node 24.
