# K4All bootc Makefile
# Build targets for OCI image and ISO

IMAGE_NAME ?= ghcr.io/gpillon/k4all-bootc
IMAGE_TAG ?= latest
OUTPUT_DIR ?= $(CURDIR)/output

CONTAINER_NAME ?= k4all-test

.PHONY: all image iso iso-attended iso-unattended-bootstrap iso-unattended-worker \
        addon remaster clean help test test-addon run stop test-runtime

all: image

# Build the bootc OCI image
image:
	@echo "=== Building K4All bootc image ==="
	./scripts/build-image.sh
	@echo ""
	@echo "Image built: $(IMAGE_NAME):$(IMAGE_TAG)"

# Push the image to registry
push:
	@echo "=== Pushing K4All bootc image ==="
	podman push $(IMAGE_NAME):$(IMAGE_TAG)

# ---------- ISO targets ----------

# Build an attended (interactive Anaconda) ISO — user configures via GUI
iso-attended: image addon
	ISO_MODE=attended OUTPUT_DIR=$(OUTPUT_DIR) ./scripts/build-iso.sh $(IMAGE_NAME):$(IMAGE_TAG)
	@ISO_FILE=$$(ls -1t $(OUTPUT_DIR)/k4all-attended.iso 2>/dev/null | head -1); \
	if [ -n "$$ISO_FILE" ]; then ./scripts/remaster-iso.sh "$$ISO_FILE"; fi

# Build an unattended bootstrap ISO — auto-installs first cluster node
iso-unattended-bootstrap: image addon
	ISO_MODE=unattended-bootstrap OUTPUT_DIR=$(OUTPUT_DIR) ./scripts/build-iso.sh $(IMAGE_NAME):$(IMAGE_TAG)
	@ISO_FILE=$$(ls -1t $(OUTPUT_DIR)/k4all-bootstrap.iso 2>/dev/null | head -1); \
	if [ -n "$$ISO_FILE" ]; then ./scripts/remaster-iso.sh "$$ISO_FILE"; fi

# Build an unattended worker ISO — auto-installs worker node
iso-unattended-worker: image addon
	ISO_MODE=unattended-worker OUTPUT_DIR=$(OUTPUT_DIR) ./scripts/build-iso.sh $(IMAGE_NAME):$(IMAGE_TAG)
	@ISO_FILE=$$(ls -1t $(OUTPUT_DIR)/k4all-worker.iso 2>/dev/null | head -1); \
	if [ -n "$$ISO_FILE" ]; then ./scripts/remaster-iso.sh "$$ISO_FILE"; fi

# Shortcut: build all ISO variants
iso: iso-attended iso-unattended-bootstrap iso-unattended-worker

# Build the Anaconda addon
addon:
	@echo "=== Building K4All Anaconda addon ==="
	$(MAKE) -C ../k4all-anaconda-addon
	$(MAKE) -C ../k4all-anaconda-addon install-bootc
	@echo ""
	@echo "Addon installed to: iso/images/k4all_updates.img"

# Remaster the ISO to include addon and kickstart
remaster:
	@echo "=== Remastering K4All ISO ==="
	@if [ -z "$(ISO)" ]; then \
		echo "Usage: make remaster ISO=path/to/iso.iso"; \
		exit 1; \
	fi
	./scripts/remaster-iso.sh $(ISO)

# Full build: image + addon + all ISOs (attended + unattended)
full: iso
	@echo ""
	@echo "=== Full build complete ==="
	@echo "ISOs in: $(OUTPUT_DIR)/"
	@ls -lh $(OUTPUT_DIR)/*.iso 2>/dev/null || true

# ---------- Container targets ----------

# Run the image as a systemd container for testing
run:
	@if podman inspect --format '{{.State.Running}}' $(CONTAINER_NAME) 2>/dev/null | grep -q true; then \
		echo "Container '$(CONTAINER_NAME)' is already running."; \
	else \
		podman rm -f $(CONTAINER_NAME) 2>/dev/null || true; \
		echo "=== Starting K4All container '$(CONTAINER_NAME)' ==="; \
		podman run -d --name $(CONTAINER_NAME) \
			--hostname k4all-test-node \
			--privileged \
			--security-opt unmask=ALL \
			--tmpfs /run --tmpfs /tmp \
			-v /sys/fs/cgroup:/sys/fs/cgroup:rw \
			$(IMAGE_NAME):$(IMAGE_TAG) \
			/sbin/init; \
		echo "Waiting for systemd to boot..."; \
		sleep 5; \
		echo "Container '$(CONTAINER_NAME)' is running."; \
		echo "  shell:  podman exec -it $(CONTAINER_NAME) bash"; \
		echo "  logs:   podman logs $(CONTAINER_NAME)"; \
		echo "  stop:   make stop"; \
	fi

# Stop and remove the test container
stop:
	@echo "=== Stopping container '$(CONTAINER_NAME)' ==="
	@podman rm -f $(CONTAINER_NAME) 2>/dev/null || true
	@echo "Container removed."

# ---------- Test targets ----------

# Test the bootc image (build + validate)
test: image
	@echo "=== Running K4All bootc image tests ==="
	IMAGE_NAME=$(IMAGE_NAME) IMAGE_TAG=$(IMAGE_TAG) ./tests/test-image.sh --skip-build

# Test the running container (runtime / dynamic tests)
test-runtime: run
	@echo "=== Running K4All runtime tests ==="
	CONTAINER_NAME=$(CONTAINER_NAME) ./tests/test-runtime.sh

# Test the Anaconda addon (unit tests)
test-addon:
	@echo "=== Running K4All Anaconda addon tests ==="
	$(MAKE) -C ../k4all-anaconda-addon test

# Test everything
test-all: test test-addon
	@echo ""
	@echo "=== All tests passed ==="

# Clean build artifacts
clean:
	rm -rf $(OUTPUT_DIR)
	rm -f iso/images/k4all_updates.img
	$(MAKE) -C ../k4all-anaconda-addon clean

# Show help
help:
	@echo "K4All bootc Build System"
	@echo "========================"
	@echo ""
	@echo "Image:"
	@echo "  image                    - Build the bootc OCI image"
	@echo "  push                     - Push image to registry"
	@echo ""
	@echo "ISO (all include K4All Anaconda addon):"
	@echo "  iso-attended             - Interactive Anaconda ISO (GUI with K4All spoke)"
	@echo "  iso-unattended-bootstrap - Unattended bootstrap node ISO (20% OS / 80% LVM)"
	@echo "  iso-unattended-worker    - Unattended worker node ISO (20% OS / 80% LVM)"
	@echo "  iso                      - Build ALL ISO variants"
	@echo "  addon                    - Build Anaconda addon only"
	@echo "  remaster                 - Remaster an existing ISO (ISO=path required)"
	@echo "  full                     - Build everything: image + addon + all ISOs"
	@echo ""
	@echo "Testing:"
	@echo "  run                      - Run the image as a systemd container"
	@echo "  stop                     - Stop and remove the test container"
	@echo "  test                     - Build + validate bootc image (static)"
	@echo "  test-runtime             - Run + validate running container (dynamic)"
	@echo "  test-addon               - Run Anaconda addon unit tests"
	@echo "  test-all                 - Run all tests"
	@echo ""
	@echo "Other:"
	@echo "  clean                    - Remove build artifacts"
	@echo "  help                     - Show this help"
	@echo ""
	@echo "Variables:"
	@echo "  IMAGE_NAME      (default: $(IMAGE_NAME))"
	@echo "  IMAGE_TAG       (default: $(IMAGE_TAG))"
	@echo "  CONTAINER_NAME  (default: $(CONTAINER_NAME))"
	@echo "  OUTPUT_DIR      (default: $(OUTPUT_DIR))"
	@echo ""
	@echo "Examples:"
	@echo "  make image                              # build OCI image"
	@echo "  make iso-attended                       # interactive Anaconda ISO"
	@echo "  make iso-unattended-bootstrap           # unattended bootstrap ISO"
	@echo "  make iso                                # all ISO variants"
	@echo "  make full                               # everything"
	@echo "  make test-runtime                       # runtime integration tests"
