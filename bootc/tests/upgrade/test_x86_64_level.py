"""The node's x86-64 level on its Node (k4all#125, the host part of #121).

The cephcsi build that Rook's CSI drivers run is the same on every node: the
standard one needs x86-64-v3 (glibc aborts at process start below it), the
`-rocky9` one runs on x86-64-v2. k4all-operator v0.7.0 chooses between them
from `k4all.magesgate.com/x86-64-level`, which the agent writes on x86_64
nodes only: the highest level glibc's loader reports supported, else what
the flags of /proc/cpuinfo add up to. Found once per boot, cached in /run.
"""

import os

import pytest

from conftest import ku, release, run_cli, write_graph

DATA = os.path.join(os.path.dirname(__file__), "data", "ld-so-help")
LEVEL = ku.ANNOTATION_X86_64_LEVEL


def ld_so_help(name):
    with open(os.path.join(DATA, name), encoding="utf-8") as fh:
        return fh.read()


# --- glibc's loader -----------------------------------------------------------
# What `/lib64/ld-linux-x86-64.so.2 --help` prints, from Fedora 43's glibc
# 2.42 (the k4all 2.7 image's is Fedora 45's):
# - v3: on an Intel Core i9-10900K (Comet Lake: AVX2, no AVX-512);
# - v2: on the same CPU with GLIBC_TUNABLES=glibc.cpu.hwcaps=-AVX2, which
#   is what glibc reports where AVX2 is missing (QEMU's IvyBridge model);
# - v4: the v3 output with the line the loader prints for a supported
#   level on the x86-64-v4 line (no AVX-512 CPU was at hand; the VM round
#   checks a host-CPU node);
# - rhel8-v3: glibc 2.28 of RHEL 8.10, which has glibc-hwcaps backported and
#   still prints the legacy HWCAP section (glibc before 2.37).
@pytest.mark.parametrize("name, level", [
    ("fedora43-v2.txt", "v2"),
    ("fedora43-v3.txt", "v3"),
    ("fedora43-v4.txt", "v4"),
    ("rhel8-v3.txt", "v3"),
])
def test_the_level_is_the_highest_one_the_loader_supports(name, level):
    assert ku.x86_64_level_from_ld_so(ld_so_help(name)) == level


def test_a_loader_that_supports_no_level_means_v1():
    text = ("Subdirectories of glibc-hwcaps directories, in priority order:\n"
            "  x86-64-v4\n  x86-64-v3\n  x86-64-v2\n")
    assert ku.x86_64_level_from_ld_so(text) == "v1"


def test_only_supported_counts():
    # --glibc-hwcaps-prepend lists its own names as "(searched)"
    text = ("Subdirectories of glibc-hwcaps directories, in priority order:\n"
            "  x86-64-v4 (searched)\n  x86-64-v3\n"
            "  x86-64-v2 (supported, searched)\n")
    assert ku.x86_64_level_from_ld_so(text) == "v2"


@pytest.mark.parametrize("text", [
    "",
    None,
    # glibc before 2.33: no glibc-hwcaps subdirectories
    ld_so_help("fedora43-v3.txt").split("\nSubdirectories of glibc-hwcaps")[0],
])
def test_a_loader_that_lists_no_level_says_nothing(text):
    assert ku.x86_64_level_from_ld_so(text) is None


# --- the /proc/cpuinfo fallback -----------------------------------------------
def cpuinfo(flags):
    return ("processor\t: 0\nvendor_id\t: GenuineIntel\nmodel name\t: CPU\n"
            "flags\t\t: %s\nbugs\t\t: spectre_v1\n\nprocessor\t: 1\n" % flags)


# QEMU's qemu64 model: SSE3 and CX16, no SSSE3, SSE4 or POPCNT
QEMU64 = ("fpu de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 "
          "clflush mmx fxsr sse sse2 syscall nx lm rep_good nopl xtopology cpuid "
          "tsc_known_freq pni cx16 x2apic hypervisor lahf_lm")
# QEMU's IvyBridge model: AVX and F16C, no AVX2, BMI, FMA or MOVBE
IVYBRIDGE = ("fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat "
             "pse36 clflush mmx fxsr sse sse2 ss syscall nx rdtscp lm constant_tsc "
             "rep_good nopl xtopology cpuid tsc_known_freq pni pclmulqdq ssse3 cx16 "
             "pcid sse4_1 sse4_2 x2apic popcnt tsc_deadline_timer aes xsave avx "
             "f16c rdrand hypervisor lahf_lm cpuid_fault pti fsgsbase smep erms "
             "xsaveopt arat")
# An Intel Core i9-10900K in a VM
COMET_LAKE = ("fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat "
              "pse36 clflush mmx fxsr sse sse2 ss ht syscall nx pdpe1gb rdtscp lm "
              "arch_perfmon rep_good nopl xtopology cpuid tsc_known_freq pni "
              "pclmulqdq vmx ssse3 fma cx16 pdcm pcid sse4_1 sse4_2 x2apic movbe "
              "popcnt aes xsave avx f16c rdrand hypervisor lahf_lm abm "
              "3dnowprefetch ssbd ibrs ibpb stibp ibrs_enhanced fsgsbase bmi1 avx2 "
              "smep bmi2 erms invpcid rdseed adx smap clflushopt xsaveopt xsavec "
              "xgetbv1 xsaves md_clear flush_l1d arch_capabilities")
SKYLAKE_SERVER = COMET_LAKE + " avx512f avx512dq avx512cd avx512bw avx512vl"


@pytest.mark.parametrize("flags, level", [
    (QEMU64, "v1"),
    (IVYBRIDGE, "v2"),
    (COMET_LAKE, "v3"),
    (SKYLAKE_SERVER, "v4"),
    # OSXSAVE is not a flag: without xsave, AVX is not usable
    (COMET_LAKE.replace(" xsave ", " "), "v2"),
    # every level stands on the one below: AVX-512 without SSE4.2 is v1
    (SKYLAKE_SERVER.replace(" sse4_2 ", " "), "v1"),
    (SKYLAKE_SERVER.replace(" avx512vl", ""), "v3"),
])
def test_the_cpuinfo_flags_add_up_to_a_level(flags, level):
    assert ku.x86_64_level_from_cpuinfo(cpuinfo(flags)) == level


def test_cpuinfo_without_flags_says_nothing():
    assert ku.x86_64_level_from_cpuinfo("processor\t: 0\n") is None


# --- once per boot ------------------------------------------------------------
def ld_so_runs(host):
    return [c for c in host.calls if c[:1] == [ku.LD_SO_X86_64]]


def test_the_loader_comes_first(make_host):
    host = make_host()
    host.ld_so_help = ld_so_help("fedora43-v2.txt")
    host.write(ku.PROC_CPUINFO, cpuinfo(COMET_LAKE))
    assert ku.node_x86_64_level(host) == "v2"
    assert host.read(ku.X86_64_LEVEL_CACHE) == "v2\n"


@pytest.mark.parametrize("output", [None, "Usage: ld.so [OPTION]...\n"],
                         ids=["no-loader", "no-levels"])
def test_cpuinfo_when_the_loader_cannot_tell(make_host, output):
    host = make_host()
    host.ld_so_help = output
    host.write(ku.PROC_CPUINFO, cpuinfo(IVYBRIDGE))
    assert ku.node_x86_64_level(host) == "v2"


def test_a_node_that_cannot_tell_has_no_level(make_host):
    host = make_host()
    assert ku.node_x86_64_level(host) == ""
    assert not host.exists(ku.X86_64_LEVEL_CACHE), "tried again next time"


def test_the_level_is_found_once_per_boot(make_host):
    host = make_host()
    host.ld_so_help = ld_so_help("fedora43-v3.txt")
    assert ku.node_x86_64_level(host) == "v3"
    host.ld_so_help = ld_so_help("fedora43-v2.txt")
    assert ku.node_x86_64_level(host) == "v3", "from the cache"
    assert len(ld_so_runs(host)) == 1


def test_a_cache_that_is_not_a_level_is_found_again(make_host):
    host = make_host()
    host.write(ku.X86_64_LEVEL_CACHE, "v9\n")
    host.ld_so_help = ld_so_help("fedora43-v4.txt")
    assert ku.node_x86_64_level(host) == "v4"
    assert host.read(ku.X86_64_LEVEL_CACHE) == "v4\n"


def test_never_on_aarch64(make_host):
    host = make_host()
    host.arch = lambda: "arm64"
    host.ld_so_help = ld_so_help("fedora43-v3.txt")
    host.write(ku.PROC_CPUINFO, cpuinfo(COMET_LAKE))
    assert ku.node_x86_64_level(host) is None
    assert not ld_so_runs(host) and not host.exists(ku.X86_64_LEVEL_CACHE)


# --- on the Node --------------------------------------------------------------
GRAPH = [release("v2.4.0", "minor", "v2.3.0", "1.35.10", "1.35", 43,
                 syncManifest=True)]


@pytest.fixture
def node(make_host):
    def factory(**kwargs):
        host = make_host(version="v2.4.0", kubernetes="1.35.10", **kwargs)
        write_graph(host, GRAPH)
        return host
    return factory


@pytest.mark.parametrize("role", ["bootstrap", "control", "worker"])
def test_the_agent_publishes_the_level(node, role):
    host = node(role=role)
    host.ld_so_help = ld_so_help("fedora43-v2.txt")
    assert run_cli(host, "agent") == 0
    assert host.annotations[LEVEL] == "v2"
    assert host.patches[0][LEVEL] == "v2", "with release and node-type"


def test_the_agent_writes_it_once_per_boot(node):
    host = node()
    host.ld_so_help = ld_so_help("fedora43-v3.txt")
    run_cli(host, "agent")
    run_cli(host, "agent")
    assert len(ld_so_runs(host)) == 1, "from the cache"
    assert [p for p in host.patches if LEVEL in p] == [{
        ku.ANNOTATION_RELEASE: "v2.4.0", ku.ANNOTATION_NODE_TYPE: "bootstrap",
        LEVEL: "v3"}], "one write"


def test_the_agent_corrects_a_level_another_boot_left(node):
    # /run is empty after the reboot: a new CPU model is found anew
    host = node()
    host.annotations[LEVEL] = "v3"
    host.ld_so_help = ld_so_help("fedora43-v2.txt")
    run_cli(host, "agent")
    assert host.annotations[LEVEL] == "v2"


def test_a_node_that_cannot_tell_removes_the_level(node):
    # unknown, not a stale value: the operator then takes the older-CPU build
    host = node()
    host.annotations[LEVEL] = "v3"
    run_cli(host, "agent")
    assert LEVEL not in host.annotations


def test_the_agent_never_writes_it_on_aarch64(node):
    host = node()
    host.arch = lambda: "arm64"
    host.ld_so_help = ld_so_help("fedora43-v3.txt")
    run_cli(host, "agent")
    assert host.annotations[ku.ANNOTATION_RELEASE] == "v2.4.0"
    assert all(LEVEL not in p for p in host.patches)
    assert not ld_so_runs(host)


def test_the_hop_reports_leave_the_level_alone():
    # Only the agent writes it: a phase report of a hop has no level to say.
    assert LEVEL not in ku.node_report(None, "worker", "v2.4.0")
    assert ku.node_report(None, "worker", "v2.4.0", x86_64_level="v2")[LEVEL] == "v2"
    assert ku.node_report(None, "worker", "v2.4.0", x86_64_level="")[LEVEL] is None
