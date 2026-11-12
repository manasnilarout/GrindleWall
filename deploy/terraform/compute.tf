data "oci_identity_availability_domains" "ads" {
  compartment_id = var.compartment_ocid
}

# Newest Canonical Ubuntu 24.04 build for the shape (aarch64 for A1).
data "oci_core_images" "ubuntu" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = var.instance_shape
  state                    = "AVAILABLE"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

resource "oci_core_instance" "app" {
  compartment_id      = var.compartment_ocid
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[0].name
  fault_domain        = var.fault_domain
  display_name        = var.name
  shape               = var.instance_shape

  dynamic "shape_config" {
    for_each = endswith(var.instance_shape, ".Flex") ? [1] : []
    content {
      ocpus         = var.instance_ocpus
      memory_in_gbs = var.instance_memory_gbs
    }
  }

  # No ephemeral IP: the reserved one below is attached instead, so the
  # address (and the DNS record pointing at it) survives a VM rebuild.
  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    assign_public_ip = false
    hostname_label   = "grindelwald"
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = var.boot_volume_gbs
  }

  # Launch-time keys only. After launch the deploy step owns the VM's
  # authorized_keys (from ./authorized_keys), which is how a new machine is
  # given access without rebuilding the VM.
  metadata = {
    ssh_authorized_keys = join("\n", local.ssh_keys)
  }

  preserve_boot_volume = false

  lifecycle {
    # Canonical publishes new images often; a new one must not rebuild the VM
    # (and wipe recorded sessions). `terraform apply -replace=oci_core_instance.app`
    # does that on purpose.
    # Metadata is ignored for the same reason: OCI only reads the SSH keys at
    # launch, and a changed key list is applied by the deploy step instead.
    ignore_changes = [source_details[0].source_id, metadata]

    precondition {
      # The provider returns null, not [], when nothing matches.
      condition     = try(length(data.oci_core_images.ubuntu.images), 0) > 0
      error_message = "No Canonical Ubuntu 24.04 image found for ${var.instance_shape} in compartment ${var.compartment_ocid}. Check the compartment OCID and that the region in ~/.oci/config is your home region."
    }
  }
}

data "oci_core_vnic_attachments" "app" {
  compartment_id = var.compartment_ocid
  instance_id    = oci_core_instance.app.id
}

data "oci_core_private_ips" "app" {
  vnic_id = data.oci_core_vnic_attachments.app.vnic_attachments[0].vnic_id
}

# RESERVED, not ephemeral: when the instance is replaced this resource is only
# re-pointed (private_ip_id is updatable), so the address never changes.
# `terraform destroy` does release it.
resource "oci_core_public_ip" "app" {
  compartment_id = var.compartment_ocid
  display_name   = "${var.name}-ip"
  lifetime       = "RESERVED"
  private_ip_id  = one([for ip in data.oci_core_private_ips.app.private_ips : ip.id if ip.is_primary])
}
