output "public_ip" {
  description = "Reserved IPv4. Point the domain's A record here (once; it survives VM rebuilds)."
  value       = oci_core_public_ip.app.ip_address
}

output "dns_record" {
  description = "The one manual step: add this in Cloudflare (magickvoice.app), Proxy status DNS only."
  value       = "A  ${var.domain}  ->  ${oci_core_public_ip.app.ip_address}   (TTL 300, no AAAA)"
}

output "url" {
  value = "https://${var.domain}"
}

output "deployed_commit" {
  value = local.git_sha
}

output "ssh" {
  value = "ssh ubuntu@${oci_core_public_ip.app.ip_address}"
}

output "login_username" {
  value = "admin@magickvoice.com"
}
