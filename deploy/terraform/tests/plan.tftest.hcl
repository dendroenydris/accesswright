mock_provider "google" {}

variables {
  project_id           = "accesswright-fixture"
  candidate_bucket     = "accesswright-fixture-candidates"
  agent_origin         = "https://accesswright-agent-fixture.run.app"
  dashboard_collection = "reports"
  dashboard_members    = ["user:operator@example.invalid"]
  service_images = {
    webhook   = "europe-west3-docker.pkg.dev/fixture/images/service@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    agent     = "europe-west3-docker.pkg.dev/fixture/images/service@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    relay     = "europe-west3-docker.pkg.dev/fixture/images/service@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    dashboard = "europe-west3-docker.pkg.dev/fixture/images/dashboard@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  worker_image = "europe-west3-docker.pkg.dev/fixture/images/worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  runtime_secrets = {
    webhook = {
      ACCESSWRIGHT_HOSTED_CONFIG          = { secret_id = "webhook-config", version = "1" }
      ACCESSWRIGHT_GITHUB_APP_PRIVATE_KEY = { secret_id = "app-key", version = "1" }
      ACCESSWRIGHT_GITHUB_WEBHOOK_SECRET  = { secret_id = "webhook-signature", version = "1" }
    }
    agent = {
      ACCESSWRIGHT_HOSTED_CONFIG          = { secret_id = "agent-config", version = "1" }
      ACCESSWRIGHT_GITHUB_APP_PRIVATE_KEY = { secret_id = "app-key", version = "1" }
      OPENAI_API_KEY                      = { secret_id = "model-key", version = "1" }
    }
    relay = { ACCESSWRIGHT_HOSTED_CONFIG = { secret_id = "relay-config", version = "1" } }
    verifier = {
      ACCESSWRIGHT_HOSTED_CONFIG          = { secret_id = "verifier-config", version = "1" }
      ACCESSWRIGHT_GITHUB_APP_PRIVATE_KEY = { secret_id = "app-key", version = "1" }
    }
    dashboard = {
      ACCESSWRIGHT_DASHBOARD_USERNAME = { secret_id = "dashboard-user", version = "1" }
      ACCESSWRIGHT_DASHBOARD_PASSWORD = { secret_id = "dashboard-password", version = "1" }
    }
  }
}

run "private_bounded_plan" {
  command = plan
  assert {
    condition     = google_cloud_run_v2_job.worker.template[0].task_count == 1 && google_cloud_run_v2_job.worker.template[0].parallelism == 1 && google_cloud_run_v2_job.worker.template[0].template[0].max_retries == 0
    error_message = "Worker execution must be one task with no automatic retry."
  }
  assert {
    condition     = toset([for env in google_cloud_run_v2_job.worker.template[0].template[0].containers[0].env : env.name]) == toset(["ACCESSWRIGHT_AGENT_ORIGIN", "ACCESSWRIGHT_WORKER_SERVICE_ACCOUNT_EMAIL", "ACCESSWRIGHT_PROVIDER_VERIFICATION"])
    error_message = "Worker template must contain only public/scoped runtime settings, never credentials."
  }
  assert {
    condition     = !contains(keys(google_project_iam_member.metadata), "worker") && !contains([for ref in local.secret_refs : ref.role], "worker") && length(google_cloud_run_v2_service_iam_member.webhook) == 0
    error_message = "Worker must lack project/secret roles and public webhook must remain disabled by default."
  }
  assert {
    condition     = google_storage_bucket.candidates.public_access_prevention == "enforced" && google_storage_bucket.candidates.uniform_bucket_level_access && google_storage_bucket.candidates.soft_delete_policy[0].retention_duration_seconds == 0 && !google_storage_bucket.candidates.versioning[0].enabled
    error_message = "Candidates must be private and deletable without retained versions."
  }
  assert {
    condition     = toset(keys(google_cloud_run_v2_service.role)) == toset(["webhook", "agent", "relay", "dashboard"]) && contains(keys(google_service_account.role), "verifier")
    error_message = "Native Docker verifier must not be deployed as a Cloud Run service."
  }
  assert {
    condition     = toset(google_project_iam_custom_role.execution_reader.permissions) == toset(["run.operations.get", "run.executions.get", "run.executions.list"])
    error_message = "Execution observation must not gain launch, cancel, delete or publication permissions."
  }
  assert {
    condition     = alltrue([for service in google_cloud_run_v2_service.role : service.template[0].scaling[0].max_instance_count == 1 && service.template[0].max_instance_request_concurrency == 1]) && alltrue([for queue in google_cloud_tasks_queue.queue : queue.rate_limits[0].max_concurrent_dispatches == 1])
    error_message = "Service replicas and task dispatch must remain bounded."
  }
}
run "explicit_public_signed_webhook" {
  command = plan
  variables { public_webhook = true }
  assert {
    condition     = length(google_cloud_run_v2_service_iam_member.webhook) == 1 && google_cloud_run_v2_service_iam_member.webhook[0].member == "allUsers" && alltrue([for member in google_cloud_run_v2_service_iam_member.dashboard : member.member != "allUsers"])
    error_message = "Only separately selected signed-webhook ingress may be public."
  }
}
run "reject_mutable_image" {
  command = plan
  variables { worker_image = "europe-west3-docker.pkg.dev/fixture/images/worker:latest" }
  expect_failures = [var.worker_image]
}
run "reject_public_dashboard" {
  command = plan
  variables { dashboard_members = ["allUsers"] }
  expect_failures = [var.dashboard_members]
}
run "reject_worker_secret_scope" {
  command = plan
  variables { runtime_secrets = { worker = { OPENAI_API_KEY = { secret_id = "model-key", version = "1" } } } }
  expect_failures = [var.runtime_secrets]
}
run "reject_unpinned_secret_version" {
  command = plan
  variables {
    runtime_secrets = merge(var.runtime_secrets, { agent = merge(var.runtime_secrets.agent, { OPENAI_API_KEY = { secret_id = "model-key", version = "latest" } }) })
  }
  expect_failures = [var.runtime_secrets]
}
run "reject_collection_path" {
  command = plan
  variables { dashboard_collection = "reports/private" }
  expect_failures = [var.dashboard_collection]
}
