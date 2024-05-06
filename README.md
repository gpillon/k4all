# k4all ISO

The `k4all` ISO provides a pre-configured Fedora CoreOS environment tailored for Kubernetes home mini-servers and virtual machines. This ISO includes essential tools and services like Kubernetes, Calico networking, the metrics server, Logical Volume Manager (LVM), and NGINX as an Ingress controller.

## Overview

**Warning: The installation process is fully unattended and will format the entire /dev/sda device. Ensure that your data is backed up before proceeding.**

Key features include:
- **Metrics Server**: Enables resource usage metrics collection for Kubernetes.
- **Calico**: Provides a robust networking solution.
- **LVM Volume Manager**: Facilitates Persistent Volume Claims (PVCs) using logical volume management.
- **NGINX Ingress Controller**: Manages external access to services in the cluster.

## Installation

### Building the ISO

1. Ensure all dependencies (Podman, Docker) are installed.
2. Run the build script or the GitHub workflow to generate the `k4all` ISO.
3. The process will embed the required configurations and scripts into the Fedora CoreOS image.

### Using the ISO

1. Boot the ISO on the target system.
2. The installation is fully automated and will format the entire `/dev/sda` disk.
3. Once completed, the system will reboot into the new environment.

## Default Setup

- **Default Password**: The default password is `core`. **Change it immediately upon login.**
  - After login, use `passwd` to set a new password for the `core` user.

- **Access Dashboard and Token**:
  - Access the system with `sudo -i`.
  - Run the provided script to obtain the dashboard URL and access token.

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

## Further Information

**Multi-Node Cluster:** For a multi-node cluster, follow the official Kubernetes setup guide.
