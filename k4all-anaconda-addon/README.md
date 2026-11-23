# K4All Anaconda Addon

This is an Anaconda installer addon for configuring K4All Kubernetes cluster nodes during installation.

## Features

- **GUI Spoke**: Graphical configuration interface for Anaconda
- **TUI Spoke**: Text-based interface for headless installations
- **Kickstart Support**: Full support for automated installations via Kickstart

## Building

```bash
make
```

This produces `k4all_addon_updates.img` which can be used with Anaconda's `inst.updates=` boot parameter.

## Usage

### Interactive Installation

1. Host the `k4all_addon_updates.img` file on HTTP/NFS
2. Boot the installer with: `inst.updates=http://server/k4all_addon_updates.img`
3. The "K4All Kubernetes" spoke will appear in the installer

### Kickstart (Automated)

Add the following to your kickstart file:

```kickstart
%addon com_k4all_installer --role=bootstrap --cni=calico --ha=none
{
  "features": {
    "virt": { "enabled": false },
    "argocd": { "enabled": false },
    "ovsBridge": { "enabled": true }
  }
}
%end
```

#### Kickstart Options

| Option | Values | Default | Description |
|--------|--------|---------|-------------|
| `--role` | bootstrap, control, worker | bootstrap | Node role in the cluster |
| `--cni` | calico, cilium | calico | The cluster's CNI: a bootstrap node only. A control plane or a worker joins the cluster's CNI and keeps none in its `/etc/k4all-config.yaml` |
| `--ha` | none, keepalived, kubevip | none | High availability type |
| `--virt` | flag | off | Enable KubeVirt virtualization |
| `--argocd` | flag | off | Enable ArgoCD GitOps |
| `--firewalld` | flag | off | Enable firewalld (the CNI's ports open once the CNI runs on the node: `k4all-cni-firewalld`) |

The JSON body allows fine-grained configuration that will be merged with defaults.

## Configuration Output

During installation, the addon writes:

- `/etc/k4all-config.yaml` - Full K4All ClusterConfig resource
- `/etc/node-type` - Node role (bootstrap/control/worker)

These files are used by K4All systemd services at first boot.

## Integration with bootc ISO

To include in the K4All bootc ISO:

```bash
make install-bootc
```

This copies the updates.img to `../bootc/iso/images/k4all_updates.img` for ISO remastering.

## Development

### Project Structure

```
com_k4all_installer/
├── __init__.py
├── constants.py          # D-Bus identifiers, defaults
├── storage_layout.py     # K4All disk layout (spokes and unattended %pre)
├── service/
│   ├── __init__.py
│   ├── __main__.py       # D-Bus service entry point
│   ├── k4all.py          # Main service class
│   ├── k4all_interface.py # D-Bus interface
│   ├── kickstart.py      # Kickstart parser
│   └── installation.py   # Installation tasks
├── categories/
│   ├── __init__.py
│   └── k4all.py          # Spoke category
├── gui/
│   ├── __init__.py
│   └── spokes/
│       ├── __init__.py
│       ├── k4all.py          # GUI spoke (node settings)
│       ├── k4all.glade
│       ├── k4all_storage.py  # GUI spoke (disk layout)
│       └── k4all_storage.glade
└── tui/
    ├── __init__.py
    └── spokes/
        ├── __init__.py
        ├── k4all.py          # TUI spoke (node settings)
        └── k4all_storage.py  # TUI spoke (disk layout)
data/
├── org.fedoraproject.Anaconda.Addons.K4All.{conf,service}  # D-Bus activation
└── 95-k4all-addon.conf   # Anaconda drop-in: bootc-image-builder ISOs list
                          # their modules explicitly; this adds K4All
```

### Testing

```bash
make test
```

This runs the pytest suite in `tests/` (constants, kickstart parsing, the
D-Bus service, the storage layout, packaging and the bootc contracts), then
compiles every module. `tests/Containerfile.test` runs the same tests against
a real Anaconda on Fedora.

## License

GPL-2.0-or-later
