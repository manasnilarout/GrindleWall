# One-time setup: the Object Storage bucket that holds the main config's
# Terraform state. It lives in its own folder because a config cannot create
# the bucket its own state is stored in.
#
#   cd deploy/terraform/bootstrap
#   terraform init
#   terraform apply -var-file=../terraform.tfvars
#   terraform output -raw backend_hcl > ../backend.hcl
#
# This folder's own state is local and holds nothing secret (a bucket name and
# id). Losing it is harmless: the bucket is protected by prevent_destroy and
# nothing here needs to run again. Other machines never run this; they only
# need ../backend.hcl.

terraform {
  required_version = ">= 1.12"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = ">= 6.0"
    }
  }
}

provider "oci" {
  config_file_profile = var.oci_config_profile
  auth                = var.oci_auth
  region              = var.region
}

variable "compartment_ocid" {
  type = string
  validation {
    condition     = can(regex("^ocid1\\.(tenancy|compartment)\\.", var.compartment_ocid))
    error_message = "compartment_ocid must be a tenancy or compartment OCID (not an identity domain)."
  }
}

variable "oci_config_profile" {
  type    = string
  default = "DEFAULT"
}

variable "oci_auth" {
  type    = string
  default = "ApiKey"
  validation {
    condition     = contains(["ApiKey", "SecurityToken"], var.oci_auth)
    error_message = "oci_auth must be ApiKey or SecurityToken."
  }
}

variable "region" {
  type    = string
  default = null
}

variable "bucket_name" {
  type    = string
  default = "grindelwald-tfstate"
}

data "oci_objectstorage_namespace" "ns" {
  compartment_id = var.compartment_ocid
}

resource "oci_objectstorage_bucket" "state" {
  compartment_id = var.compartment_ocid
  namespace      = data.oci_objectstorage_namespace.ns.namespace
  name           = var.bucket_name
  access_type    = "NoPublicAccess"
  # Every state write keeps the previous version, so a bad apply can be rolled
  # back by restoring an older object version.
  versioning = "Enabled"

  lifecycle {
    # The state holds every vendor key and is the only record of what exists.
    prevent_destroy = true
  }
}

output "backend_hcl" {
  description = "Contents for deploy/terraform/backend.hcl (gitignored)."
  value       = <<-EOT
    # terraform init -backend-config=backend.hcl
    # Not committed: the repo is public and the namespace is tenancy-specific.
    bucket              = "${oci_objectstorage_bucket.state.name}"
    namespace           = "${data.oci_objectstorage_namespace.ns.namespace}"
    region              = "${coalesce(var.region, regex("\\.oc1\\.([a-z0-9-]+)\\.", oci_objectstorage_bucket.state.bucket_id)[0])}"
    config_file_profile = "${var.oci_config_profile}"
    auth                = "${var.oci_auth}"
  EOT
}
