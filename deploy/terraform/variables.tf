# ---- OCI ---------------------------------------------------------------------

variable "oci_config_profile" {
  description = "Profile in ~/.oci/config to authenticate with."
  type        = string
  default     = "DEFAULT"
}

variable "oci_auth" {
  description = "ApiKey (an API key in ~/.oci/config) or SecurityToken (a session from `oci session authenticate`; lasts an hour, `oci session refresh` extends it). Set the same value as `auth` in backend.hcl."
  type        = string
  default     = "ApiKey"

  validation {
    condition     = contains(["ApiKey", "SecurityToken"], var.oci_auth)
    error_message = "oci_auth must be ApiKey or SecurityToken."
  }
}

variable "region" {
  description = "OCI region. Null uses the profile's region. Always Free compute exists only in the tenancy's HOME region."
  type        = string
  default     = null
}

variable "compartment_ocid" {
  description = "Compartment for every resource. The tenancy OCID means the root compartment."
  type        = string

  # An identity-domain OCID (ocid1.domain...) is easy to copy by mistake from
  # the console, and OCI does not reject it: lookups just come back empty.
  validation {
    condition     = can(regex("^ocid1\\.(tenancy|compartment)\\.", var.compartment_ocid))
    error_message = "compartment_ocid must be a tenancy (ocid1.tenancy...) or compartment (ocid1.compartment...) OCID. For the root compartment use the tenancy= line in ~/.oci/config; an identity domain OCID (ocid1.domain...) will not work."
  }
}

variable "name" {
  description = "Display-name prefix for all resources."
  type        = string
  default     = "grindelwald"
}

# ---- VM ----------------------------------------------------------------------

variable "instance_shape" {
  description = "VM.Standard.A1.Flex (ARM) is the Always Free shape with enough memory to build the UI. E2.1.Micro has 1 GB and will not."
  type        = string
  default     = "VM.Standard.A1.Flex"
}

variable "instance_ocpus" {
  description = "OCPUs for a Flex shape. Always Free allows 4 A1 OCPUs in total across the tenancy."
  type        = number
  default     = 2
}

variable "instance_memory_gbs" {
  description = "Memory for a Flex shape. Always Free allows 24 GB of A1 memory in total across the tenancy."
  type        = number
  default     = 12
}

variable "fault_domain" {
  description = "Pin the VM to one fault domain (FAULT-DOMAIN-1, -2 or -3). Null lets OCI choose. A1 capacity sometimes differs between them, so trying each is a way round `Out of host capacity`."
  type        = string
  default     = null

  validation {
    condition     = var.fault_domain == null || can(regex("^FAULT-DOMAIN-[1-3]$", var.fault_domain))
    error_message = "fault_domain must be null, FAULT-DOMAIN-1, FAULT-DOMAIN-2 or FAULT-DOMAIN-3."
  }
}

variable "boot_volume_gbs" {
  description = "Boot volume size. Always Free allows 200 GB of block storage in total. Session WAVs (~5.8 MB per recorded minute) live here."
  type        = number
  default     = 50
}

variable "ssh_private_key_path" {
  description = "THIS machine's private key for the deploy step. Its public half must be listed in ./authorized_keys. Null uses ssh-agent instead (needed if the key has a passphrase)."
  type        = string
  default     = "~/.ssh/id_ed25519"
}

variable "ssh_allowed_cidrs" {
  description = "Sources allowed to reach port 22. Key-only auth either way; narrow this to your own IP if you can."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

# ---- App ---------------------------------------------------------------------

variable "domain" {
  description = "Public hostname. Written into deploy/.env as PUBLIC_DOMAIN, which nginx's TLS config and the certificate path are rendered from. Its DNS (Cloudflare for magickvoice.app) is the one manual step."
  type        = string
  default     = "grindelwald.magickvoice.app"
}

variable "acme_email" {
  description = "Let's Encrypt account contact. Let's Encrypt no longer sends expiry emails, so this is not an expiry alarm."
  type        = string
  default     = "ops@magickvoice.com"
}

variable "github_repo" {
  description = "owner/name of the PUBLIC GitHub repo the VM clones."
  type        = string
  default     = "manasnilarout/GrindleWall"
}

variable "git_ref" {
  description = "Branch, tag or commit to deploy. Resolved to a commit SHA on every plan, so `apply` redeploys whenever a branch has moved."
  type        = string
  default     = "main"
}

variable "auth_password" {
  description = "Login password for the UI (username is always admin@magickvoice.com). Required: a public bench holding vendor keys must not be open."
  type        = string
  sensitive   = true
  nullable    = false

  validation {
    condition     = length(var.auth_password) >= 12
    error_message = "auth_password must be at least 12 characters."
  }
  validation {
    condition     = !can(regex("['\\n\\r]", var.auth_password))
    error_message = "auth_password must not contain a single quote or a newline (it is written single-quoted into deploy/.env)."
  }
}

variable "app_env" {
  description = "Everything else for deploy/.env: vendor keys (OPENAI_API_KEY, ...) and optional backend settings (SESSION_MAX_RECORDS, USD_PER_INR, ...). See deploy/.env.example."
  type        = map(string)
  sensitive   = true
  default     = {}

  validation {
    condition     = alltrue([for k in keys(var.app_env) : can(regex("^[A-Z][A-Z0-9_]*$", k))])
    error_message = "app_env keys must be UPPER_SNAKE_CASE env var names."
  }
  validation {
    # Terraform sets these itself; a second copy in .env would silently win or lose.
    condition = length(setintersection(keys(var.app_env), [
      "HTTP_PORT", "PUBLIC_DOMAIN", "AUTH_PASSWORD", "AUTH_HMAC_SECRET", "CORS_ORIGINS",
      "PORT", "HOST", "STATIC_DIR", "SESSION_DIR",
    ])) == 0
    error_message = "app_env must not set HTTP_PORT, PUBLIC_DOMAIN, AUTH_PASSWORD, AUTH_HMAC_SECRET, CORS_ORIGINS, PORT, HOST, STATIC_DIR or SESSION_DIR; Terraform or Compose owns them."
  }
  validation {
    condition     = alltrue([for v in values(var.app_env) : !can(regex("['\\n\\r]", v))])
    error_message = "app_env values must not contain a single quote or a newline (they are written single-quoted into deploy/.env)."
  }
}
