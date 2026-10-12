locals {
  accounts = toset(["webhook", "agent", "relay", "dashboard", "verifier", "worker", "job-task", "candidate-task"])
  secret_refs = merge([for role, entries in var.runtime_secrets : {
    for name, ref in entries : "${role}-${name}" => merge(ref, { role = role })
  }]...)
  task_writers = { jobs = "webhook", candidates = "agent", verification = "verifier" }
}
resource "google_service_account" "role" {
  for_each   = local.accounts
  account_id = "${var.prefix}-${each.key}"
}
resource "google_project_iam_member" "metadata" {
  for_each = toset(["webhook", "agent", "relay", "dashboard", "verifier"])
  project  = var.project_id
  role     = each.key == "dashboard" ? "roles/datastore.viewer" : "roles/datastore.user"
  member   = "serviceAccount:${google_service_account.role[each.key].email}"
}
resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each  = local.secret_refs
  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.role[each.value.role].email}"
}
resource "google_cloud_run_v2_service" "role" {
  for_each            = var.service_images
  name                = "${var.prefix}-${each.key}"
  location            = var.region
  deletion_protection = true
  ingress             = "INGRESS_TRAFFIC_ALL"
  template {
    service_account                  = google_service_account.role[each.key].email
    max_instance_request_concurrency = 1
    scaling { max_instance_count = 1 }
    containers {
      image   = each.value
      command = each.key == "dashboard" ? null : ["node"]
      args    = each.key == "dashboard" ? null : ["/accesswright/dist/src/hosted/service-entry.js"]
      ports { container_port = 8080 }
      dynamic "env" {
        for_each = var.runtime_secrets[each.key]
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = "projects/${var.project_id}/secrets/${env.value.secret_id}"
              version = env.value.version
            }
          }
        }
      }
      dynamic "env" {
        for_each = each.key == "dashboard" ? { ACCESSWRIGHT_GCP_PROJECT_ID = var.project_id, ACCESSWRIGHT_FIRESTORE_RUN_COLLECTION = var.dashboard_collection } : {}
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.runtime]
}
resource "google_cloud_run_v2_service_iam_member" "agent" {
  for_each = toset(["worker", "job-task"])
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.role["agent"].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.role[each.key].email}"
}
resource "google_cloud_run_v2_service_iam_member" "relay" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.role["relay"].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.role["candidate-task"].email}"
}
resource "google_cloud_run_v2_service_iam_member" "dashboard" {
  for_each = var.dashboard_members
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.role["dashboard"].name
  role     = "roles/run.invoker"
  member   = each.value
}
resource "google_cloud_run_v2_service_iam_member" "webhook" {
  count    = var.public_webhook ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.role["webhook"].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
resource "google_cloud_run_v2_job" "worker" {
  name                = "${var.prefix}-worker"
  location            = var.region
  deletion_protection = true
  template {
    task_count  = 1
    parallelism = 1
    template {
      service_account = google_service_account.role["worker"].email
      max_retries     = 0
      timeout         = "1800s"
      containers {
        name    = "worker"
        image   = var.worker_image
        command = ["node"]
        args    = ["/accesswright/dist/src/hosted/worker-download-entry.js"]
        resources { limits = { cpu = "4", memory = "8Gi" } }
        env {
          name  = "ACCESSWRIGHT_AGENT_ORIGIN"
          value = var.agent_origin
        }
        env {
          name  = "ACCESSWRIGHT_WORKER_SERVICE_ACCOUNT_EMAIL"
          value = google_service_account.role["worker"].email
        }
        env {
          name  = "ACCESSWRIGHT_PROVIDER_VERIFICATION"
          value = "provider-api"
        }
      }
    }
  }
}
resource "google_cloud_run_v2_job_iam_member" "dispatcher" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.worker.name
  role     = "roles/run.jobsExecutorWithOverrides"
  member   = "serviceAccount:${google_service_account.role["agent"].email}"
}
resource "google_project_iam_custom_role" "execution_reader" {
  role_id     = "${replace(var.prefix, "-", "_")}_execution_reader"
  title       = "Accesswright execution observation"
  permissions = ["run.operations.get", "run.executions.get", "run.executions.list"]
}
resource "google_project_iam_member" "execution_reader" {
  project = var.project_id
  role    = google_project_iam_custom_role.execution_reader.name
  member  = "serviceAccount:${google_service_account.role["agent"].email}"
}
resource "google_storage_bucket" "candidates" {
  name                        = var.candidate_bucket
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  deletion_policy             = "PREVENT"
  versioning { enabled = false }
  soft_delete_policy { retention_duration_seconds = 0 }
}
resource "google_storage_bucket_iam_member" "candidate" {
  for_each = toset(["agent", "relay", "verifier"])
  bucket   = google_storage_bucket.candidates.name
  role     = "roles/storage.objectAdmin"
  member   = "serviceAccount:${google_service_account.role[each.key].email}"
}
resource "google_cloud_tasks_queue" "queue" {
  for_each = toset(["jobs", "candidates"])
  name     = "${var.prefix}-${each.key}"
  location = var.region
  rate_limits { max_concurrent_dispatches = 1 }
  retry_config {
    max_attempts       = 5
    max_retry_duration = "3600s"
    min_backoff        = "10s"
    max_backoff        = "60s"
    max_doublings      = 2
  }
}
resource "google_project_iam_custom_role" "task_submitter" {
  role_id     = "${replace(var.prefix, "-", "_")}_task_submitter"
  title       = "Accesswright bounded task submission"
  permissions = ["cloudtasks.tasks.create", "cloudtasks.tasks.get", "cloudtasks.tasks.fullView"]
}
resource "google_cloud_tasks_queue_iam_member" "writer" {
  for_each = local.task_writers
  project  = var.project_id
  location = var.region
  name     = google_cloud_tasks_queue.queue[each.key == "jobs" ? "jobs" : "candidates"].name
  role     = google_project_iam_custom_role.task_submitter.name
  member   = "serviceAccount:${google_service_account.role[each.value].email}"
}
resource "google_service_account_iam_member" "task_identity" {
  for_each           = local.task_writers
  service_account_id = google_service_account.role[each.key == "jobs" ? "job-task" : "candidate-task"].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.role[each.value].email}"
}
