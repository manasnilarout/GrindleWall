# Deploying Grindelwald to OCI with Terraform

This is the step-by-step runbook for running Grindelwald at
**https://grindelwald.magickvoice.app** on an Oracle Cloud (OCI) Always Free VM.

Terraform owns everything except one DNS record: the network, the VM, a fixed public
IP, Docker, the app checkout, `deploy/.env`, the compose stack and the Let's Encrypt
certificate. You add the DNS record by hand in Cloudflare, once. The IP doesn't
change even if the VM is rebuilt, so you never have to touch DNS again.

```
you ──terraform apply──►  OCI (ap-hyderabad-1)
                           ├─ VCN + public subnet + internet gateway
                           ├─ security list: 22, 80, 443
                           ├─ reserved public IP ◄── Cloudflare A record (manual, once)
                           └─ VM.Standard.A1.Flex, Ubuntu 24.04 (ARM)
                                └─ /opt/grindelwald @ <commit>
                                     docker compose: nginx (80/443) → backend (8787, private)
                                                     certbot (renews every 12h)
```

---

## Part 1: one-time setup

### Step 1. Check the tools on your laptop

| Need | Check | Expect |
|---|---|---|
| Terraform 1.12+ | `terraform version` | `Terraform v1.12` or later (first release with the OCI state backend) |
| OCI CLI, configured | `oci iam region list --output table` | a table of regions, no auth error |
| SSH key | `ls ~/.ssh/id_ed25519 ~/.ssh/id_ed25519.pub` | both files exist |
| Cloudflare | log in at dash.cloudflare.com | you can edit DNS for **magickvoice.app** |

If `oci` isn't configured, run `oci setup config` (an API key). Terraform reads the
same `~/.oci/config` file. Its region must be your tenancy's **home region**
(`ap-hyderabad-1` here), because Always Free compute only exists there. A browser
login (`oci session authenticate`) works too; see
[Part 4](#part-4-working-from-another-machine) for the two settings it needs.

If you have no SSH key, create one with `ssh-keygen -t ed25519`. Its public half
must be listed in `deploy/terraform/authorized_keys`, because the deploy step SSHes
in with it. If your key has a passphrase, Terraform can't read it directly. In that
case, run `ssh-add` first and set `ssh_private_key_path = null` in step 3, so
Terraform uses ssh-agent instead.

### Step 2. Push the code you want to deploy

The VM clones `github.com/manasnilarout/GrindleWall` itself. **Only pushed commits
can be deployed.** Terraform resolves the branch to a commit through the GitHub API
and fails with a clear error if it can't find it.

```bash
git push origin main
```

### Step 3. Fill in `terraform.tfvars`

```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`:

| Setting | What to put | Where to get it |
|---|---|---|
| `compartment_ocid` | your tenancy OCID (the root compartment) | the `tenancy=` line in `~/.oci/config` |
| `auth_password` | the UI login password: at least 12 characters, no `'` | make one up. The username is always `admin@magickvoice.com` |
| `app_env` | vendor keys, e.g. `OPENAI_API_KEY = "sk-..."` | only the providers you want live. A missing key just shows that provider as not ready |
| `git_ref` (optional) | branch, tag or commit | defaults to `main` |
| `ssh_allowed_cidrs` (optional) | `["<your-ip>/32"]` | `curl -s ifconfig.me`. Defaults to anywhere (key-only login) |

`app_env` can also carry any other setting from `deploy/.env.example`, such as
`SESSION_MAX_RECORDS`. Terraform sets `HTTP_PORT`, `PUBLIC_DOMAIN`,
`AUTH_PASSWORD`, `AUTH_HMAC_SECRET` and `CORS_ORIGINS` itself and will refuse them
here.

`terraform.tfvars` is gitignored. Never commit it.

### Step 4. Connect to the shared state, then preview

Terraform's state (its record of what exists, including every key) lives in a
private, versioned OCI bucket, `grindelwald-tfstate`, so every machine shares one
copy and two applies can't run at once. The bucket already exists. On a brand-new
tenancy you'd create it once with `deploy/terraform/bootstrap/` (instructions at the
top of its `main.tf`).

Point this checkout at the bucket:

```bash
cp backend.hcl.example backend.hcl
oci os ns get --query data --raw-output        # paste this as `namespace` in backend.hcl
terraform init -backend-config=backend.hcl
terraform plan
```

The plan should end with **`Plan: 9 to add, 0 to change, 0 to destroy.`** and show
`deployed_commit` as the commit you just pushed. `plan` creates nothing.

### Step 5. Apply

```bash
terraform apply        # review, then type: yes
```

This takes about **10 to 15 minutes**. The first two minutes create the network
and VM. The rest is the deploy over SSH: installing Docker, cloning, and building
the images on the ARM VM. You'll see the VM's log lines prefixed with
`[grindelwald]`. A successful run ends with:

```
[grindelwald] no certificate yet: starting the plain-HTTP stack on :80
grindelwald.magickvoice.app resolves to nothing, not <ip>; waiting for the DNS change
[grindelwald] deployed <commit>
...
Outputs:
dns_record      = "A  grindelwald.magickvoice.app  ->  <ip>   (TTL 300, no AAAA)"
public_ip       = "<ip>"
...
```

The "waiting for the DNS change" line is expected at this point.

**If you see `Out of host capacity`:** OCI has no free ARM capacity in Hyderabad
right now. This is common and not a mistake on your side. Run `terraform apply`
again after some time. Nothing is half-created that needs cleaning up.

### Step 6. Check the app on its IP (before DNS)

```bash
IP=$(terraform output -raw public_ip)
curl -fsS http://$IP/api/health          # {"ok":true,"sampleRate":24000,...}
```

Use curl here, not a browser. `.app` domains are on the browsers' built-in HSTS list,
and the bare IP has no certificate, so the browser test waits until step 9.

### Step 7. Add the DNS record in Cloudflare

In the Cloudflare dashboard, open **magickvoice.app**, go to **DNS → Records**, and
click **Add record**:

| Field | Value |
|---|---|
| Type | `A` |
| Name | `grindelwald` |
| IPv4 address | the `public_ip` output |
| Proxy status | **DNS only** (grey cloud), **not** Proxied |
| TTL | Auto |

The record **must be DNS only**. With the orange cloud on, the name resolves to
Cloudflare's IPs: the VM then never sees its own IP and waits forever, and if it did
get a certificate, Cloudflare would still sit in the middle of the WebSocket and skew
the latency numbers. Don't add an `AAAA` record either.

Check that it resolves (usually within a minute):

```bash
dig +short grindelwald.magickvoice.app @1.1.1.1       # must print the public_ip
```

### Step 8. Wait for HTTPS (automatic, up to 5 minutes)

A timer on the VM checks DNS every 5 minutes. As soon as the name points at the VM,
it gets a Let's Encrypt certificate and switches nginx to HTTPS. You don't need to
run anything. To watch it happen:

```bash
ssh ubuntu@$IP journalctl -fu grindelwald-tls
```

A successful run logs "resolves here; issuing a certificate", then certbot's
"Successfully received certificate", then "switching nginx to TLS".

### Step 9. Verify

From your laptop:

```bash
D=grindelwald.magickvoice.app
curl -fsS https://$D/api/health                                   # {"ok":true,...}
curl -sSI http://$D/ | head -1                                    # HTTP/1.1 301
curl -sS -o /dev/null -w '%{http_code}\n' \
  http://$D/.well-known/acme-challenge/probe                      # 404 (renewals depend on this)
openssl s_client -connect $D:443 -servername $D </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -dates                            # Let's Encrypt, ~90 days
curl -sS -m 5 -i --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://$D/ws/session | head -1                                 # HTTP/1.1 101
```

Then, in a browser:

1. Open https://grindelwald.magickvoice.app and sign in as `admin@magickvoice.com`.
2. Check that the provider catalog loads and your vendors show as ready.
3. Type a turn with the mock providers: you should get a reply, audio and a metrics row.
4. Click **Start mic**. The browser should allow it (this needs HTTPS).

### Step 10. Retire the old AWS box

The old deployment at `grindelwald.magickvoice.com` (3.108.11.148) isn't managed by
Terraform. Once the new site works:

1. Remove the old `grindelwald` A record from the magickvoice.com zone (Google Cloud DNS).
2. If you want its recorded conversations, copy them across before shutting it down.
   Check the volume name on the old box first with `docker volume ls`:

   ```bash
   ssh <old-aws-host> 'sudo docker run --rm -v grindelwald_session-data:/d:ro alpine tar czf - -C /d .' \
     | ssh ubuntu@$IP 'sudo docker run --rm -i -v grindelwald_session-data:/d alpine sh -c "tar xzf - -C /d && chown -R 1000:1000 /d"'
   ```

3. Stop or terminate the EC2 instance from the AWS console.

### Step 11. Know where the state lives

The state is the object `grindelwald/terraform.tfstate` in the `grindelwald-tfstate`
bucket. It contains **every vendor key and the login password** in plain text, so
treat access to that bucket like access to the keys. The bucket is private, and
OCI encrypts it at rest. Versioning keeps every earlier state, so a bad apply can be
undone by restoring an older version (Object Storage → the bucket → Objects →
*View object versions*). The bucket has `prevent_destroy`, so Terraform won't delete
it by accident.

---

## Part 2: day to day

| To | Run (from `deploy/terraform`) | Notes |
|---|---|---|
| Deploy the latest `main` | `git push`, then `terraform apply` | the plan shows `terraform_data.deploy` being replaced when `main` has moved |
| Deploy a specific version | set `git_ref = "<tag or sha>"`, then apply | |
| Add or change a vendor key | edit `app_env`, then apply | restarts the backend; signs users out |
| Change the login password | edit `auth_password`, then apply | |
| Re-run the deploy as is | `terraform apply -replace=terraform_data.deploy` | |
| See what's deployed | `terraform output deployed_commit` | |
| Backend logs | `ssh ubuntu@$IP 'cd /opt/grindelwald/deploy && sudo docker compose logs -f backend'` | |
| All containers | `ssh ubuntu@$IP 'sudo docker ps'` | expect frontend, backend and certbot |
| Certificate expiry | the `openssl` line from step 9 | Let's Encrypt no longer emails you about expiry |
| Rebuild the VM | `terraform apply -replace=oci_core_instance.app` | **wipes recorded sessions and the certificate**. The IP stays, and HTTPS comes back by itself within ~5 minutes |
| Tear everything down | `terraform destroy` | releases the IP too. A later apply gets a new IP, so you'd need to update DNS. The state bucket stays |
| Give a machine SSH access | add its public key to `authorized_keys`, push, apply from a machine that already has access | see Part 4 |
| Remove a machine | delete its line from `authorized_keys`, push, apply | it loses SSH access on that apply |

A deploy from `terraform apply` takes 3 to 5 minutes (mostly the image build). The
site keeps serving until the new containers are swapped in, but live conversations
are cut at that moment.

---

## Part 3: troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Out of host capacity` | no free A1 capacity in the region. Retry later, or temporarily lower `instance_ocpus` / `instance_memory_gbs` |
| `GitHub did not resolve ... (HTTP 404/422)` | the branch or commit isn't pushed, or `git_ref` has a typo |
| apply hangs at `Connecting to remote host via SSH` and times out | the security list doesn't allow your IP (`ssh_allowed_cidrs`), or the key has a passphrase (see step 1) |
| `Service Limit exceeded` for A1 cores | another A1 VM already uses part of the free 4 OCPU / 24 GB. Lower the sizes or delete that VM |
| timer keeps logging `resolves to <some other IP>` | the Cloudflare record is **Proxied** (orange cloud) or points to the wrong IP. Set it to DNS only with the `public_ip` |
| timer logs `last issuance failed under an hour ago` | Let's Encrypt rejected an attempt. Find the reason with `journalctl -u grindelwald-tls`, fix it, then `ssh ubuntu@$IP sudo rm /var/lib/grindelwald/acme-failed` to retry right away. The pause exists because Let's Encrypt allows only 5 failures per hour |
| browser shows a certificate error just after the DNS change | the certificate isn't issued yet. Wait for step 8 |
| 502 Bad Gateway | the backend is not healthy. Check the backend logs (Part 2) |
| a provider shows "not ready" | its key is missing or misspelt in `app_env`. Compare with `deploy/.env.example` |
| `Error acquiring the state lock` | another apply or plan is running, from this machine or another. It names who holds the lock. Wait for it to finish. Only if that run crashed: `terraform force-unlock <ID>` with the ID from the message |
| `Backend initialization required` | run `terraform init -backend-config=backend.hcl` |
| `401-NotAuthenticated` with `auth = "SecurityToken"` | the session expired (1 hour). `oci session refresh --profile <profile>`, or `oci session authenticate` again |
| new machine: SSH `Permission denied (publickey)` during apply | its key isn't on the VM yet. Its public key must be in `authorized_keys` **and** applied once from a machine that already has access (Part 4, step 3) |

On the VM: the app is in `/opt/grindelwald` (a detached checkout of the deployed
commit), its `.env` is root-only in `deploy/.env`, the deploy settings are in
`/etc/grindelwald/deploy.conf`, and the deploy and TLS scripts are
`deploy/terraform/scripts/` in this repo.

---

## Part 4: working from another machine

Any machine can deploy, as long as it has these four things. The state is shared
through the bucket, so nothing has to be copied between machines except the secrets.

### Step 1. Tools and the repo

Terraform 1.12+, the OCI CLI, and a clone of the repo (`git pull` to be current).

### Step 2. An OCI login

Either of these:

- **API key** (doesn't expire): `oci setup config`. Nothing else to set.
- **Browser login** (no key file on the machine; the session lasts an hour, and
  `oci session refresh` extends it):

  ```bash
  oci session authenticate --region ap-hyderabad-1 --profile-name grindelwald
  ```

  Then set `oci_config_profile = "grindelwald"` and `oci_auth = "SecurityToken"` in
  `terraform.tfvars`, and the same two values (`config_file_profile`, `auth`) in
  `backend.hcl`.

Check it with `oci os ns get` (add `--profile grindelwald --auth security_token` for
a session).

### Step 3. SSH access to the VM

Being logged in to OCI does **not** let a machine SSH in, and the deploy step needs
SSH. Each machine uses its own key:

1. On the new machine, run `ssh-keygen -t ed25519` if it has no key, then
   `cat ~/.ssh/id_ed25519.pub`.
2. Add that line to `deploy/terraform/authorized_keys` (end it with a short name
   such as `office-desktop`), commit and push.
3. **From a machine that already has access**, `git pull` and `terraform apply`.
   That apply writes the new list onto the VM.

From then on the new machine can apply by itself. Removing a line and applying
takes that machine's access away. All machines must use the same committed list,
which is why it's in the repo and not in `terraform.tfvars`.

### Step 4. The secrets: `terraform.tfvars` and `backend.hcl`

Neither file is in git. To create them on the new machine:

- `backend.hcl`: as in Part 1, step 4 (copy the example, fill in the namespace).
- `terraform.tfvars`: copy it from wherever you keep it, such as a password
  manager. Or keep it in the state bucket, which already holds the same secrets
  inside the state:

  ```bash
  # from a machine that has it
  oci os object put --bucket-name grindelwald-tfstate --name grindelwald/terraform.tfvars --file terraform.tfvars --force
  # on the new machine
  oci os object get --bucket-name grindelwald-tfstate --name grindelwald/terraform.tfvars --file terraform.tfvars
  ```

  If you keep it in the bucket, re-upload it every time you change it, or the
  machines will drift apart on keys.

### Step 5. Connect and check

```bash
cd deploy/terraform
terraform init -backend-config=backend.hcl
terraform plan          # should say "No changes" if main hasn't moved
```

If the plan wants to create the network or the VM, it isn't reading the shared
state. Check `backend.hcl` before applying anything.
