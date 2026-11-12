terraform {
  required_version = ">= 1.5"

  # State is local on purpose: it holds the vendor keys and the login password
  # (they reach the VM through it), so terraform.tfstate is gitignored and
  # lives only on the machine that runs `apply`. Back it up.

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

# Auth comes from ~/.oci/config (the same profile the `oci` CLI uses).
provider "oci" {
  config_file_profile = var.oci_config_profile
  region              = var.region
}
