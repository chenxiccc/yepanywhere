# Session Sandboxing Evidence

This companion preserves the dated mechanism research behind the live contract
in [`session-sandboxing.md`](session-sandboxing.md). It is evidence and design
history, not the current product contract.

## Linux Mechanism Survey: Rocky 8 And Later

Surveyed 2026-07-28 against upstream documentation and a Rocky Linux 8.10
host. RHEL/Rocky 8's practical baseline is Linux 4.18 and glibc 2.28
([RHEL 8 kernel documentation](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/8/html/managing_monitoring_and_updating_the_kernel/assembly_the-linux-kernel_managing-monitoring-and-updating-the-kernel),
[RHEL 8.0 release notes](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/8/pdf/8.0_release_notes/red_hat_enterprise_linux-8-8.0_release_notes-en-us.pdf)).

### Required Linux v1 backend: Bubblewrap

Use a trusted system `bwrap` outside the project when it is installed and a
runtime probe proves that unprivileged user and mount namespaces work.
Presence on `PATH` alone is not support. Never select a project-local binary,
and do not fall back from a failed probe to an unlocked provider process.

Linux v1 supports Bubblewrap 0.4.x rather than requiring a recent upstream
release. The launcher may use newer options only after probing for them; the
baseline policy must be expressible with the Rocky 8 `0.4.0` interface verified
below.

Missing-Bubblewrap launch errors must name the dependency and offer an
installation command appropriate to the detected host family. For example:

```text
Sandboxed sessions require Bubblewrap (bwrap).
Install it with: sudo dnf install bubblewrap
```

Known guidance includes `sudo dnf install bubblewrap` for Rocky/RHEL/Fedora and
`sudo apt install bubblewrap` for Debian/Ubuntu. If `bwrap` exists but the
runtime probe fails, the error must instead report the failed prerequisite,
such as disabled unprivileged user namespaces; reinstalling the package is not
useful advice. YA never runs the install command itself.

The basic mount shape is a read-only host view followed by a writable bind of
the canonical project at the same path. The
[Bubblewrap manual](https://github.com/containers/bubblewrap/blob/v0.4.0/bwrap.xml)
states that filesystem operations are applied in argument order and provides
both `--ro-bind` and `--bind`; the current
[OpenAI Codex Linux sandbox](https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md)
uses the same read-only-root plus writable-roots construction. This preserves
ordinary reads of host tools and files instead of building a tiny chroot.

A bare `--ro-bind / /` plus project bind is only a mechanism probe, not the
complete YA policy. The production argument set must also:

- install a new safe `/proc` and `/dev` view and make `/sys` appropriately
  read-only or private;
- replace or mask host runtime paths such as `/run`, `/tmp`, and `/var/tmp`
  before adding fixed private scratch/cache;
- hide pathname and abstract Unix sockets, D-Bus, container-engine sockets,
  SSH agents, and other brokers that could perform outside writes on the
  child's behalf;
- close inherited file descriptors and sanitize environment variables that
  point to host control channels;
- use `--new-session`, because Bubblewrap documents terminal injection as an
  escape when neither that flag nor an equivalent seccomp rule is present;
- use `--die-with-parent`, a PID namespace, no new privileges, and no retained
  host capabilities; and
- account for submounts below the project and the read-only host view.

This policy construction remains YA's responsibility; Bubblewrap explicitly
describes itself as a low-level tool rather than a complete sandbox and warns
that anything mounted into the sandbox, including D-Bus sockets, can become an
escape path
([upstream security notes](https://github.com/containers/bubblewrap/blob/main/README.md#sandbox-security)).

Rocky 8 provides `bubblewrap-0.4.0-2.el8_10` in BaseOS
([binary packages](https://download.rockylinux.org/pub/rocky/8/BaseOS/x86_64/os/Packages/b/),
[source package](https://download.rockylinux.org/pub/rocky/8.10/BaseOS/source/tree/Packages/b/)).
On the surveyed host that non-setuid `0755` binary:

- started successfully under kernel 4.18/glibc 2.28 with unprivileged user
  namespaces;
- allowed an ordinary create beneath the writable project bind;
- denied a direct outside create and a write through a project symlink to an
  outside directory; and
- reported `NoNewPrivs: 1` in the child.

It did not prevent mutation through a pre-existing hardlink alias, confirming
the explicit v1 limit above. These are mechanism probes, not evidence that the
full provider/control-plane policy is solved.

The distro binary requires no glibc symbol newer than 2.14. Current upstream
Bubblewrap is small C code and declares Meson 0.49+, libcap, and optional
libselinux as its build dependencies. A fresh current-upstream build was not
completed on the surveyed host because its development dependencies were not
installed, so the verified Rocky 8 claim is the maintained distro package,
not an untested promise about every future release.

Do not make Bubblewrap setuid as a fallback. Current upstream builds disable
historical setuid support by default, and its security history includes
setuid-only privilege-escalation defects
([security policy](https://github.com/containers/bubblewrap/blob/main/SECURITY.md),
[advisories](https://github.com/containers/bubblewrap/security/advisories)).
If unprivileged user namespaces are disabled, Linux v1 reports the enabled
policy unsupported. A later narrowly scoped helper/service would be a separate
backend requiring the full contract suite.

Bubblewrap is also the relevant agent-industry choice rather than merely a
desktop sandbox. OpenAI Codex prefers system Bubblewrap while retaining a
compatibility path for old versions that lack `--argv0`.

Anthropic's
[sandbox runtime](https://github.com/anthropic-experimental/sandbox-runtime)
(SRT) is a useful policy reference and may become an optional adapter after it
passes YA's contract suite, but it is not a Linux fallback. SRT itself requires
Bubblewrap, plus `socat` and Ripgrep, and removes the child's network namespace
in favor of host proxy processes and domain policy. That network behavior is
stronger but observably different from v1's unchanged-network contract. YA
therefore drives Bubblewrap directly in v1 rather than automatically selecting
SRT merely because `srt` is installed. A future SRT adapter must preserve the
requested YA filesystem and network semantics and must not weaken setup
failures into warnings.

### Secondary candidates

- **systemd 239 transient/system services.** Rocky 8's systemd already
  supports `ProtectSystem=strict`, `ReadWritePaths=`, `NoNewPrivileges=`, and
  transient `--property=` values. Its v239 documentation describes exactly the
  read-only hierarchy plus writable subdirectory shape, but also warns that
  privileged processes can undo it, later-created submounts are not covered,
  and capability/syscall restrictions must accompany it
  ([v239 execution policy](https://github.com/systemd/systemd/blob/v239/man/systemd.exec.xml),
  [v239 transient units](https://github.com/systemd/systemd/blob/v239/man/systemd-run.xml)).
  This is a credible installed-service backend when YA has a prearranged
  system-manager policy, not a portable unprivileged fallback for an arbitrary
  native launch.

- **Landlock.** Landlock is an unprivileged, inherited kernel access-control
  layer and is attractive on newer Linux systems
  ([kernel documentation](https://www.kernel.org/doc/html/v5.13/security/landlock.html)).
  It first appears in the Linux 5.13 documentation, so a stock Rocky 8 kernel
  4.18 cannot be the v1 baseline. Later distributions still require a runtime
  ABI/feature probe. Landlock also does not retroactively constrain
  already-open file descriptors, and its handled rights vary by ABI.

- **Firejail.** Firejail is C, low-dependency, and available from EPEL on the
  surveyed Rocky 8 host, but upstream describes it as an SUID sandbox with a
  broad desktop/profile feature surface
  ([upstream README](https://github.com/netblue30/firejail)). That privileged
  and higher-complexity integration is a worse fit than non-setuid Bubblewrap,
  especially alongside default whole-YA `no_new_privs` hardening.

- **NsJail and Minijail.** Both provide capable namespace/seccomp launchers.
  NsJail adds C++, protobuf, libnl, Kafel, and a larger isolation/configuration
  surface
  ([NsJail README](https://github.com/google/nsjail)); Minijail is smaller C
  code requiring libcap and kernel headers, but is primarily an Android/Chrome
  OS library/tool and is not a Rocky package
  ([Minijail](https://android.googlesource.com/platform/external/minijail/),
  [build requirements](https://android.googlesource.com/platform/external/minijail/+/add50186ecbe274faa395ce13a790e94a524b408/HACKING.md)).
  Neither offers a clear v1 advantage over Bubblewrap's package availability
  and demonstrated policy shape.

- **runc/crun or rootless Podman.** Rocky/RHEL 8 AppStream provides Podman and
  OCI runtimes, but they are installable packages rather than a guaranteed
  base-system facility. The surveyed Rocky host offered Podman `4.9.4` through
  AppStream but did not have it installed. RHEL's own setup requires installing
  `podman` or the `container-tools` module and provisioning `/etc/subuid` and
  `/etc/subgid` for rootless users
  ([RHEL 8 container tools](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/8/html/building_running_and_managing_containers/assembly_starting-with-containers_building-running-and-managing-containers)).
  Upstream lists packages in the ordinary repositories of Debian 11+, Ubuntu
  20.10+, CentOS Stream 9+, Arch, Alpine, and openSUSE, but generally still
  instructs the operator to install them
  ([Podman installation](https://podman.io/docs/installation)). Rootless mode
  also depends on subordinate-ID mappings and helper/storage/network setup;
  runc supports rootless user-namespace containers
  ([runc documentation](https://github.com/opencontainers/runc)). These tools
  bring an OCI bundle/rootfs/image/state lifecycle and substantially more
  policy than YA needs. They remain reasonable deployment-level isolation when
  YA already runs in containers, not an embedded v1 fallback.

- **Plain `chroot`.** `chroot(project)` hides the outside reads this product
  wants and requires constructing a usable root; `chroot("/")` supplies no
  write boundary. More importantly, the Linux manual says chroot alone is not
  intended as a security mechanism and documents escape conditions
  ([chroot(2)](https://man7.org/linux/man-pages/man2/chroot.2.html)). A future
  backend could include chroot or `pivot_root` only as one layer within a
  private mount namespace, capability drop, no-new-privileges policy, safe
  mount table, and descriptor/IPC cleanup. “Just chroot” is not a conforming
  backend.

- **PRoot.** PRoot emulates chroot and bind mounts through `ptrace`
  ([project documentation](https://proot-me.github.io/)). It is useful for
  compatibility without privilege, but it is not the kernel-enforced security
  boundary required here.
