# =============================================================================
# K4All Anaconda Addon - Test Configuration
# =============================================================================
# This conftest.py sets up mock modules for pyanaconda, dasbus, pykickstart
# so the addon code can be tested without a full Anaconda environment.
# =============================================================================

import sys
import types
import argparse
from unittest.mock import MagicMock, PropertyMock

# =============================================================================
# Mock: dasbus
# =============================================================================
dasbus = types.ModuleType("dasbus")
dasbus.identifier = types.ModuleType("dasbus.identifier")
dasbus.server = types.ModuleType("dasbus.server")
dasbus.server.interface = types.ModuleType("dasbus.server.interface")
dasbus.server.property = types.ModuleType("dasbus.server.property")
dasbus.typing = types.ModuleType("dasbus.typing")

class MockDBusServiceIdentifier:
    def __init__(self, namespace=None, message_bus=None):
        self.namespace = namespace or ("test",)
        self.message_bus = message_bus
        self.service_name = ".".join(self.namespace)
        self.object_path = "/" + "/".join(self.namespace)
        self.interface_name = ".".join(self.namespace)
    def get_proxy(self):
        return MagicMock()

dasbus.identifier.DBusServiceIdentifier = MockDBusServiceIdentifier
dasbus.server.interface.dbus_interface = lambda name: lambda cls: cls
dasbus.server.property.emits_properties_changed = lambda fn: fn
dasbus.typing.Str = str
dasbus.typing.Bool = bool

sys.modules["dasbus"] = dasbus
sys.modules["dasbus.identifier"] = dasbus.identifier
sys.modules["dasbus.server"] = dasbus.server
sys.modules["dasbus.server.interface"] = dasbus.server.interface
sys.modules["dasbus.server.property"] = dasbus.server.property
sys.modules["dasbus.typing"] = dasbus.typing

# =============================================================================
# Mock: pykickstart
# =============================================================================
pykickstart = types.ModuleType("pykickstart")
pykickstart.options = types.ModuleType("pykickstart.options")

class MockKSOptionParser:
    """Mock for pykickstart.options.KSOptionParser that delegates to argparse."""
    def __init__(self, prog="", version=None, description=""):
        self._parser = argparse.ArgumentParser(
            prog=prog, description=description, add_help=False
        )
    def add_argument(self, *args, **kwargs):
        # Remove 'version' if present (not in argparse)
        kwargs.pop("version", None)
        self._parser.add_argument(*args, **kwargs)
    def parse_args(self, args=None, lineno=None):
        ns, _ = self._parser.parse_known_args(args or [])
        return ns

pykickstart.options.KSOptionParser = MockKSOptionParser
sys.modules["pykickstart"] = pykickstart
sys.modules["pykickstart.options"] = pykickstart.options

# =============================================================================
# Mock: pyanaconda
# =============================================================================
pyanaconda = types.ModuleType("pyanaconda")
pyanaconda.core = types.ModuleType("pyanaconda.core")
pyanaconda.core.dbus = types.ModuleType("pyanaconda.core.dbus")
pyanaconda.core.signal = types.ModuleType("pyanaconda.core.signal")
pyanaconda.core.kickstart = types.ModuleType("pyanaconda.core.kickstart")
pyanaconda.core.kickstart.addon = types.ModuleType("pyanaconda.core.kickstart.addon")
pyanaconda.core.configuration = types.ModuleType("pyanaconda.core.configuration")
pyanaconda.core.configuration.anaconda = types.ModuleType("pyanaconda.core.configuration.anaconda")
pyanaconda.modules = types.ModuleType("pyanaconda.modules")
pyanaconda.modules.common = types.ModuleType("pyanaconda.modules.common")
pyanaconda.modules.common.base = types.ModuleType("pyanaconda.modules.common.base")
pyanaconda.modules.common.task = types.ModuleType("pyanaconda.modules.common.task")
pyanaconda.modules.common.containers = types.ModuleType("pyanaconda.modules.common.containers")
pyanaconda.modules.common.constants = types.ModuleType("pyanaconda.modules.common.constants")
pyanaconda.modules.common.constants.namespaces = types.ModuleType("pyanaconda.modules.common.constants.namespaces")
pyanaconda.ui = types.ModuleType("pyanaconda.ui")
pyanaconda.ui.categories = types.ModuleType("pyanaconda.ui.categories")
pyanaconda.ui.gui = types.ModuleType("pyanaconda.ui.gui")
pyanaconda.ui.gui.spokes = types.ModuleType("pyanaconda.ui.gui.spokes")
pyanaconda.ui.tui = types.ModuleType("pyanaconda.ui.tui")
pyanaconda.ui.tui.spokes = types.ModuleType("pyanaconda.ui.tui.spokes")
pyanaconda.ui.common = types.ModuleType("pyanaconda.ui.common")

# D-Bus mock
pyanaconda.core.dbus.DBus = MagicMock()

# Signal mock
class MockSignal:
    def __init__(self):
        self._handlers = []
    def connect(self, handler):
        self._handlers.append(handler)
    def emit(self):
        for h in self._handlers:
            h()

pyanaconda.core.signal.Signal = MockSignal

# Kickstart mocks
pyanaconda.core.kickstart.VERSION = "DEVEL"

class MockAddonData:
    """Base class for addon kickstart data."""
    def __init__(self):
        pass
    def handle_header(self, args, line_number=None):
        pass
    def handle_line(self, line, line_number=None):
        pass
    def finalize(self):
        pass

pyanaconda.core.kickstart.addon.AddonData = MockAddonData

class MockKickstartSpecification:
    """Mock for KickstartSpecification."""
    addons = {}

pyanaconda.core.kickstart.KickstartSpecification = MockKickstartSpecification

# Task mock
class MockTask:
    """Mock base Task class."""
    @property
    def name(self):
        return "MockTask"
    def run(self):
        pass

pyanaconda.modules.common.task.Task = MockTask

# Service mocks
class MockKickstartService:
    """Mock base KickstartService class."""
    def __init__(self):
        pass
    def run(self):
        pass

pyanaconda.modules.common.base.KickstartService = MockKickstartService
class MockKickstartModuleInterface:
    """Mock base class for KickstartModuleInterface."""
    def __init__(self, implementation=None):
        self.implementation = implementation
    def connect_signals(self):
        pass
    def watch_property(self, name, signal):
        pass

pyanaconda.modules.common.base.KickstartModuleInterface = MockKickstartModuleInterface

# Containers mock
pyanaconda.modules.common.containers.TaskContainer = MagicMock()

# Configuration mock
conf_mock = MagicMock()
conf_mock.target.system_root = "/tmp/test-sysroot"
pyanaconda.core.configuration.anaconda.conf = conf_mock

# Namespaces mock
pyanaconda.modules.common.constants.namespaces.ADDONS_NAMESPACE = ("org", "fedoraproject", "Anaconda", "Addons")

# UI mocks
class MockSpokeCategory:
    displayOnHubGUI = ""
    displayOnHubTUI = ""
    sortOrder = 0
    title = ""

pyanaconda.ui.categories.SpokeCategory = MockSpokeCategory

class MockNormalSpoke:
    def __init__(self, *args, **kwargs): pass
    def initialize(self): pass
    def refresh(self): pass
    def apply(self): pass
    def execute(self): pass
    @property
    def ready(self): return True
    @property
    def completed(self): return True
    @property
    def mandatory(self): return True
    @property
    def status(self): return ""

pyanaconda.ui.gui.spokes.NormalSpoke = MockNormalSpoke

class MockNormalTUISpoke:
    def __init__(self, *args, **kwargs): pass
    def initialize(self): pass
    def setup(self, args=None): return True
    def refresh(self, args=None): pass
    def input(self, args, key): pass

pyanaconda.ui.tui.spokes.NormalTUISpoke = MockNormalTUISpoke

class MockFirstbootSpokeMixIn:
    pass

pyanaconda.ui.common.FirstbootSpokeMixIn = MockFirstbootSpokeMixIn

# Register all modules
for mod_name, mod in [
    ("pyanaconda", pyanaconda),
    ("pyanaconda.core", pyanaconda.core),
    ("pyanaconda.core.dbus", pyanaconda.core.dbus),
    ("pyanaconda.core.signal", pyanaconda.core.signal),
    ("pyanaconda.core.kickstart", pyanaconda.core.kickstart),
    ("pyanaconda.core.kickstart.addon", pyanaconda.core.kickstart.addon),
    ("pyanaconda.core.configuration", pyanaconda.core.configuration),
    ("pyanaconda.core.configuration.anaconda", pyanaconda.core.configuration.anaconda),
    ("pyanaconda.modules", pyanaconda.modules),
    ("pyanaconda.modules.common", pyanaconda.modules.common),
    ("pyanaconda.modules.common.base", pyanaconda.modules.common.base),
    ("pyanaconda.modules.common.task", pyanaconda.modules.common.task),
    ("pyanaconda.modules.common.containers", pyanaconda.modules.common.containers),
    ("pyanaconda.modules.common.constants", pyanaconda.modules.common.constants),
    ("pyanaconda.modules.common.constants.namespaces", pyanaconda.modules.common.constants.namespaces),
    ("pyanaconda.ui", pyanaconda.ui),
    ("pyanaconda.ui.categories", pyanaconda.ui.categories),
    ("pyanaconda.ui.gui", pyanaconda.ui.gui),
    ("pyanaconda.ui.gui.spokes", pyanaconda.ui.gui.spokes),
    ("pyanaconda.ui.tui", pyanaconda.ui.tui),
    ("pyanaconda.ui.tui.spokes", pyanaconda.ui.tui.spokes),
    ("pyanaconda.ui.common", pyanaconda.ui.common),
]:
    sys.modules[mod_name] = mod

# Additional TUI mocks for simpleline
simpleline = types.ModuleType("simpleline")
simpleline.render = types.ModuleType("simpleline.render")
simpleline.render.prompt = types.ModuleType("simpleline.render.prompt")
simpleline.render.screen = types.ModuleType("simpleline.render.screen")
simpleline.render.containers = types.ModuleType("simpleline.render.containers")
simpleline.render.widgets = types.ModuleType("simpleline.render.widgets")

class MockPrompt:
    CONTINUE = "c"

simpleline.render.prompt.Prompt = MockPrompt

class MockInputState:
    PROCESSED_AND_REDRAW = 1
    PROCESSED_AND_CLOSE = 2

simpleline.render.screen.InputState = MockInputState
simpleline.render.containers.ListColumnContainer = MagicMock
simpleline.render.widgets.CheckboxWidget = MagicMock
simpleline.render.widgets.EntryWidget = MagicMock

sys.modules["simpleline"] = simpleline
sys.modules["simpleline.render"] = simpleline.render
sys.modules["simpleline.render.prompt"] = simpleline.render.prompt
sys.modules["simpleline.render.screen"] = simpleline.render.screen
sys.modules["simpleline.render.containers"] = simpleline.render.containers
sys.modules["simpleline.render.widgets"] = simpleline.render.widgets
