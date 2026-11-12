terraform {
  # 1.12 is the first release with the native `oci` backend.
  required_version = ">= 1.12"

  # State lives in a private, versioned OCI Object Storage bucket (created once
  # by ./bootstrap), so every machine shares one copy and applies are locked
  # against each other. It holds every vendor key and the login password.
  # The bucket, namespace, region and auth come from backend.hcl (gitignored;
  # the repo is public):
  #   terraform init -backend-config=backend.hcl
  backend "oci" {
    key = "grindelwald/terraform.tfstate"
  }

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = ">= 6.0"
    }
    http = {
      source  = "hashicorp/http"
      version = ">= 3.4"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6"
    }
  }
}

# Auth comes from ~/.oci/config (the same profile the `oci` CLI uses): an API
# key by default, or a browser-login session (`oci session authenticate`) with
# oci_auth = "SecurityToken".
provider "oci" {
  config_file_profile = var.oci_config_profile
  auth                = var.oci_auth
  region              = var.region
}
