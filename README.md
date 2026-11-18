# k4all

k4all installs a ready-to-use Kubernetes node on home servers and virtual
machines. It is a [bootc](https://bootc-dev.github.io/bootc/) image based on
Fedora, installed through Anaconda with a small K4All addon. After the
reboot, systemd units and the
[k4all-operator](https://github.com/gpillon/k4all-operator) bring up the
cluster. There is also a small [Wiki](https://github.com/gpillon/k4all/wiki)
with some common useful stuff.

**Warning: the unattended ISOs are fully automatic and erase the installation
disk (the first fixed disk of at least 10 GiB). Back up your data first.**

## What you get

- Kubernetes (kubeadm) with CRI-O
- Calico or Cilium as CNI, plus Multus and the OVS CNI (optional)
- TopoLVM for persistent volumes on the `vg_data` volume group
- Traefik as ingress controller (it replaced ingress-nginx in v2.4.0), MetalLB,
  cert-manager
- Headlamp dashboard and metrics-server
- HA control plane with kube-vip or keepalived (optional)
- KubeVirt with [kubevirt-manager](https://kubevirt-manager.io/) (optional)
- ArgoCD (optional)
- Image-based upgrades with `k4all-upgrade`

## Why k4all?

- 1st time, it's ok.
- 2nd time, you did it better.
- 3rd time, automate it.

## Requirements

- 2 CPU cores.
- 4 GB RAM (2 GB used by k4all).
- 20 minutes.
- Working DNS (optional) (.... what do you mean?)
- Coffee, sugar, milk (not required).

## Which ISO

Each [release](https://github.com/gpillon/k4all/releases) ships four ISOs for
x86_64 and aarch64:

| ISO | Use it for |
|---|---|
| `k4all-bootstrap` | **start here**: the first node, a single-node cluster with a schedulable control plane (unattended) |
| `k4all-control` | an additional control-plane node (unattended) |
| `k4all-worker` | a worker node (unattended) |
| `k4all-attended` | an interactive install: Anaconda asks for disk, network and the K4All settings (role, CNI, HA, features) |

The ISOs are compressed with zstd, and the larger ones are split into parts:

```bash
cat k4all-bootstrap-<version>-x86_64.iso.zst.part-* > k4all-bootstrap.iso.zst   # if split
unzstd k4all-bootstrap.iso.zst
```

On Windows, join the parts with `copy /b` and extract with WinRAR 6.10 or newer.

## Installation

### Bootable USB

Linux, as `root` (replace `X` with your USB device):

```bash
sudo dd if=k4all-bootstrap.iso of=/dev/sdX bs=4M status=progress oflag=sync
```

Windows: use [Rufus](https://rufus.ie/): select the ISO and your USB device,
**select DD mode (!)**, then click `Start`.

### Install

0. Prepare a good coffee (espresso or American, depending on the hardware).
1. Boot the ISO on the target machine or VM.
2. The unattended ISOs install with no questions. The attended ISO shows the
   standard Anaconda screens plus a K4All screen for the node settings.
3. The disk layout puts 80% in the OS volume group (no swap) and the rest in
   `vg_data`, which TopoLVM uses for persistent volumes.
4. The machine reboots, and the first-boot services set up Kubernetes.
5. Drink the coffee: 5 to 15 minutes, depending on the hardware.

While waiting you could listen to a nice Kubernetes song:

[![NCS - Kubernetes - Virtual Realms](https://img.youtube.com/vi/UMqWNKWYwd8/0.jpg)](https://www.youtube.com/watch?v=UMqWNKWYwd8)

## Post-install

- `ssh core@<MACHINE IP>` (default password: `core`) and `sudo -i`.
- **Change the default password right away** with `passwd`.
- Headlamp listens on NodePort 32323 (`https://<your-ip>:32323/`). Get the
  token with
  `kubectl get secret admin-user -n headlamp -o jsonpath='{.data.token}' | base64 -d`
  (as root).
- From v2.4.0, Headlamp's **k4all** section shows the cluster's state, runs
  upgrades and changes the common settings: see
  [docs/headlamp-plugin.md](docs/headlamp-plugin.md).
- A sample pod is created in the `default` namespace when the LVM setup works.
  You can delete it.

## Upgrades

Nodes upgrade one release at a time with `k4all-upgrade`. Patch releases
install automatically in the Saturday 02:30 window. Minor releases (a new
Kubernetes minor, a new Fedora) wait for `sudo k4all-upgrade run`. Nodes on
v2.0 – v2.2.3 first move to the v2.2.4 bridge with `k4all-bridge.sh`.

From v2.4.0 the whole cluster can also be upgraded from Headlamp
(**k4all > Upgrades**), one node at a time, drained first.

The rules, the policy file and what to do when an upgrade stops are in
[docs/upgrades.md](docs/upgrades.md). Don't run `bootc upgrade` by hand: it
skips the kubeadm step.

## Debugging a failed installation

Some failing logs during the installation are normal. When the installation
is complete, all `fck8s-*` services should be `loaded active exited`, and
`kubectl get pods -A` should show running pods.

- `install-status.sh` shows the progress during installation.
- `journalctl -xu <failed_unit>` shows why a unit failed.
- `k4all-upgrade status` shows the upgrade state and any HOLD.

_Feel free to contribute by opening an issue_ :)

## Multi-node

Install the bootstrap node first. Then install control-plane or worker nodes
from their ISOs. To join by hand, run `generate_join.sh` on the bootstrap
node; it prints a base64 code to use with `join_cluster.sh`. Multi-node is
less tested than single-node.

## Building

You need Podman and, for ISOs, xorriso.

```bash
make -C bootc image                      # bootc OCI image
make -C bootc iso-unattended-bootstrap   # one ISO (also: iso-attended, iso-unattended-control, iso-unattended-worker)
make -C bootc iso                        # all four ISOs
make -C bootc test-upgrade               # upgrade tool, graph and contract tests
make -C bootc test-iso-install ISO=...   # full install test in QEMU/KVM
```

The GitHub workflow builds the images on every push, and builds the ISOs and
the release on tags. See [bootc/README.md](bootc/README.md) for the image
layout and [k4all-anaconda-addon/README.md](k4all-anaconda-addon/README.md) for
the installer addon.

## Development

Next features:

- [x] Kubernetes and OS upgrades ([docs/upgrades.md](docs/upgrades.md))
- [x] Traefik as ingress controller (v2.4.0)
- [x] Multi-node upgrades driven by the k4all-operator (ClusterUpgrade, from v2.4.0)
- [ ] Fancy UI to manage your k4all installation
- [ ] Applications catalog
- [ ] ArgoCD-based installation ([?](https://github.com/gpillon/k4all/issues/12))
- [x] ARM platform

## Thanks!

Many thanks to:
 - [Manustar](https://github.com/manustars) for all the beta testing!

## Looking for an enterprise solution?

Take a look at
[OpenShift Single Node](https://docs.openshift.com/container-platform/latest/installing/installing_sno/install-sno-installing-sno.html).

## References

 - [kubevirt-manager.io](https://kubevirt-manager.io/)
 - [kube-vip](https://kube-vip.io)
 - [bootc](https://bootc-dev.github.io/bootc/)
