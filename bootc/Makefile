# K4All bootc Makefile
# Build targets for OCI image and ISO

IMAGE_NAME ?= ghcr.io/gpillon/k4all-bootc
IMAGE_TAG ?= latest
OUTPUT_DIR ?= $(CURDIR)/output

CONTAINER_NAME ?= k4all-test
KUBECONFIG_PATH ?= /tmp/k4all-kubeconfig
K8S_PORT ?= 16443
WEB_HTTPS_PORT ?= 10443
WEB_HTTP_PORT ?= 18080
SKIP_DEPLOY_OPERATOR ?= false

.PHONY: all image iso iso-attended iso-unattended-bootstrap iso-unattended-control iso-unattended-worker \
        addon remaster clean help test test-addon run run-start build-run stop test-runtime \
        bootstrap kubeconfig token dashboard shell

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

# Build an unattended control plane ISO — auto-installs control plane node
iso-unattended-control: image addon
	ISO_MODE=unattended-control OUTPUT_DIR=$(OUTPUT_DIR) ./scripts/build-iso.sh $(IMAGE_NAME):$(IMAGE_TAG)
	@ISO_FILE=$$(ls -1t $(OUTPUT_DIR)/k4all-control.iso 2>/dev/null | head -1); \
	if [ -n "$$ISO_FILE" ]; then ./scripts/remaster-iso.sh "$$ISO_FILE"; fi

# Build an unattended worker ISO — auto-installs worker node
iso-unattended-worker: image addon
	ISO_MODE=unattended-worker OUTPUT_DIR=$(OUTPUT_DIR) ./scripts/build-iso.sh $(IMAGE_NAME):$(IMAGE_TAG)
	@ISO_FILE=$$(ls -1t $(OUTPUT_DIR)/k4all-worker.iso 2>/dev/null | head -1); \
	if [ -n "$$ISO_FILE" ]; then ./scripts/remaster-iso.sh "$$ISO_FILE"; fi

# Shortcut: build all ISO variants
iso: iso-attended iso-unattended-bootstrap iso-unattended-control iso-unattended-worker

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

# Start the container (systemd) — does NOT bootstrap k8s yet.
# Internal target used by 'run' and 'build-run'.
run-start:
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
			-p $(K8S_PORT):6443 \
			-p $(WEB_HTTPS_PORT):443 \
			-p $(WEB_HTTP_PORT):80 \
			$(IMAGE_NAME):$(IMAGE_TAG) \
			/sbin/init; \
		echo "Waiting for systemd to boot..."; \
		sleep 5; \
		echo "Container '$(CONTAINER_NAME)' started."; \
	fi

# Bootstrap the container into a working k8s cluster.
# Handles all the container-specific quirks (DNS, swap, kube-proxy, etc.)
bootstrap:
	@CONTAINER_NAME=$(CONTAINER_NAME) SKIP_DEPLOY_OPERATOR=$(SKIP_DEPLOY_OPERATOR) ./scripts/bootstrap-container.sh

# Run the latest local image: start container + bootstrap into a working cluster
run: run-start bootstrap

# Build the image from local sources, then run it
build-run: image run

# Stop and remove the test container
stop:
	@echo "=== Stopping container '$(CONTAINER_NAME)' ==="
	@podman rm -f $(CONTAINER_NAME) 2>/dev/null || true
	@rm -f $(KUBECONFIG_PATH)
	@echo "Container removed."

# Open a shell in the running container
shell:
	@podman exec -it $(CONTAINER_NAME) bash

# ---------- Kubeconfig / Dashboard helpers ----------

# Extract kubeconfig from the container, rewrite server to use container IP
kubeconfig:
	@if ! podman inspect --format '{{.State.Running}}' $(CONTAINER_NAME) 2>/dev/null | grep -q true; then \
		echo "ERROR: Container '$(CONTAINER_NAME)' is not running. Run 'make run' first."; \
		exit 1; \
	fi
	@echo "Waiting for admin.conf..."
	@for i in $$(seq 1 60); do \
		if podman exec $(CONTAINER_NAME) test -f /etc/kubernetes/admin.conf 2>/dev/null; then \
			break; \
		fi; \
		sleep 5; \
	done
	@if ! podman exec $(CONTAINER_NAME) test -f /etc/kubernetes/admin.conf 2>/dev/null; then \
		echo "ERROR: Kubernetes not bootstrapped yet — admin.conf missing."; \
		exit 1; \
	fi
	@podman cp $(CONTAINER_NAME):/root/.kube/config $(KUBECONFIG_PATH) 2>/dev/null || \
		podman cp $(CONTAINER_NAME):/etc/kubernetes/admin.conf $(KUBECONFIG_PATH) 2>/dev/null
	@CONTAINER_IP=$$(podman inspect $(CONTAINER_NAME) --format '{{.NetworkSettings.IPAddress}}') && \
		sed -i "s|server: https://.*:6443|server: https://$${CONTAINER_IP}:6443|" $(KUBECONFIG_PATH)
	@echo ""
	@echo "Kubeconfig written to: $(KUBECONFIG_PATH)"
	@echo ""
	@echo "Usage:"
	@echo "  export KUBECONFIG=$(KUBECONFIG_PATH)"
	@echo "  kubectl get nodes"

# Print the headlamp-admin token for dashboard login
token: kubeconfig
	@echo ""
	@KUBECONFIG=$(KUBECONFIG_PATH) kubectl get secret headlamp-admin-token -n headlamp \
		-o jsonpath='{.data.token}' 2>/dev/null | base64 -d && echo "" \
	|| echo "Headlamp token not ready yet. The operator may still be deploying."

# Show dashboard URL and token
dashboard: kubeconfig
	@echo ""
	@echo "╔══════════════════════════════════════════════╗"
	@echo "║          K4All Headlamp Dashboard            ║"
	@echo "╚══════════════════════════════════════════════╝"
	@echo ""
	@echo "  Dashboard URL:  http://localhost:$(WEB_HTTP_PORT)"
	@echo ""
	@echo "  Token:"
	@KUBECONFIG=$(KUBECONFIG_PATH) kubectl get secret headlamp-admin-token -n headlamp \
		-o jsonpath='{.data.token}' 2>/dev/null | base64 -d && echo "" \
	|| echo "  (not ready yet — operator may still be deploying)"
	@echo ""
	@echo "Starting port-forward to Headlamp (Ctrl-C to stop)..."
	@KUBECONFIG=$(KUBECONFIG_PATH) kubectl port-forward -n headlamp svc/headlamp $(WEB_HTTP_PORT):80 --address 0.0.0.0

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
	rm -f $(KUBECONFIG_PATH)
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
	@echo "  iso-unattended-bootstrap - Unattended bootstrap node ISO"
	@echo "  iso-unattended-control   - Unattended control plane node ISO"
	@echo "  iso-unattended-worker    - Unattended worker node ISO"
	@echo "  iso                      - Build ALL ISO variants"
	@echo "  addon                    - Build Anaconda addon only"
	@echo "  remaster                 - Remaster an existing ISO (ISO=path required)"
	@echo "  full                     - Build everything: image + addon + all ISOs"
	@echo ""
	@echo "Container & Cluster:"
	@echo "  run                      - Start container + bootstrap k8s cluster"
	@echo "  build-run                - Build image from source, then run"
	@echo "  stop                     - Stop and remove the test container"
	@echo "  shell                    - Open a bash shell in the container"
	@echo "  bootstrap                - (Re-)bootstrap k8s in a running container"
	@echo ""
	@echo "Cluster Access:"
	@echo "  kubeconfig               - Extract kubeconfig to $(KUBECONFIG_PATH)"
	@echo "  token                    - Print Headlamp dashboard login token"
	@echo "  dashboard                - Show dashboard URL + token, start port-forward"
	@echo ""
	@echo "Ports:"
	@echo "  K8S API:   localhost:$(K8S_PORT)  -> container:6443"
	@echo "  HTTPS:     localhost:$(WEB_HTTPS_PORT) -> container:443"
	@echo "  HTTP:      localhost:$(WEB_HTTP_PORT) -> container:80"
	@echo ""
	@echo "Testing:"
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
	@echo "  K8S_PORT        (default: $(K8S_PORT))"
	@echo "  WEB_HTTPS_PORT  (default: $(WEB_HTTPS_PORT))"
	@echo "  WEB_HTTP_PORT   (default: $(WEB_HTTP_PORT))"
	@echo "  OUTPUT_DIR      (default: $(OUTPUT_DIR))"
	@echo ""
	@echo "Quick Start:"
	@echo "  make run                # start latest local image + bootstrap cluster"
	@echo "  make kubeconfig         # extract kubeconfig"
	@echo "  export KUBECONFIG=$(KUBECONFIG_PATH)"
	@echo "  kubectl get nodes       # verify cluster"
	@echo "  make dashboard          # open Headlamp UI"
	@echo ""
	@echo "  make build-run          # build image from source + run"
