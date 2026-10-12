# Hosted infrastructure

Terraform for the hosted GitHub App on Google Cloud. It has only been tested against mocked provider plans; it has not been applied to a real project.

## What it creates

- Four Cloud Run services: webhook, agent, candidate relay and dashboard.
- One secretless worker Job (one task, no retries) that can only call the agent.
- Two serial Cloud Tasks queues.
- A private candidate bucket: public access prevented, uniform access, no versioning or retention.
- A separate service account per role. The dashboard account only reads Firestore metadata.

It does not create the Docker verifier host, VMs, firewalls, service-account keys, billing, API enablement, the Firestore database or secret values. The verifier needs Docker, so it cannot run on Cloud Run and must be hosted separately on Linux.

## Check locally

Use the Terraform version in `versions.tf` and the committed lockfile:

```sh
terraform init -backend=false -input=false -lockfile=readonly
terraform fmt -check -recursive
terraform validate
terraform test
```

The tests use `mock_provider "google"` with fake digests and identities. They check the resource shape: immutable images, a private dashboard, no worker credentials, pinned secret versions. They do not test live IAM.

## Inputs

See `variables.tf`. In short:

- `project_id`, `region`, `prefix`: an existing project with the Cloud Run, Cloud Tasks, Firestore, Storage, Secret Manager and IAM APIs enabled.
- `service_images`, `worker_image`: immutable image digests. The three backend services run `/accesswright/dist/src/hosted/service-entry.js`; the dashboard listens on `PORT=8080`; the worker image is built from `Dockerfile.worker`.
- `runtime_secrets`: existing secret IDs with numeric versions. Each role's `ACCESSWRIGHT_HOSTED_CONFIG` must match `HostedServiceConfigSchema`. The worker gets no secrets.
- `dashboard_collection`, `dashboard_members`: the metadata collection and who may open the dashboard.
- `public_webhook`: off by default.

Run `terraform plan` with an operator identity, never a key file, and review it before `apply`. Backend state, locking and imports of existing resources are up to you.

Provider references: [Cloud Run Job](https://github.com/hashicorp/terraform-provider-google/blob/v8.6.0/website/docs/r/cloud_run_v2_job.html.markdown), [Storage bucket](https://github.com/hashicorp/terraform-provider-google/blob/v8.6.0/website/docs/r/storage_bucket.html.markdown), [Cloud Run permissions](https://docs.cloud.google.com/iam/docs/roles-permissions/run).
