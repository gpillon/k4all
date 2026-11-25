## K4All @@VERSION@@

### Bootc OCI Image
```
ghcr.io/@@OWNER@@/k4all-bootc:@@VERSION@@
```

### ISO Downloads

| Variant | x86_64 | aarch64 |
|---------|--------|---------|
| **Attended** (interactive GUI) | `k4all-attended-*-x86_64.iso.zst*` | `k4all-attended-*-aarch64.iso.zst` |
| **Bootstrap** (unattended, first node) | `k4all-bootstrap-*-x86_64.iso.zst*` | `k4all-bootstrap-*-aarch64.iso.zst` |
| **Control** (unattended, control plane) | `k4all-control-*-x86_64.iso.zst*` | `k4all-control-*-aarch64.iso.zst` |
| **Worker** (unattended, worker node) | `k4all-worker-*-x86_64.iso.zst*` | `k4all-worker-*-aarch64.iso.zst` |


#### Linux / Mac
ISOs are compressed with zstd. Decompress with: `unzstd <file>.iso.zst`
If the ISO was split (x86_64), reassemble first: `cat <file>.iso.zst.part-* > <file>.iso.zst`

#### Windows
- combine the ISOs using the following command: `copy /b k4all-attended-@@VERSION@@-x86_64.iso.zst.part-* k4all-attended-@@VERSION@@-x86_64.iso.zst`
- Extract the ISOs from zst using Winrar > 6.10

### Update existing systems

From v2.2.4 on, nodes upgrade themselves with `k4all-upgrade`
(patch releases automatically in the Saturday 02:30 window, minor
releases on command):
```bash
sudo k4all-upgrade plan
sudo k4all-upgrade run
```

Nodes on v2.0 – v2.2.3 first move to the v2.2.4 bridge, one node
at a time, control planes first:
```bash
curl -fsSL https://github.com/@@REPOSITORY@@/releases/download/@@VERSION@@/k4all-bridge.sh | sudo bash -s -- --now
```

### Why are the files split?
- Splitting avoids GitHub Actions timeouts when uploading and downloading the artifacts.
- It also keeps the release within the free GitHub storage.
