# Running live5 on a small EC2 instance

For testing: one instance runs live5 as a service, with Caddy in front providing real HTTPS. Data lives on the instance's disk in `/opt/live5/data`. The steps cover **Amazon Linux 2023** (the default AMI) and **Ubuntu 24.04**; only steps 1–2 differ.

```
phone ──HTTPS 443──▶ Caddy (Let's Encrypt cert) ──HTTP 127.0.0.1:5555──▶ live5 (systemd)
```

The SSH user is `ec2-user` on Amazon Linux and `ubuntu` on Ubuntu. Below, `<user>` means whichever applies.

## 1. Launch the instance

- **Type:** `t4g.small` (ARM) or `t3.small` is plenty. A `*.micro` instance works for light testing.
- **Storage:** 20 GB gp3. A 30-second live is about 3–6 MB, and the converted replay roughly doubles that.
- **Security group:**
  - SSH 22: from *My IP* only.
  - HTTP 80 and HTTPS 443: from anywhere. Port 80 is needed for the certificate and redirects to HTTPS.
  - Don't open 5555. The app only listens on the instance itself.
- **Elastic IP:** allocate one and associate it with the instance, so the address (and the HTTPS name below) stays the same across stops.

## 2a. Install Node and Caddy — Amazon Linux 2023

SSH in (`ssh -i your-key.pem ec2-user@<elastic-ip>`).

**Node 22.** Amazon Linux names Node packages and binaries by version (`nodejs22`, `/usr/bin/node-22`). Point plain `node` at it, because the live5 service runs `/usr/bin/node`:

```bash
sudo dnf install -y nodejs22 tar
sudo alternatives --set node /usr/bin/node-22
node --version   # should print v22.x
```

If `alternatives --set` complains, `ls /usr/bin/node-*` shows the real name; use that path in `--set`, or put it in `ExecStart` in `deploy/live5.service`.

**Caddy.** There's no Amazon Linux package, so install Caddy's static binary and its systemd unit. `uname -m` prints `aarch64` on ARM (t4g) and `x86_64` on Intel/AMD (t3):

```bash
ARCH=$( [ "$(uname -m)" = "aarch64" ] && echo arm64 || echo amd64 )
curl -fL "https://caddyserver.com/api/download?os=linux&arch=$ARCH" -o /tmp/caddy
sudo install -m 755 /tmp/caddy /usr/local/bin/caddy && caddy version
sudo groupadd --system caddy
sudo useradd --system --gid caddy --create-home --home-dir /var/lib/caddy --shell /usr/sbin/nologin caddy
sudo mkdir -p /etc/caddy
```

The Caddy service file comes with the app (`deploy/caddy.service`) and is installed in step 5.

## 2b. Install Node and Caddy — Ubuntu 24.04

SSH in (`ssh -i your-key.pem ubuntu@<elastic-ip>`). Ubuntu's own Node is too old, so use NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
```

Caddy from its official apt repository. These are the commands from https://caddyserver.com/docs/install#debian-ubuntu-raspbian; check that page if they've changed:

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

The package sets up Caddy's user and service; skip installing `deploy/caddy.service` in step 5.

## 3. Create the app user and folders (both)

```bash
sudo useradd --system --home /opt/live5 --shell /usr/sbin/nologin live5
sudo mkdir -p /opt/live5/data && sudo chown -R live5:live5 /opt/live5/data
```

## 4. Copy the app and run it as a service (both)

From your computer, in the live5 folder (Git Bash on Windows). This copies the latest commit only; `data/` and `certs/` are never sent:

```bash
git archive --format=tar HEAD | ssh -i your-key.pem <user>@<elastic-ip> "sudo tar -x -C /opt/live5"
```

Then on the instance:

```bash
sudo cp /opt/live5/deploy/live5.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now live5
```

Check it started with `systemctl status live5`, and follow the log with `journalctl -u live5 -f`.

## 5. HTTPS with Caddy (both)

No domain needed: sslip.io turns an IP written with dashes into a hostname. For an Elastic IP of `3.121.45.67`, the name is `3-121-45-67.sslip.io`. With a domain, point an A record at the Elastic IP and use that name instead.

```bash
sudo cp /opt/live5/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile   # replace YOUR-ELASTIC-IP-WITH-DASHES.sslip.io with your name
```

Amazon Linux only: install and start Caddy's service.

```bash
sudo cp /opt/live5/deploy/caddy.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now caddy
```

Ubuntu (Caddy is already running): `sudo systemctl reload caddy`.

Caddy gets the certificate on the first request. Open `https://<your-name>/` on a phone: no certificate warning, and the camera works. If it doesn't load, `journalctl -u caddy -f` shows certificate errors (usually port 80 or 443 not open in the security group).

## Updating

Commit, re-run the copy command from step 4, then restart:

```bash
ssh -i your-key.pem <user>@<elastic-ip> "sudo systemctl restart live5"
```

Users and broadcasts in `/opt/live5/data` are kept. Remove a file the new version deleted by hand; the copy only adds and overwrites. On Amazon Linux, update Caddy by downloading the binary again and running `sudo systemctl restart caddy`.

## Things to know

- **Public:** anyone with the address can create a profile and go live. There's no moderation or rate limiting yet. To keep it private while testing, restrict 443/80 to your own IPs, but the certificate needs port 80 open when it's first issued and on renewal.
- **Costs:** a stopped instance still pays for its disk, and the Elastic IP is charged per hour. Terminate the instance when you're done (that deletes the data).
- **Backups:** none. `data/` is only on this disk. An EBS snapshot is the quick way to keep a copy.
