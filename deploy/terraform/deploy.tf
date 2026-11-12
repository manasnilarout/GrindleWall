# The app layer: put a commit and a .env on the VM and bring the compose stack
# up. It runs over SSH rather than cloud-init because the VM has no internet
# egress until the reserved public IP is attached, which only happens after
# the instance exists. SSH through that IP is proof it is attached.

# Resolve git_ref to the commit it names right now. A moved branch changes the
# SHA, which replaces terraform_data.deploy, which redeploys.
data "http" "git_sha" {
  url = "https://api.github.com/repos/${var.github_repo}/commits/${var.git_ref}"
  request_headers = {
    Accept = "application/vnd.github.sha"
  }

  lifecycle {
    postcondition {
      condition     = self.status_code == 200 && can(regex("^[0-9a-f]{40}$", trimspace(self.response_body)))
      error_message = "GitHub did not resolve ${var.github_repo}@${var.git_ref} to a commit (HTTP ${self.status_code}). Is it pushed?"
    }
  }
}

# Signs login cookies. Kept in state so a redeploy does not sign everyone out
# (a container restart still does: sessions live in the process).
resource "random_password" "auth_hmac" {
  length  = 48
  special = false
}

locals {
  git_sha = trimspace(data.http.git_sha.response_body)

  # HTTP_PORT=80: the first certificate is issued while only the plain stack
  # runs, and ACME reaches it on 80. CORS_ORIGINS is left unset on purpose so
  # the TLS overlay's https://<domain> default applies.
  app_env = merge(var.app_env, {
    HTTP_PORT        = "80"
    PUBLIC_DOMAIN    = var.domain
    AUTH_PASSWORD    = var.auth_password
    AUTH_HMAC_SECRET = random_password.auth_hmac.result
  })
  # Single-quoted: Compose reads those literally (validated free of quotes).
  app_env_file = join("", [for k in sort(keys(local.app_env)) : "${k}='${local.app_env[k]}'\n"])

  deploy_conf = <<-EOT
    DOMAIN='${var.domain}'
    PUBLIC_IP='${oci_core_public_ip.app.ip_address}'
    GIT_SHA='${local.git_sha}'
    REPO_URL='https://github.com/${var.github_repo}.git'
    ACME_EMAIL='${var.acme_email}'
  EOT

  scripts_hash = sha256(join("", [for f in sort(fileset("${path.module}/scripts", "*.sh")) : filesha256("${path.module}/scripts/${f}")]))
  stage_dir    = "/home/ubuntu/.grindelwald"
}

resource "terraform_data" "deploy" {
  triggers_replace = {
    instance = oci_core_instance.app.id
    conf     = sha256(local.deploy_conf)
    env      = sha256(local.app_env_file)
    scripts  = local.scripts_hash
  }

  connection {
    type        = "ssh"
    host        = oci_core_public_ip.app.ip_address
    user        = "ubuntu"
    private_key = var.ssh_private_key_path == null ? null : file(pathexpand(var.ssh_private_key_path))
    agent       = var.ssh_private_key_path == null
    timeout     = "10m"
  }

  provisioner "remote-exec" {
    inline = ["install -d -m 700 ${local.stage_dir}"]
  }

  provisioner "file" {
    source      = "${path.module}/scripts/provision.sh"
    destination = "${local.stage_dir}/provision.sh"
  }

  provisioner "file" {
    source      = "${path.module}/scripts/ensure-tls.sh"
    destination = "${local.stage_dir}/ensure-tls.sh"
  }

  provisioner "file" {
    content     = local.deploy_conf
    destination = "${local.stage_dir}/deploy.conf"
  }

  provisioner "file" {
    content     = local.app_env_file
    destination = "${local.stage_dir}/app.env"
  }

  provisioner "remote-exec" {
    inline = ["sudo bash ${local.stage_dir}/provision.sh"]
  }
}
