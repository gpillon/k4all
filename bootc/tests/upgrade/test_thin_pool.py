"""PREFLIGHT checks the thin pool under /sysroot and /var (#131, #49 item 2).

df sees the filesystem only: on a thin LV the pool can be almost full while
df shows plenty, and a hop downloads one image per release. A real node had
its root pool at 83% while df showed 78% free. When /sysroot or /var sits on
a thin LV, the preflight also reads the pool's data and metadata percent
(`lvs --reportformat json`) and stops in HOLD above maxThinPoolPercent
(default 90, /etc/k4all-upgrade.yaml).
"""

import json

import pytest

from conftest import ku, release, run_cli, write_graph

STREAM = [
    release("v2.3.0", "minor", "v2.2.4", "1.35.10", "1.35", 43),
    release("v2.3.1", "patch", "v2.3.0", "1.35.10", "1.35", 43),
]


def lv(vg, name, attr, pool="", data="", meta="", minor=0):
    return {"vg_name": vg, "lv_name": name, "lv_attr": attr, "pool_lv": pool,
            "data_percent": data, "metadata_percent": meta,
            "lv_kernel_major": "253", "lv_kernel_minor": str(minor)}


def lvs_json(*lvs):
    """What `lvs --reportformat json -o ku.LVS_FIELDS` prints (lvm2 2.03)."""
    return json.dumps({"report": [{"lv": list(lvs)}], "log": []}, indent=2)


def thin_root(pool_data, pool_meta, data_pool="35.02"):
    """A node installed by 1.x: / on a thin LV, TopoLVM's pool in vg_data."""
    return lvs_json(
        lv("rootvg", "pool00", "twi-aotz--", data=pool_data, meta=pool_meta, minor=2),
        lv("rootvg", "root", "Vwi-aotz--", pool="pool00", data="78.12", minor=3),
        lv("vg_data", "thin-pool", "twi-aotz--", data=data_pool, meta="10.20", minor=6),
        lv("vg_data", "8c1f2a4e-6b7d-4f0e-9a51-0d2b7c9e1f33", "Vwi-aotz--",
           pool="thin-pool", data="98.70", minor=7))


LINEAR_ROOT = lvs_json(
    lv("rootvg", "rootlv", "-wi-ao----", minor=0),
    lv("vg_data", "thin-pool", "twi-aotz--", data="99.20", meta="40.00", minor=6))


def node(make_host, lvs, mounts=None, policy=None):
    host = make_host(version="v2.3.0", kubernetes="1.35.10")
    write_graph(host, STREAM)
    # /var is a bind mount of the deployment's var on the /sysroot filesystem
    host.mounts = mounts if mounts is not None else {"/sysroot": "253:3",
                                                     "/var": "253:3"}
    host.lvs = lvs
    if policy is not None:
        host.write(ku.CONFIG_FILE, policy)
    return host


def hop(host):
    run_cli(host, "run", "--to", "v2.3.1", "--yes")
    return ku.load_state(host)


def staged(host):
    return [c for c in host.calls if c[:2] == ["bootc", "switch"]]


def test_a_pool_below_the_threshold_lets_the_hop_go_on(make_host):
    host = node(make_host, thin_root("83.10", "12.08"))
    st = hop(host)
    assert not st.get("hold") and st["phase"] == "REBOOT"
    assert ["lvs", "--reportformat", "json", "-o", ku.LVS_FIELDS] in host.calls


def test_a_full_pool_holds_in_preflight_with_its_numbers(make_host):
    host = node(make_host, thin_root("93.41", "12.08"))
    st = hop(host)
    assert st["phase"] == "PREFLIGHT" and st["hold"]
    assert st["hold"]["reason"] == (
        "the thin pool rootvg/pool00 under /sysroot and /var is too full for "
        "the hop: data 93.4%, metadata 12.1%, above maxThinPoolPercent 90 "
        "(/etc/k4all-upgrade.yaml). A full pool takes its filesystems down: "
        "free space in it (`fstrim --all`) or extend it (`lvextend`), then "
        "resume")
    assert not staged(host), "nothing downloaded"


def test_a_pool_whose_metadata_is_over_holds_too(make_host):
    host = node(make_host, thin_root("40.00", "95.02"))
    st = hop(host)
    assert "data 40.0%, metadata 95.0%, above maxThinPoolPercent 90" \
        in st["hold"]["reason"]


def test_a_node_not_on_a_thin_lv_keeps_the_df_check_alone(make_host):
    # the 2.x layout: / on a linear LV; TopoLVM's pool is not under / or /var
    host = node(make_host, LINEAR_ROOT, mounts={"/sysroot": "253:0", "/var": "253:0"})
    st = hop(host)
    assert not st.get("hold") and st["phase"] == "REBOOT"


def test_a_var_on_its_own_thin_lv_is_checked_apart(make_host):
    lvs = lvs_json(
        lv("rootvg", "root", "-wi-ao----", minor=0),
        lv("vg_var", "pool", "twi-aotz--", data="91.00", meta="5.00", minor=4),
        lv("vg_var", "var", "Vwi-aotz--", pool="pool", data="50.00", minor=5))
    host = node(make_host, lvs, mounts={"/sysroot": "253:0", "/var": "253:5"})
    st = hop(host)
    assert st["hold"]["reason"].startswith(
        "the thin pool vg_var/pool under /var is too full for the hop: data 91.0%")


@pytest.mark.parametrize("policy, hold", [
    ("maxThinPoolPercent: 95\n", False),
    ("maxThinPoolPercent: 93.4\n", True),
    ("maxThinPoolPercent: 100\n", False),
])
def test_the_threshold_comes_from_the_policy(make_host, policy, hold):
    host = node(make_host, thin_root("93.41", "12.08"), policy=policy)
    st = hop(host)
    assert bool(st.get("hold")) is hold


@pytest.mark.parametrize("value", ["90%", 0, 101, True, None])
def test_a_threshold_that_is_not_a_percentage_is_refused(value):
    with pytest.raises(ku.UpgradeError, match="maxThinPoolPercent must be"):
        ku.merge_config({"maxThinPoolPercent": value})


def test_lvs_that_fails_is_logged_and_the_hop_goes_on(make_host):
    host = node(make_host, None)
    st = hop(host)
    assert not st.get("hold") and st["phase"] == "REBOOT"
    assert ("cannot check the thin pools under /sysroot and /var (Volume group "
            "not found)") in host.logs


def test_without_findmnt_nothing_is_read(make_host):
    host = node(make_host, thin_root("99.00", "99.00"), mounts={})
    st = hop(host)
    assert not st.get("hold")
    assert not [c for c in host.calls if c[:1] == ["lvs"]]


def test_thin_pool_of_reads_the_pool_not_the_thin_lv():
    report = json.loads(thin_root("83.10", "12.08"))
    assert ku.thin_pool_of(report, "253:3") == ("rootvg/pool00", 83.1, 12.08)
    assert ku.thin_pool_of(report, "253:7") == ("vg_data/thin-pool", 35.02, 10.2)
    assert ku.thin_pool_of(report, "253:2") is None, "a pool is no thin LV"
    assert ku.thin_pool_of(report, "8:3") is None, "a partition"
    assert ku.thin_pool_of({}, "253:3") is None


def test_a_percent_lvs_leaves_empty_is_unknown():
    report = json.loads(lvs_json(
        lv("rootvg", "pool00", "twi-XXtz--", minor=2),
        lv("rootvg", "root", "Vwi-aotz--", pool="pool00", minor=3)))
    assert ku.thin_pool_of(report, "253:3") == ("rootvg/pool00", None, None)
