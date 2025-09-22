.PHONY: test-installer test-installer-build test-installer-run build

FCOS_PATH ?= /mnt/f/fcos/
ROLE ?= bootstrap

test-installer: test-installer-build test-installer-run

test-installer-build:
	podman build -t k4all-installer-test -f test/installer/Dockerfile .

test-installer-run:
	ROLE="$(ROLE)"; \
	case "$$ROLE" in \
	  none|"" ) VOLUME_ARG="" ;; \
	  worker|control|bootstrap ) \
	    IGN="k8s-$$ROLE.ign"; \
	    if [ -f "$$IGN" ]; then \
	      VOLUME_ARG="-v $$PWD/$$IGN:/usr/local/bin/k8s.ign:ro"; \
	    else \
	      echo "Warning: $$IGN not found, continuing without volume."; \
	      VOLUME_ARG=""; \
	    fi ;; \
	  * ) echo "Invalid ROLE '$$ROLE'. Use one of: none, worker, control, bootstrap."; exit 1 ;; \
	esac; \
	podman run --rm -it -e SKIP_TIMEOUT=true $$VOLUME_ARG k4all-installer-test

build:
	@./build.sh $(FCOS_PATH)


