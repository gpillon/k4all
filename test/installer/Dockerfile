FROM registry.fedoraproject.org/fedora:40 AS builder
RUN dnf -y install jq && dnf clean all

FROM quay.io/fedora/fedora-coreos:stable

ENV container docker

# copy only required tools from builder
COPY --from=builder /usr/bin/jq /usr/local/bin/jq

# Copy installer and validation assets

COPY install-scripts/validate_config.sh /usr/local/bin/validate_config.sh
COPY install-scripts/validator/ /usr/local/bin/validator/
COPY data/default-cluster-config.json /usr/local/share/default-cluster-config.json

COPY install-scripts/installer/installer.sh /usr/local/bin/installer.sh
COPY install-scripts/installer/ui.sh /usr/local/bin/ui.sh
COPY install-scripts/installer/logic.sh /usr/local/bin/logic.sh
COPY install-scripts/installer/scripts /usr/local/bin/scripts
COPY k8s-worker.ign /usr/local/bin/k8s.ign

RUN chmod +x /usr/local/bin/installer.sh \
    /usr/local/bin/ui.sh \
    /usr/local/bin/logic.sh \
    /usr/local/bin/validate_config.sh \
    /usr/local/bin/scripts/installer_helpers.sh

WORKDIR /

# Default to a short timeout for faster testing; override with -e TIMEOUT=...
ENV TIMEOUT=5
ENV TERM=xterm-256color

CMD ["/usr/local/bin/installer.sh"]



