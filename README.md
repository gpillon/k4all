# k4all ISO

The `k4all` ISO provides a pre-configured Fedora CoreOS environment tailored for Kubernetes home servers and virtual machines. This ISO includes also essential tools and services for k8s, Calico networking, the metrics server, Logical Volume Manager (LVM), and NGINX as an Ingress controller.

## Overview

**Warning: The installation process is fully unattended and will format the entire `/dev/sda|vda|mmcblk device`. Ensure that your data is backed up before proceeding.**

Key features include:
- **Metrics Server**: Enables resource usage metrics collection for Kubernetes.
- **Calico**: Provides a robust networking solution.
- **LVM Volume Manager**: Facilitates Persistent Volume Claims (PVCs) using logical volume management.
- **NGINX Ingress Controller**: Manages external access to services in the cluster.

## Why k4all?
- 1st time, it's ok.
- 2nd time, you did it better.
- 3rd time, automate it.

## Requirements:
- 2 CPU Cores.
- 4GB Ram (8G for running workloads).
- 20 Minutes.
- Coffee, Sugar, Milk (not required).

## Installation
First version you want to install is the boostrap image: i'ts a single node, with schedulable master. Later, you can add other control nodes or worker nodes. 

### Building the ISO

1. Ensure all dependencies (Podman, Docker) are installed.
2. Run the build script or the GitHub workflow to generate the `k4all` ISO.
3. The process will embed the required configurations and scripts into the Fedora CoreOS image.

### Using the ISO

0. Prepare a good Coffee (Espresso or American, depending on the hardware).
1. Boot the ISO on the target system.
2. The installation is fully automated and will format the entire `dev/sda|vda|mmcblk` disk.
3. Once completed, the system will reboot into the new environment.
4. Take the Coffee (for about 5 to 15 minutes, depending on the hardware, 13 mins on a dual core Intel NUC DN2820FYK - 11yo Hardware).
5. Follow next steps

## Default Setup

- **Default Password**: The default password is `core`. **Change it immediately upon login.**
  - After login, use `passwd` to set a new password for the `core` user.

- **Access Dashboard and Token**:
  - Access the system with `sudo -i` (if credentials are not shown, wait for the end of the installation process).
  - if credentials are not show, you can connect to the k8s dashboard, at https://\<your-ip\>:32323/ using the token retrived by `kubectl get secret admin-user -n kubernetes-dashboard -o jsonpath={".data.token"} | base64 -d)` (remember to `sudo -i`)
## Post-Installation Notes

- **Sample Pod**: A sample pod will be created in the `default` namespace if the LVM setup is successful. You can safely delete this pod.
- **Dashboard**: Access the Kubernetes dashboard via the URL and token you obtain from the system.

## Creating a Bootable USB

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

## Debugging Failed Setup

Sometimes, the installation, could give you errors. When you login you may see some failed units. Run the command `journalctl -xu <failed_unit>` to see error details. _Feel free to comtibute, opening an issue_ :)

## Known issues
FIXED ~~ATM the VDI and the QCOW self-installing images are not booting correctly. Need to investigate on it.~~

## Development
Next features:

- [ ] k8s & services Updates
- [ ] Fancy UI to manage your k4all installation
- [ ] Applications catalog
- [ ] Argocd (?)
- [ ] Multi node
- [ ] ARM platform

## Further Information

**Multi-Node Cluster:** ATM, the installtion is only for a single node cluster. _Feel free to contribute!_

## Looking for an enterprise solution? 
Let's take a look to [Openshift Single Node](https://docs.openshift.com/container-platform/latest/installing/installing_sno/install-sno-installing-sno.html)

 
