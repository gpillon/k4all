# K4All bootc Makefile
# Build targets for OCI image and ISO

IMAGE_NAME ?= ghcr.io/gpillon/k4all-bootc
IMAGE_TAG ?= latest
OUTPUT_DIR ?= $(CURDIR)/output

.PHONY: all image iso addon remaster clean help test test-addon

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

# Build the ISO using bootc-image-builder
iso: image
	@echo "=== Building K4All ISO ==="
	./scripts/build-iso.sh $(IMAGE_NAME):$(IMAGE_TAG)
	@echo ""
	@echo "ISO built in: $(OUTPUT_DIR)/"

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

# Full build: image + addon + ISO + remaster
full: image addon iso
	@echo "=== Full build complete ==="
	@echo "Looking for ISO to remaster..."
	@ISO_FILE=$$(ls -1t $(OUTPUT_DIR)/*.iso 2>/dev/null | head -1); \
	if [ -n "$$ISO_FILE" ]; then \
		./scripts/remaster-iso.sh "$$ISO_FILE"; \
	else \
		echo "No ISO found to remaster"; \
	fi

# Test the bootc image (build + validate)
test: image
	@echo "=== Running K4All bootc image tests ==="
	./tests/test-image.sh --skip-build

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
	@echo "K4All bootc Build Targets"
	@echo "========================="
	@echo ""
	@echo "Targets:"
	@echo "  image      - Build the bootc OCI image"
	@echo "  push       - Push image to registry"
	@echo "  iso        - Build ISO using bootc-image-builder"
	@echo "  addon      - Build Anaconda addon (updates.img)"
	@echo "  remaster   - Remaster ISO with addon (ISO=path required)"
	@echo "  full       - Full build: image + addon + ISO + remaster"
	@echo "  test       - Build + validate bootc image"
	@echo "  test-addon - Run Anaconda addon unit tests"
	@echo "  test-all   - Run all tests"
	@echo "  clean      - Remove build artifacts"
	@echo ""
	@echo "Variables:"
	@echo "  IMAGE_NAME  - Image name (default: $(IMAGE_NAME))"
	@echo "  IMAGE_TAG   - Image tag (default: $(IMAGE_TAG))"
	@echo "  OUTPUT_DIR  - Output directory (default: $(OUTPUT_DIR))"
	@echo ""
	@echo "Examples:"
	@echo "  make image"
	@echo "  make iso IMAGE_TAG=v2.0.0"
	@echo "  make remaster ISO=output/bootiso.iso"
	@echo "  make full"

