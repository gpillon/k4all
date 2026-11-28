"""`bootc status` can block for minutes (#131, #49 item 5).

bootc holds its lock while it downloads (a hop's STAGE, a `bootc switch` or
`bootc upgrade` by hand), and `bootc status` from another process waits
until the download ends. Every call has a timeout and a fallback: the agent
and the preflight say "bootc busy (download in progress)" and try again,
`status` shows the release as unknown, kubeadm comes from dl.k8s.io and the
control-plane images are pulled. The node-settings pass of the agent is in
test_node_settings.py, the bridge script in test_bridge_script.py.
"""

import hashlib
import os

import pytest

from conftest import Proc, ku, release, run_cli, write_graph

# v2.3.1 also moves the Kubernetes patch: its hop runs kubeadm.
STREAM = [
    release("v2.3.0", "minor", "v2.2.4", "1.35.10", "1.35", 43),
    release("v2.3.1", "patch", "v2.3.0", "1.35.11", "1.35", 43),
]

BUSY = "bootc busy (download in progress): `bootc status` did not answer within"


def node(make_host, **kwargs):
    host = make_host(version="v2.3.0", kubernetes="1.35.10", **kwargs)
    write_graph(host, STREAM)
    return host


def finish(host, limit=10):
    for _ in range(limit):
        st = ku.load_state(host)
        if not st or st["phase"] == "DONE" or st.get("hold"):
            return st
        run_cli(host, "resume")
    raise AssertionError("upgrade did not settle")


def test_every_bootc_status_of_a_hop_has_a_timeout(make_host):
    host = node(make_host)
    run_cli(host, "run", "--to", "v2.3.1", "--yes")
    assert finish(host)["current"] == "v2.3.1"
    assert len(host.bootc_status_timeouts) >= 4, \
        "preflight, stage (twice), the staged kubeadm, its images"
    assert None not in host.bootc_status_timeouts


def test_a_bootc_status_that_runs_out_of_time_is_bootc_busy(make_host):
    host = make_host()
    host.bootc_busy = True
    with pytest.raises(ku.BootcBusy) as exc:
        ku.bootc_status(host, 7)
    assert str(exc.value) == BUSY + " 7 s"
    assert host.bootc_status_timeouts == [7]


def test_a_failing_bootc_status_is_a_plain_error(make_host):
    host = make_host()
    real = host._bootc
    host._bootc = lambda args: Proc(returncode=1, stderr="error: opening sysroot") \
        if args[:1] == ["status"] else real(args)
    with pytest.raises(ku.UpgradeError) as exc:
        ku.bootc_status(host)
    assert not isinstance(exc.value, ku.BootcBusy)
    assert "bootc status --json failed (rc=1): error: opening sysroot" in str(exc.value)


def test_the_preflight_waits_for_a_busy_bootc_without_a_hold(make_host):
    host = node(make_host)
    host.bootc_busy = True
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 3
    assert ku.load_state(host) is None, "not yet: no plan, no HOLD"
    assert any(m.startswith("not yet: " + BUSY) for m in host.logs)
    assert host.bootc_status_timeouts == [ku.BOOTC_STATUS_QUICK]

    host.bootc_busy = False             # the download by hand is over
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert host.reboots == 1


def test_the_agent_says_bootc_is_busy_and_tries_again(make_host):
    host = node(make_host)
    host.write(ku.CONFIG_FILE, "mode: managed\n")
    host.bootc_busy = True
    host.annotations[ku.ANNOTATION_TARGET] = "v2.3.1"
    assert run_cli(host, "agent") == 0
    st = ku.load_state(host)
    assert st["phase"] == "PREFLIGHT" and not st.get("hold")
    assert st["waiting"].startswith(BUSY)
    assert host.annotations[ku.ANNOTATION_MESSAGE].startswith("waiting: " + BUSY)

    host.bootc_busy = False
    assert run_cli(host, "agent") == 0
    assert ku.load_state(host)["phase"] == "REBOOT"


def test_status_says_the_release_is_unknown_instead_of_blocking(make_host, capsys):
    host = make_host()
    os.remove(host.path(ku.VERSION_FILE))   # bootc is asked only without it
    host.bootc_busy = True
    capsys.readouterr()
    assert run_cli(host, "status") == 0
    assert "Release:   unknown (%s %d s)" % (BUSY, ku.BOOTC_STATUS_QUICK) \
        in capsys.readouterr().out
    assert host.bootc_status_timeouts == [ku.BOOTC_STATUS_QUICK]


def busy_once_staged(host):
    """bootc answers STAGE's check of the staged deployment, then is busy:
    the staged kubeadm and its images cannot be read."""
    real = host.run
    asked = []

    def run(argv, check=True, input_text=None, timeout=None):
        if argv[:2] == ["bootc", "status"] and host.staged:
            asked.append(timeout)
            host.bootc_busy = len(asked) > 1
        return real(argv, check, input_text, timeout)
    host.run = run


def test_kubeadm_and_its_images_come_from_the_network_when_bootc_is_busy(make_host):
    host = node(make_host)
    busy_once_staged(host)
    kubeadm = b"#!kubeadm v1.35.11\n"
    host.fetch = lambda url, timeout=20: kubeadm if not url.endswith(".sha256") \
        else (hashlib.sha256(kubeadm).hexdigest() + "  kubeadm\n").encode()

    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert any(m.startswith(BUSY) and m.endswith("; kubeadm comes from dl.k8s.io")
               for m in host.logs)
    assert any(m.startswith(BUSY) and m.endswith("; kubeadm pulls the "
                                                 "control-plane images")
               for m in host.logs)
    pull = [c for c in host.calls if c[1:4] == ["config", "images", "pull"]]
    assert pull and pull[0][0].endswith("/kubeadm-1.35.11")
    assert [c for c in host.calls if c[1:3] == ["upgrade", "apply"]]
    assert host.reboots == 1
