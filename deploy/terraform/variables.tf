variable "project_id" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "Select an existing Google project ID."
  }
}
variable "region" {
  type    = string
  default = "europe-west3"
}
variable "prefix" {
  type    = string
  default = "accesswright"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,11}$", var.prefix))
    error_message = "Use a 3-12 character resource prefix."
  }
}
variable "candidate_bucket" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.candidate_bucket))
    error_message = "Choose the private candidate bucket name."
  }
}
variable "service_images" {
  type = map(string)
  validation {
    condition = toset(keys(var.service_images)) == toset(["webhook", "agent", "relay", "dashboard"]) && alltrue([
      for image in values(var.service_images) : can(regex("^[a-z0-9.-]+/[A-Za-z0-9._/-]+@sha256:[a-f0-9]{64}$", image))
    ])
    error_message = "Provide exactly webhook/agent/relay/dashboard immutable image digests."
  }
}
variable "worker_image" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9.-]+/[A-Za-z0-9._/-]+@sha256:[a-f0-9]{64}$", var.worker_image))
    error_message = "Provide the reviewed secretless worker image digest."
  }
}
variable "agent_origin" {
  type = string
  validation {
    condition     = can(regex("^https://[a-z0-9-]+\\.run\\.app$", var.agent_origin))
    error_message = "Select the exact existing/generated agent Cloud Run origin."
  }
}
variable "dashboard_collection" {
  type = string
  validation {
    condition     = can(regex("^[A-Za-z][A-Za-z0-9_-]{0,127}$", var.dashboard_collection))
    error_message = "Choose the existing aggregate report collection, not a document path."
  }
}
variable "dashboard_members" {
  type = set(string)
  validation {
    condition     = length(var.dashboard_members) > 0 && alltrue([for member in var.dashboard_members : can(regex("^(user|group):[^[:space:]]+@[^[:space:]]+$", member))])
    error_message = "Dashboard invocation requires explicit operator user/group principals."
  }
}
variable "public_webhook" {
  type        = bool
  default     = false
  description = "Review separately before enabling public signed-webhook ingress."
}
variable "runtime_secrets" {
  description = "Existing secret IDs and numeric versions only. Never pass secret values or create secret versions in Terraform."
  type        = map(map(object({ secret_id = string, version = string })))
  validation {
    condition = try(toset(keys(var.runtime_secrets)) == toset(["webhook", "agent", "relay", "dashboard", "verifier"]) && alltrue(flatten([
      for role, entries in var.runtime_secrets : [for name, ref in entries :
      can(regex("^[A-Z][A-Z0-9_]{0,127}$", name)) && can(regex("^[A-Za-z0-9_-]{1,255}$", ref.secret_id)) && can(regex("^[1-9][0-9]*$", ref.version))]
      ])) && toset(keys(var.runtime_secrets["relay"])) == toset(["ACCESSWRIGHT_HOSTED_CONFIG"]) &&
      toset(keys(var.runtime_secrets["webhook"])) == toset(["ACCESSWRIGHT_HOSTED_CONFIG", "ACCESSWRIGHT_GITHUB_APP_PRIVATE_KEY", "ACCESSWRIGHT_GITHUB_WEBHOOK_SECRET"]) &&
      toset(keys(var.runtime_secrets["verifier"])) == toset(["ACCESSWRIGHT_HOSTED_CONFIG", "ACCESSWRIGHT_GITHUB_APP_PRIVATE_KEY"]) &&
      toset(keys(var.runtime_secrets["dashboard"])) == toset(["ACCESSWRIGHT_DASHBOARD_USERNAME", "ACCESSWRIGHT_DASHBOARD_PASSWORD"]) &&
    contains(keys(var.runtime_secrets["agent"]), "ACCESSWRIGHT_HOSTED_CONFIG") && contains(keys(var.runtime_secrets["agent"]), "ACCESSWRIGHT_GITHUB_APP_PRIVATE_KEY"), false)
    error_message = "Use exact trusted-role secret scopes with fixed versions; worker credentials are not supported."
  }
}
