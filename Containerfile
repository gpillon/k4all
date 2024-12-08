FROM quay.io/fedora/fedora-coreos:stable

COPY ./repo/* /etc/yum.repos.d/

# Add Kubernetes repository and install kubeadm, kubectl, and kubelet
RUN --mount=type=cache,target=/var/cache/rpm-ostree \
    rpm-ostree install kubeadm kubectl kubelet && \
    systemctl enable kubelet && \
    ostree container commit