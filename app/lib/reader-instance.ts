import "server-only";

import { FirestoreDashboardReader, workloadAccessToken } from "./run-data";

/** Server-only Cloud Run identity. Deployment must independently restrict ingress and Firestore IAM. */
export function dashboardReader(): FirestoreDashboardReader {
  const projectId = process.env.ACCESSWRIGHT_GCP_PROJECT_ID;
  const collectionId = process.env.ACCESSWRIGHT_FIRESTORE_RUN_COLLECTION;
  if (!projectId || !collectionId) throw new Error("Dashboard Firestore metadata access is not configured");
  return new FirestoreDashboardReader({
    projectId, collectionId, getAccessToken: () => workloadAccessToken(),
  });
}
