output "service_origins" { value = { for role, service in google_cloud_run_v2_service.role : role => service.uri } }
output "service_accounts" { value = { for role, account in google_service_account.role : role => account.email } }
output "job_name" { value = google_cloud_run_v2_job.worker.name }
output "queue_names" { value = { for name, queue in google_cloud_tasks_queue.queue : name => queue.name } }
output "candidate_bucket" { value = google_storage_bucket.candidates.name }
