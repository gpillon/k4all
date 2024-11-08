# k4all ISO

The `k4all` ISO provides a pre-configured Fedora CoreOS environment tailored for Kubernetes home servers and virtual machines. This ISO includes also essential tools and services for k8s, Calico networking, the metrics server, Logical Volume Manager (LVM), and NGINX as an Ingress controller. There is also a small [Wiki](https://github.com/gpillon/k4all/wiki) with some common useful stuff.

## Overview

**Warning: The installation process is fully unattended and will format the entire `/dev/sda|vda|mmcblk device`. Ensure that your data is backed up before proceeding.**

Key features include:
- **Kubernetes Dashboard**: Easily manage your kubernetes cluster.
- **Metrics Server**: Enables resource usage metrics collection for Kubernetes.
- **Calico / Cilium + Multus**: Provides a robust networking solution.
- **TopoLVM Volume Manager**: Facilitates Persistent Volume Claims (PVCs) using logical volume management.
- **NGINX Ingress Controller**: Manages external access to services in the cluster.
- **Kubevirt**: run VM inside Kubernetes managed by [kubevirt-manager](https://kubevirt-manager.io/). (Optional)
- **ARGOCD**: CI/CD for your installation. (Optional)

## Why k4all?
- 1st time, it's ok.
- 2nd time, you did it better.
- 3rd time, automate it.

## Requirements:
- 2 CPU Cores.
- 4GB Ram (2G used by K8all).
- 20 Minutes.
- Coffee, Sugar, Milk (not required).

## Creating a Bootable USB
**TL;DR** use the `k4all-bootstrap` image

To create a bootable USB device with the `k4all` ISO:

1. **Download and Verify**: Ensure the downloaded ISO is correct and not corrupted.
2. **Use `dd` on Linux**:
   - Identify your USB device (`/dev/sdX`), replacing `X` with the correct letter.
   - Run the following command as `root`:

   ```bash
   sudo dd if=k4all.iso of=/dev/sdX bs=4M status=progress oflag=sync
   ```
3. Use Rufus on Windows:
   - Download [Rufus](https://rufus.ie/)
   - Select the `k4all` ISO, choose your USB device, and click `Start`.

## Installation
**First version you want to install is the boostrap image**: i'ts a single node, with schedulable master. Later, you can add other control nodes or worker nodes. 

### Using the ISO

0. Prepare a good Coffee (Espresso or American, depending on the hardware).
1. Boot the ISO on the target system.
2. If you want to customize the installation, just press 1 or 2 doring installation to modify the JSON. Discovered disk and ethernet cards will be shown in the config. 
3. The installation is fully automated and will format the entire `dev/sda|vda|mmcblk` disk.
4. Once completed, the system will reboot into the new environment.
5. Take the Coffee (for about 5 to 15 minutes, depending on the hardware, 13 mins on a dual core Intel NUC DN2820FYK - 2013's Hardware).
6. Follow next steps

### Using prebuilt images
1. Mount image on your favourite virtualization software
2. Start the VM
3. If you want to customize the installation, just press 1 or 2 doring installation to modify the JSON. Discovered disk and ethernet cards will be shown in the config. 
4. Follow next steps

## Post-Install
- **Access Dashboard and Token**:
  - `ssh` in your newly installed machine with `ssh core@<MACHINE IP>` (default password: core)
  - Access the system with `sudo -i` (if credentials are not shown, wait for the end of the installation process).
  - if credentials are not show, you can connect to the k8s dashboard, at https://\<your-ip\>:32323/ using the token retrived by `kubectl get secret admin-user -n kubernetes-dashboard -o jsonpath={".data.token"} | base64 -d)` (remember to `sudo -i`)

- **Default Password**: The default password is `core`. **Change it immediately upon login.**
  - After login, use `passwd` to set a new password for the `core` user.
## Post-Installation Notes

- **Sample Pod**: A sample pod will be created in the `default` namespace if the LVM setup is successful. You can safely delete this pod.
- **Dashboard**: Access the Kubernetes dashboard via the URL and token you obtain from the system.
   
## Debugging Failed Setup

Sometimes, the installation, could give you errors. When you login you may see some failed units. Run the command `journalctl -xu <failed_unit>` to see error details. _Feel free to comtibute, opening an issue_ :)

During installation you can run `install-status.sh` to monitor the installation status. When the installation is completed, all the services should be in `loaded     active     exited` state. take a look to the pods also with `kubectl get pods -A`

Be Aware: during the installation phase, some failing logs are normal! 

## Building the ISO

1. Ensure all dependencies (Podman or Docker) are installed.
2. Run the `build.sh` script or the GitHub workflow to generate the `k4all` ISO.
3. The process will embed the required configurations and scripts into the Fedora CoreOS image.

## Development
Next features:

- [ ] k8s & services [Updates](https://github.com/gpillon/k4all/wiki/Kubernetes-updates)
- [ ] Fancy UI to manage your k4all installation
- [ ] Applications catalog
- [ ] Argocd Based installation ([?](https://github.com/gpillon/k4all/issues/12))
- [ ] Multi node (WIP)
- [x] ARM platform (Under Test, ATM the test container in manifest "example pod" is not working... need to change image)

## Further Information

**Multi-Node Cluster:** ATM, the installtion is tested for a single node cluster. _Feel free to contribute!_
I added the script to add more nodes, (on the boostrap node you can run `generate_join.sh` script, to get a base64 code, to use in combination with `join_cluster.sh` script. It was not heavily tested, but ATM it looks working... 

## Thanks! 
Many thanks to:
 - [Manustar](https://github.com/manustars) For all the betatesting!

## Looking for an enterprise solution? 
Let's take a look to [Openshift Single Node](https://docs.openshift.com/container-platform/latest/installing/installing_sno/install-sno-installing-sno.html)

## References
 - [kubevirt-manager.io](https://kubevirt-manager.io/)
 - [kube-vip](https://kube-vip.io)
