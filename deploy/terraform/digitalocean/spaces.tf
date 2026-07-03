# Spaces bucket for run artifacts (transcripts), plus an access key scoped to
# just that bucket. Bandolier configures artifact storage PER REPOSITORY in the
# UI — nothing here is wired into the app's environment. Paste the
# spaces_* outputs into a repo's "Run artifact storage" settings.

resource "random_id" "bucket_suffix" {
  count       = var.spaces_enabled && var.spaces_bucket_name == "" ? 1 : 0
  byte_length = 3
}

locals {
  spaces_bucket_name = var.spaces_enabled ? (
    var.spaces_bucket_name != "" ? var.spaces_bucket_name : "${var.name}-artifacts-${random_id.bucket_suffix[0].hex}"
  ) : ""
}

resource "digitalocean_spaces_bucket" "artifacts" {
  count = var.spaces_enabled ? 1 : 0

  name   = local.spaces_bucket_name
  region = var.region
  acl    = "private"
}

# Scoped key for the app: read/write on the artifacts bucket only, so the
# credentials pasted into Bandolier can't touch other buckets in the account.
resource "digitalocean_spaces_key" "artifacts" {
  count = var.spaces_enabled ? 1 : 0

  name = "${var.name}-artifacts"

  grant {
    bucket     = digitalocean_spaces_bucket.artifacts[0].name
    permission = "readwrite"
  }
}
