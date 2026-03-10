# K4All Anaconda Addon Makefile
# Builds the updates.img for use with inst.updates=

ADDON_NAME = com_k4all_installer
OUTDIR = $(CURDIR)
PYTHON ?= $(shell command -v python3 2>/dev/null)

# Temporary build directory
TMPDIR := $(shell mktemp -d)
BASEDIR = $(TMPDIR)/usr/share/anaconda
ADDONDIR = $(BASEDIR)/addons
SERVICESDIR = $(BASEDIR)/dbus/services
CONFDIR = $(BASEDIR)/dbus/confs

.PHONY: all updates clean test help quick-remaster serve

_default: updates

all: updates

updates:
	@echo "=== Building K4All Anaconda addon updates.img ==="
	@echo -n "Working..."
	@find $(ADDON_NAME) -type d -name '__pycache__' -exec rm -rf {} + 2>/dev/null || true
	@mkdir -p $(ADDONDIR)
	@cp -par $(ADDON_NAME) $(ADDONDIR)/
	@find $(ADDONDIR) -name '*.pyc' -delete 2>/dev/null || true
	@find $(ADDONDIR) -type d -name '__pycache__' -exec rm -rf {} + 2>/dev/null || true
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

# Quick remaster: rebuild addon + remaster an existing ISO (~30s total)
# Usage: make quick-remaster ISO=/mnt/f/fcos/k4all-attended-new.iso
quick-remaster: install-bootc
	@if [ -z "$(ISO)" ]; then \
		echo "Usage: make quick-remaster ISO=path/to/k4all.iso"; \
		exit 1; \
	fi
	../bootc/scripts/remaster-iso.sh $(ISO)

# Serve addon over HTTP for live testing (no remaster needed)
# Boot ISO, edit GRUB: replace inst.updates=hd:... with inst.updates=http://<host-ip>:8080/k4all_addon_updates.img
serve: updates
	@echo "=== Serving addon on http://0.0.0.0:8080/ ==="
	@echo "At GRUB menu, press 'e' and change inst.updates to:"
	@echo "  inst.updates=http://<this-host-ip>:8080/k4all_addon_updates.img"
	@echo ""
	$(PYTHON) -m http.server 8080

help:
	@echo "K4All Anaconda Addon Makefile"
	@echo ""
	@echo "Targets:"
	@echo "  updates         - Build k4all_addon_updates.img (default)"
	@echo "  install-bootc   - Build and copy to ../bootc/iso/images/"
	@echo "  test            - Run unit tests + syntax checks (fast)"
	@echo "  test-full       - Run integration tests in Anaconda container"
	@echo "  quick-remaster  - Rebuild addon + remaster ISO (30s)"
	@echo "                    Usage: make quick-remaster ISO=path/to/iso"
	@echo "  serve           - Serve addon via HTTP for live VM testing"
	@echo "  clean           - Remove built files"
	@echo "  help            - Show this help"
