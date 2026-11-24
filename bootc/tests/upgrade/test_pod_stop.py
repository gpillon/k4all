"""The pods stopped right before a hop's reboot (k4all#98).

kubelet stops first, so nothing restarts them. Then every ready pod sandbox
is stopped with `crictl --timeout=<deadline> stopp`, all at once. CRI-O takes
the containers' stop timeout from that deadline, and kills them when it
runs out. Up to v2.6.6 every pod got 30 s, whatever it asked for, so a VM's
guest lost QEMU halfway through its shutdown: KubeVirt gives a virt-launcher
pod its VMI's grace period plus 30 s (210 s for a VMI of 180 s), and on a
single node nothing drains the VMs first.

From v2.6.7 a pod gets its own terminationGracePeriodSeconds, at least 30 s
(what every pod got before) and at most podStopMaxSeconds (default 300). The
pods stop in parallel, so the reboot waits for the longest of them, never
more than podStopMaxSeconds.
"""

import os
import subprocess
import time

import pytest

from conftest import Proc, ku, release, run_cli, sandbox, write_graph

STREAM_23 = [
    release("v2.2.4", "patch", "v2.0.0-beta1", "1.35.6", "1.32", 43),
    release("v2.3.0", "minor", "v2.2.4", "1.35.10", "1.35", 43),
    release("v2.3.1", "patch", "v2.3.0", "1.35.10", "1.35", 43),
]

# KubeVirt 1.9.1 in the lab: a VMI of 180 s has a launcher pod of 210 s, with
# the compute container and the serial console's.
LAUNCHER = sandbox("p-vm", "vms", "virt-launcher-slow-shutdown-7xq2m", grace=210,
                   containers=("compute", "guest-console-log"))
WINDOWS = sandbox("p-win", "vms", "virt-launcher-win11-k8d2c", grace=3630,
                  containers=("compute",))
CILIUM = sandbox("p-cilium", "kube-system", "cilium-vq9zt", grace=1)


def single_node(make_host, *sandboxes, policy=None):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM_23)
    host.sandboxes += list(sandboxes)
    if policy is not None:
        host.write(ku.CONFIG_FILE, policy)
    return host


def stops(host):
    """The time each pod got at the last stop: {pod id: seconds}."""
    lines = [line.split() for line in host.pod_stops[-1].splitlines()]
    return {pod: int(seconds) for seconds, pod in lines}


def hop(host):
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 0
    assert host.reboots == 1


# --- how long each pod gets ---------------------------------------------------
def test_a_vm_gets_its_grace_period_before_the_reboot(make_host):
    host = single_node(make_host, LAUNCHER, CILIUM)
    hop(host)
    assert stops(host) == {"p-vm": 210, "p-etcd": 30, "p-dns": 30,
                           "p-cilium": 30}, \
        "its own grace period, never less than the 30 s of before"
    assert host.pods_stopped == 1, "in one go: the pods stop in parallel"
    stop = host.calls.index(["systemctl", "stop", "kubelet"])
    listed = host.calls.index(ku.CRICTL.split() + ["ps", "-o", "json"])
    assert stop < listed, "listed once kubelet cannot start anything new"
    assert any("vms/virt-launcher-slow-shutdown-7xq2m 210 s" in m
               for m in host.logs), "the long ones are named"


def test_a_grace_period_above_the_most_is_cut_to_it(make_host):
    host = single_node(make_host, LAUNCHER, WINDOWS)
    hop(host)
    assert stops(host)["p-win"] == 300
    assert stops(host)["p-vm"] == 210
    assert any("vms/virt-launcher-win11-k8d2c 300 s (of the 3630 s it asks)" in m
               for m in host.logs)


@pytest.mark.parametrize("policy,win,vm,dns", [
    ("podStopMaxSeconds: 900\n", 900, 210, 30),
    ('podStopMaxSeconds: "900"\n', 900, 210, 30),
    ("podStopMaxSeconds: 120\n", 120, 120, 30),
    # never below the 30 s every pod had before
    ("podStopMaxSeconds: 5\n", 30, 30, 30),
])
def test_the_most_comes_from_the_policy(make_host, policy, win, vm, dns):
    host = single_node(make_host, LAUNCHER, WINDOWS, policy=policy)
    hop(host)
    got = stops(host)
    assert (got["p-win"], got["p-vm"], got["p-dns"]) == (win, vm, dns)


@pytest.mark.parametrize("value,shown", [
    ("soon", "'soon'"), ("2.5", "2.5"), ("true", "True"), ("-1", "-1"),
    ("null", "None")])
def test_a_policy_whose_most_is_not_a_number_is_refused(make_host, value, shown):
    host = single_node(make_host, policy="podStopMaxSeconds: %s\n" % value)
    assert run_cli(host, "run", "--to", "v2.3.1", "--yes") == 2
    assert "error: podStopMaxSeconds must be a whole number of seconds, " \
           "got %s" % shown in host.logs
    assert host.reboots == 0


def test_a_pod_without_a_running_container_gets_30_s(make_host):
    host = single_node(make_host, sandbox("p-idle", "jobs", "done-x", grace=None))
    hop(host)
    assert stops(host)["p-idle"] == 30


def test_pods_whose_grace_period_cannot_be_read_get_the_most(make_host):
    # Rather a slower reboot than a guest cut off.
    host = single_node(make_host, LAUNCHER)
    host.crictl_fails = {"ps"}
    hop(host)
    assert set(stops(host).values()) == {300}
    assert any(m.startswith("before the reboot: cannot read the grace periods "
                            "of the pods (") and "each pod gets up to 300 s" in m
               for m in host.logs)


def test_pods_that_cannot_be_listed_are_left_to_the_reboot(make_host):
    host = single_node(make_host, LAUNCHER)
    host.crictl_fails = {"pods"}
    hop(host)
    assert host.pods_stopped == 0
    assert any(m.startswith("before the reboot: cannot list the pods (")
               for m in host.logs)


def test_a_listing_that_crashes_does_not_stop_the_reboot(make_host):
    host = single_node(make_host, LAUNCHER)
    real = host._dispatch

    def stuck(argv, input_text):
        if argv[:1] == ["crictl"]:
            raise ku.subprocess.TimeoutExpired(argv, 60)
        return real(argv, input_text)
    host._dispatch = stuck
    hop(host)
    assert any(m.startswith("before the reboot: cannot list the pods (")
               for m in host.logs)


def test_the_log_says_how_the_long_pods_stopped(make_host):
    host = single_node(make_host, LAUNCHER, WINDOWS,
                       sandbox("p-stuck", "apps", "sleeper-0", grace=30))
    host.pod_stop_took = {"p-vm": 95, "p-win": 300, "p-stuck": 30}
    hop(host)
    assert "before the reboot: vms/virt-launcher-slow-shutdown-7xq2m stopped " \
           "in 95 s (of 210 s)" in host.logs
    assert "before the reboot: vms/virt-launcher-win11-k8d2c did not stop " \
           "within 300 s (it asks 3630 s): CRI-O killed it" in host.logs
    assert "before the reboot: apps/sleeper-0 did not stop within 30 s: " \
           "CRI-O killed it" in host.logs
    assert not [m for m in host.logs if "coredns" in m and "stop" in m], \
        "a pod that stops in its first seconds is not worth a line"


# VM 980, hop v2.6.7 -> v2.6.91: CRI-O tears a pod's network down before it
# stops its containers, and the Cilium agent stops at the same time: 27 of
# about 40 pods waited ~32 s on cilium-cni ("Agent is starting up, will
# retry"), then their stop failed with the containers untouched. A long
# stop retried in time (test_the_stop_script_retries_...) ends well; a stop
# that failed is not a pod CRI-O killed.
def test_the_log_names_the_stops_that_failed(make_host):
    host = single_node(make_host, LAUNCHER,
                       sandbox("p-hook", "nmstate", "nmstate-webhook-7c49", grace=30))
    host.pod_stop_rc = {"p-vm": 1, "p-hook": 1, "p-dns": 1}
    host.pod_stop_took = {"p-vm": 210, "p-hook": 32, "p-dns": 32}
    hop(host)
    assert "before the reboot: vms/virt-launcher-slow-shutdown-7xq2m: its stop " \
           "failed within its 210 s; the reboot ends it" in host.logs
    assert "before the reboot: the stop of 3 pods failed (CRI-O tears the " \
           "network down first, and the CNI may be stopping too; the reboot " \
           "ends them): kube-system/coredns-5d78c9869d-x2k4q, " \
           "nmstate/nmstate-webhook-7c49, vms/virt-launcher-slow-shutdown-7xq2m" \
           in host.logs
    assert not [m for m in host.logs if "CRI-O killed it" in m]


def test_the_log_names_the_stops_that_needed_another_try(make_host):
    host = single_node(make_host, LAUNCHER)
    host.pod_stop_took, host.pod_stop_tries = {"p-vm": 125}, {"p-vm": 2}
    hop(host)
    assert "before the reboot: vms/virt-launcher-slow-shutdown-7xq2m stopped " \
           "in 125 s (of 210 s)" in host.logs
    assert "before the reboot: 1 pods stopped at a second or third try, their " \
           "network teardown having failed first: " \
           "vms/virt-launcher-slow-shutdown-7xq2m" in host.logs


def test_the_rollback_reboot_gives_the_pods_their_time_too(make_host):
    host = single_node(make_host, LAUNCHER)
    host.healthy_after_boot = False
    hop(host)
    run_cli(host, "resume")
    assert ku.load_state(host)["phase"] == "ROLLBACK_REBOOT"
    assert host.pods_stopped == 2
    assert stops(host)["p-vm"] == 210


# --- the script that stops them -------------------------------------------------
def fake_crictl(tmp_path, body):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "stopp.log"
    crictl = bin_dir / "crictl"
    crictl.write_text("#!/bin/bash\n" + body % {"log": log})
    crictl.chmod(0o755)
    return dict(os.environ, PATH="%s:%s" % (bin_dir, os.environ["PATH"])), log


def test_the_stop_script_gives_each_pod_its_own_deadline(tmp_path):
    env, log = fake_crictl(tmp_path, 'sleep 1; echo "$*" >> %(log)s\n')
    started = time.monotonic()
    got = subprocess.run(["sh", "-c", ku.STOP_PODS_SCRIPT], env=env, check=True,
                         input="30 p1\n210 p2\n300 p3\n", capture_output=True,
                         text=True)
    elapsed = time.monotonic() - started
    calls = sorted(log.read_text().splitlines())
    # CRI-O keeps 1 s of the deadline for the call and 1 s for the infra
    # container: the containers get the pod's time.
    assert calls == [
        "--runtime-endpoint unix:///run/crio/crio.sock --timeout=212s stopp p2",
        "--runtime-endpoint unix:///run/crio/crio.sock --timeout=302s stopp p3",
        "--runtime-endpoint unix:///run/crio/crio.sock --timeout=32s stopp p1"]
    assert elapsed < 2.5, "the pods stop in parallel"
    took = sorted(line.split()[:2] for line in got.stdout.splitlines())
    assert took == [["p1", "0"], ["p2", "0"], ["p3", "0"]]
    assert all(1 <= int(line.split()[2]) <= 2 for line in got.stdout.splitlines())


def test_the_stop_script_retries_a_stop_whose_network_teardown_failed(tmp_path):
    # CRI-O marks the network stopped even when its teardown failed, so the
    # second stop goes straight to the containers, with the time left.
    env, log = fake_crictl(tmp_path,
                           'echo "$*" >> %(log)s\n'
                           'case "$*" in *" p2")\n'
                           '  if [ ! -e %(log)s.p2 ]; then touch %(log)s.p2; sleep 2;\n'
                           '    echo "network teardown failed for pod sandbox" >&2; exit 1; fi ;;\n'
                           'esac\n')
    got = subprocess.run(["sh", "-c", ku.STOP_PODS_SCRIPT], env=env,
                         input="30 p1\n10 p2\n", capture_output=True, text=True)
    assert got.returncode == 0, got.stderr
    calls = [line.split() for line in log.read_text().splitlines()]
    p2 = [c[-3] for c in calls if c[-1] == "p2"]
    assert len(p2) == 2 and p2[0] == "--timeout=12s"
    assert p2[1] in ("--timeout=9s", "--timeout=10s"), "the time left, not more"
    assert len([c for c in calls if c[-1] == "p1"]) == 1
    assert sorted(line.split()[:2] + line.split()[3:] for line in
                  got.stdout.splitlines()) == [["p1", "0", "1"], ["p2", "0", "2"]]


def test_the_stop_script_gives_up_when_the_time_is_over(tmp_path):
    env, log = fake_crictl(tmp_path,
                           'echo "$*" >> %(log)s\n'
                           'case "$*" in *" p3") sleep 3; exit 1 ;;\n'
                           '  *" p4") exit 1 ;; esac\n')
    started = time.monotonic()
    got = subprocess.run(["sh", "-c", ku.STOP_PODS_SCRIPT], env=env,
                         input="3 p3\n30 p4\n", capture_output=True, text=True)
    assert time.monotonic() - started < 10, "no loop on a stop that keeps failing"
    calls = [line.split()[-1] for line in log.read_text().splitlines()]
    assert calls.count("p3") == 1, "its 3 s are over: no second try"
    assert calls.count("p4") == 3, "at most 3 tries"
    assert got.returncode == ku.XARGS_SOME_FAILED
    assert sorted(line.split()[:2] for line in got.stdout.splitlines()) == \
        [["p3", "1"], ["p4", "1"]]


def test_the_stop_script_says_which_stop_failed(tmp_path):
    env, _ = fake_crictl(tmp_path, 'case "$*" in *" p2") echo "rpc error: '
                                   'device or resource busy" >&2; exit 1 ;; esac\n')
    got = subprocess.run(["sh", "-c", ku.STOP_PODS_SCRIPT], env=env,
                         input="30 p1\n30 p2\n", capture_output=True, text=True)
    assert got.returncode == ku.XARGS_SOME_FAILED
    assert sorted(line.split()[:2] for line in got.stdout.splitlines()) == \
        [["p1", "0"], ["p2", "1"]]
    assert "device or resource busy" in got.stderr


# --- the plan, on its own --------------------------------------------------------
def crictl_pods(*pods):
    return [{"id": i, "metadata": {"namespace": ns, "name": n}} for i, ns, n in pods]


def crictl_containers(*containers):
    return [{"id": "c%d" % k, "podSandboxId": pod,
             "annotations": {} if grace is None else {ku.GRACE_ANNOTATION: grace}}
            for k, (pod, grace) in enumerate(containers)]


def test_the_plan_takes_the_longest_grace_period_of_a_pod():
    plan = ku.pod_stop_plan(
        crictl_pods(("a", "ns", "web-0"), ("b", "ns", "vm"), ("c", "ns", "odd")),
        crictl_containers(("a", "30"), ("b", "60"), ("b", "210"), ("c", "x"),
                          ("c", None), ("gone", "999")),
        300)
    assert plan == [(210, "b", "ns/vm", 210), (30, "c", "ns/odd", None),
                    (30, "a", "ns/web-0", 30)]


def test_without_the_containers_every_pod_gets_the_most():
    plan = ku.pod_stop_plan(crictl_pods(("a", "ns", "web-0")), None, 300)
    assert plan == [(300, "a", "ns/web-0", None)]


# --- the preflight warns about what the reboot will cut -----------------------------
def api_pod(name, grace, namespace="vms", node="k4all-node-1", phase="Running"):
    # a virt-launcher pod: its VMI is its controller
    owner = {"apiVersion": "kubevirt.io/v1", "kind": "VirtualMachineInstance",
             "name": name, "uid": "u", "controller": True}
    return {"metadata": {"namespace": namespace, "name": name,
                         "ownerReferences": [owner]},
            "spec": {"nodeName": node, "terminationGracePeriodSeconds": grace},
            "status": {"phase": phase}}


def test_a_single_node_warns_about_pods_that_ask_for_more_than_the_most(make_host):
    host = single_node(make_host, WINDOWS)
    host.pods = [api_pod("virt-launcher-win11-k8d2c", 3630),
                 api_pod("virt-launcher-slow-shutdown-7xq2m", 210),
                 api_pod("old-job", 9999, phase="Succeeded"),
                 api_pod("elsewhere", 9999, node="k4all-node-2")]
    hop(host)
    warning = ku.load_state(host)["hop"]["warning"]
    assert warning.startswith(
        "a single node is not drained, and the reboot gives each pod at most "
        "300 s to stop (podStopMaxSeconds): vms/virt-launcher-win11-k8d2c asks "
        "3630 s. ")
    assert "virtctl stop" in warning and "/etc/k4all-upgrade.yaml" in warning
    assert "slow-shutdown" not in warning and "old-job" not in warning \
        and "elsewhere" not in warning
    assert host.annotations[ku.ANNOTATION_MESSAGE].startswith(
        "a single node is not drained")
    assert any(m.startswith("WARNING: a single node is not drained")
               for m in host.logs)


def test_the_warning_shows_in_status(make_host, capsys):
    host = single_node(make_host, WINDOWS)
    host.pods = [api_pod("virt-launcher-win11-k8d2c", 3630)]
    hop(host)
    capsys.readouterr()
    assert run_cli(host, "status") == 0
    assert "Warning:   a single node is not drained" in capsys.readouterr().out


def test_a_single_node_without_long_pods_has_no_warning(make_host):
    host = single_node(make_host, LAUNCHER)
    host.pods = [api_pod("virt-launcher-slow-shutdown-7xq2m", 210)]
    hop(host)
    assert not ku.load_state(host)["hop"].get("warning")


def test_a_node_that_is_drained_has_no_warning(make_host):
    # Its VMs move off with their whole grace period: the drain evicts them.
    host = make_host(version="v2.3.0", kubernetes="1.35.10", role="control")
    host.node_count = 2
    write_graph(host, STREAM_23)
    host.pods = [api_pod("virt-launcher-win11-k8d2c", 3630)]
    hop(host)
    assert not ku.load_state(host)["hop"].get("warning")


def test_pods_that_cannot_be_read_only_skip_the_warning(make_host):
    host = single_node(make_host, WINDOWS)
    real = host._kubectl

    def failing(args, input_text, kubeconfig=""):
        if args[:3] == ["get", "pods", "-A"]:
            return Proc(returncode=1, stderr="the server is currently unable")
        return real(args, input_text, kubeconfig)
    host._kubectl = failing
    hop(host)
    assert not ku.load_state(host)["hop"].get("warning")
    assert any(m.startswith("cannot check the grace periods of the pods")
               for m in host.logs)
