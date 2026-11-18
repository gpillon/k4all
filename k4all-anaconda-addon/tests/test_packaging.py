from configparser import ConfigParser
from pathlib import Path


def test_k4all_is_an_activatable_anaconda_module():
    config_path = Path(__file__).parents[1] / "data" / "95-k4all-addon.conf"
    config = ConfigParser()
    config.read(config_path)

    modules = config["Anaconda"]["activatable_modules"].split()

    assert "org.fedoraproject.Anaconda.Addons.K4All" in modules
    assert {
        "org.fedoraproject.Anaconda.Modules.Network",
        "org.fedoraproject.Anaconda.Modules.Payloads",
        "org.fedoraproject.Anaconda.Modules.Runtime",
        "org.fedoraproject.Anaconda.Modules.Security",
        "org.fedoraproject.Anaconda.Modules.Services",
        "org.fedoraproject.Anaconda.Modules.Storage",
        "org.fedoraproject.Anaconda.Modules.Users",
    }.issubset(modules)


def test_updates_image_contains_shared_storage_generator_source():
    addon_root = Path(__file__).parents[1]
    source = addon_root / "com_k4all_installer" / "storage_layout.py"

    assert source.is_file()
    assert "def build_kickstart_layout" in source.read_text()
