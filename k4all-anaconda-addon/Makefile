# K4All Anaconda Addon Makefile
# Builds the updates.img for use with inst.updates=

ADDON_NAME = com_k4all_installer
OUTDIR = $(CURDIR)
PYTHON ?= $(shell command -v python3 2>/dev/null)

# Temporary build directory
TMPDIR := $(shell mktemp -d)
ADDONDIR = $(TMPDIR)/usr/share/anaconda/addons
SERVICESDIR = $(TMPDIR)/usr/share/dbus-1/services
CONFDIR = $(TMPDIR)/etc/dbus-1/system.d

.PHONY: all updates clean test help

_default: updates

all: updates

updates:
	@echo "=== Building K4All Anaconda addon updates.img ==="
	@echo -n "Working..."
	@mkdir -p $(ADDONDIR)
	@cp -par $(ADDON_NAME) $(ADDONDIR)/
	@mkdir -p $(SERVICESDIR)
	@cp -pa data/org.fedoraproject.Anaconda.Addons.K4All.service $(SERVICESDIR)/
	@mkdir -p $(CONFDIR)
	@cp -pa data/org.fedoraproject.Anaconda.Addons.K4All.conf $(CONFDIR)/
	@cd $(TMPDIR) ; find . | cpio -c -o --quiet | gzip -9 > $(OUTDIR)/k4all_addon_updates.img
	@rm -rf $(TMPDIR)
	@echo " done."
	@echo ""
	@echo "Output: $(OUTDIR)/k4all_addon_updates.img"
	@echo ""
	@echo "Usage:"
	@echo "  1. Host the file on HTTP/NFS or include in ISO"
	@echo "  2. Boot with: inst.updates=<url>/k4all_addon_updates.img"
	@echo ""
	@echo "For ISO remaster, copy to:"
	@echo "  ../bootc/iso/images/k4all_updates.img"

clean:
	rm -f $(OUTDIR)/k4all_addon_updates.img
	rm -rf $(TMPDIR)

# Copy to bootc ISO directory
install-bootc: updates
	@mkdir -p ../bootc/iso/images
	cp $(OUTDIR)/k4all_addon_updates.img ../bootc/iso/images/k4all_updates.img
	@echo "Installed to ../bootc/iso/images/k4all_updates.img"

# Run unit tests with mocked pyanaconda (fast, no network)
test:
	@echo "=== Running K4All Addon Unit Tests ==="
	PYTHONPATH="$(CURDIR):$(CURDIR)/tests" $(PYTHON) -m pytest tests/ -v --tb=short
	@echo ""
	@echo "=== Running syntax checks ==="
	$(PYTHON) -m py_compile $(ADDON_NAME)/*.py
	$(PYTHON) -m py_compile $(ADDON_NAME)/service/*.py
	$(PYTHON) -m py_compile $(ADDON_NAME)/categories/*.py
	$(PYTHON) -m py_compile $(ADDON_NAME)/gui/spokes/*.py
	$(PYTHON) -m py_compile $(ADDON_NAME)/tui/spokes/*.py
	@echo "All checks passed!"

# Run full integration tests in container with real Anaconda
test-full:
	@echo "=== Running K4All Addon Integration Tests ==="
	./tests/run-tests.sh full

help:
	@echo "K4All Anaconda Addon Makefile"
	@echo ""
	@echo "Targets:"
	@echo "  updates       - Build k4all_addon_updates.img (default)"
	@echo "  install-bootc - Build and copy to ../bootc/iso/images/"
	@echo "  test          - Run unit tests + syntax checks (fast)"
	@echo "  test-full     - Run integration tests in Anaconda container"
	@echo "  clean         - Remove built files"
	@echo "  help          - Show this help"
