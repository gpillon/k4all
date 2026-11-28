"""The login message of a control plane: k4all-login-info (#130, #54).

The script runs for real in bash against a fake root, with a fake kubectl
that answers from a directory of Secrets.
"""

import os
import re
import stat
import subprocess
import textwrap

import pytest

from conftest import REPO

BOOTC = os.path.join(REPO, "bootc")
BIN = os.path.join(BOOTC, "overlay", "usr", "local", "bin")
SCRIPT = os.path.join(BIN, "k4all-login-info")
PH3 = os.path.join(BIN, "overrides", "bootstrap-control", "setup-k8s-ph3.sh")

BEGIN = "#### K4ALL HELPER ####"
END = "#### END K4ALL HELPER ####"
CALL = ("if [ -x /usr/local/bin/k4all-login-info ]; then "
        "/usr/local/bin/k4all-login-info; fi")

# The block setup-k8s-ph3.sh wrote up to v2.7.1, as a node has it.
OLD_BLOCK = textwrap.dedent("""\
    #### K4ALL HELPER ####
    #### pls, DO NOT REMOVE "K4ALL HELPER" tags, or you could mess up updates :) ###

    HOST_IP=$(hostname -I | awk '{print $1}')
    echo ""
    echo "Welcome! Connect to the dashboard using those addresses: "
    if [ -f /etc/login_data ]; then
        cat /etc/login_data
    fi
    echo " - Nodeport Fallback Route: http://$HOST_IP:32323"
    echo ""
    echo "Using this token"
    echo "$(kubectl get secret headlamp-admin-token -n headlamp -o jsonpath={".data.token"} | base64 -d)"
    echo ""
    #### END K4ALL HELPER ####
    """)

ADVERTISE = textwrap.dedent("""\
    #### K4ALL ADVERTISE CHECK ####
    #### pls, DO NOT REMOVE "K4ALL HELPER" tags, or you could mess up updates :) ###
    sh /var/opt/k4all/bin/check-advertise-address.sh
    #### END K4ALL ADVERTISE CHECK ####
    """)

FAKE_KUBECTL = textwrap.dedent("""\
    #!/bin/bash
    # Fake kubectl: get secret NAME answers from $FAKE_SECRETS/NAME.
    echo "$*" >> "$FAKE_SECRETS/../kubectl.log"
    set -- $*
    while [ $# -gt 0 ]; do
      if [ "$1" = secret ]; then name=$2; break; fi
      shift
    done
    if [ -n "$name" ] && [ -f "$FAKE_SECRETS/$name" ]; then
      printf '%s' "$(base64 -w0 < "$FAKE_SECRETS/$name")"
      exit 0
    fi
    echo "Error from server (NotFound): secrets \\"$name\\" not found" >&2
    exit 1
    """)


def read(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as fh:
        return fh.read()


def block(text):
    """The K4ALL HELPER block of a .bash_profile, tags included."""
    start = text.index(BEGIN + "\n")
    return text[start:text.index(END, start) + len(END)]


@pytest.fixture
def node(tmp_path):
    root = tmp_path / "root"
    (root / "root").mkdir(parents=True)
    (root / "etc").mkdir()
    secrets = tmp_path / "secrets"
    secrets.mkdir()
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    kubectl = bin_dir / "kubectl"
    kubectl.write_text(FAKE_KUBECTL)
    kubectl.chmod(kubectl.stat().st_mode | stat.S_IEXEC)

    class Node:
        profile = root / "root" / ".bash_profile"
        login_data = root / "etc" / "login_data"

        @staticmethod
        def secret(name, token):
            (secrets / name).write_text(token)

        @staticmethod
        def run(*args):
            env = dict(os.environ, K4ALL_ROOT=str(root), FAKE_SECRETS=str(secrets),
                       PATH="%s:%s" % (bin_dir, os.environ["PATH"]))
            proc = subprocess.run(["bash", SCRIPT, *args], env=env,
                                  capture_output=True, text=True, check=False)
            assert proc.returncode == 0, proc.stdout + proc.stderr
            return proc

    return Node


# --- the message ------------------------------------------------------------
def test_a_2x_cluster_shows_the_operators_token(node):
    node.login_data.write_text(" - https://dashboard.example.test\n")
    node.secret("headlamp-admin-token", "token-of-2x")
    node.secret("admin-user", "token-of-1x")
    out = node.run().stdout
    assert " - https://dashboard.example.test" in out
    assert re.search(r"Nodeport Fallback Route: http://\S*:32323", out)
    assert "Using this token\ntoken-of-2x\n" in out
    assert "token-of-1x" not in out


def test_a_cluster_restored_from_1x_shows_admin_user(node):
    node.secret("admin-user", "token-of-1x")
    out = node.run().stdout
    assert "Using this token\ntoken-of-1x\n" in out


def test_without_a_token_it_says_how_to_get_one(node):
    out = node.run().stdout
    assert "Using this token" not in out
    assert "kubectl -n headlamp create token headlamp-admin" in out
    assert "NotFound" not in out, "kubectl's errors stay out of the login"


def test_the_api_server_cannot_hold_up_the_login(node):
    node.run()
    log = (node.profile.parent.parent.parent / "kubectl.log").read_text()
    assert all("--request-timeout=5s" in line for line in log.splitlines())


# --- the K4ALL HELPER block -------------------------------------------------
def profile_with(helper):
    return ("# .bash_profile\n\n" + ADVERTISE + "\n" + helper +
            "\n# kubectl shell completion\nsource <(kubectl completion bash)\n")


def test_the_old_block_is_rewritten_once_and_stays(node):
    node.profile.write_text(profile_with(OLD_BLOCK))
    node.profile.chmod(0o600)
    proc = node.run("--update-profile")
    assert "now calls k4all-login-info" in proc.stdout
    text = node.profile.read_text()
    assert block(text) == "\n".join(
        [BEGIN, '#### pls, DO NOT REMOVE "K4ALL HELPER" tags, or you could '
         'mess up updates :) ###', CALL, END])
    assert text == profile_with(block(text) + "\n"), "nothing else changes"
    assert stat.S_IMODE(node.profile.stat().st_mode) == 0o600
    before = node.profile.stat()
    proc = node.run("--update-profile")
    assert proc.stdout == "" and proc.stderr == ""
    after = node.profile.stat()
    assert (after.st_ino, after.st_mtime_ns) == (before.st_ino, before.st_mtime_ns), \
        "not written again"


def test_a_new_control_plane_gets_the_same_block_from_ph3(node):
    script = read(PH3)
    start = script.index("\n" + BEGIN + "\n") + 1
    ph3_block = script[start:script.index(END, start) + len(END)]
    node.profile.write_text(profile_with(ph3_block + "\n"))
    before = node.profile.stat()
    assert node.run("--update-profile").stdout == ""
    assert node.profile.stat().st_mtime_ns == before.st_mtime_ns
    assert CALL in ph3_block
    assert "kubectl get secret" not in ph3_block


@pytest.mark.parametrize("text", [
    "# no helper here\n",
    "# .bash_profile\n" + BEGIN + "\necho half a block\n",
])
def test_a_profile_without_a_whole_block_is_left_alone(node, text):
    node.profile.write_text(text)
    before = node.profile.stat()
    node.run("--update-profile")
    assert node.profile.read_text() == text
    assert node.profile.stat().st_mtime_ns == before.st_mtime_ns


def test_no_profile_no_change(node):
    node.run("--update-profile")
    assert not node.profile.exists()


def test_the_block_runs_the_script_where_it_is_installed(tmp_path):
    profile = tmp_path / "profile"
    profile.write_text("\n".join([BEGIN, CALL, END, "echo after"]) + "\n")
    proc = subprocess.run(["bash", "-c", 'source "$1"', "bash", str(profile)],
                          capture_output=True, text=True, check=False)
    if not os.path.exists("/usr/local/bin/k4all-login-info"):
        assert proc.returncode == 0 and proc.stdout == "after\n" and proc.stderr == "", \
            "after a rollback to an image without the script: quiet"


# --- where it runs ----------------------------------------------------------
def test_the_unit_rewrites_the_block_at_every_boot_after_a_restore():
    unit = read(BOOTC, "systemd", "k4all-login-info.service")
    assert re.search(r"^After=.*\bfck8s-restore\.service\b", unit, re.M), \
        "a restore brings back the .bash_profile of the backup"
    assert re.search(r"^After=.*\bfck8s-k8s-setup-ph3\.service\b", unit, re.M)
    assert ("ExecStart=/usr/local/bin/k4all-login-info --update-profile "
            "/root/.bash_profile") in unit
    assert "WantedBy=multi-user.target" in unit
    assert "systemctl enable k4all-login-info.service" in read(BOOTC, "Containerfile")
    assert os.access(SCRIPT, os.X_OK)

