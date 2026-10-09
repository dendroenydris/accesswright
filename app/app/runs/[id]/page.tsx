import Link from "next/link";
import { notFound } from "next/navigation";
import { dashboardReader } from "../../../lib/reader-instance";
import type { DashboardRun } from "../../../lib/run-data";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };
export default async function RunPage({ params }: Props) {
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound();
  let run: DashboardRun | undefined;
  let available = true;
  try { run = await dashboardReader().get(id); }
  catch { available = false; }
  if (available && !run) notFound();
  return <main className="page">
    <Link href="/" className="back-link">← All runs</Link>
    <p className="eyebrow">RUN RECORD / PRIVATE METADATA</p>
    <h1>Run details</h1>
    {!available || !run ? <div role="alert" className="notice">This record could not be retrieved securely. No unverified data is shown.</div> : <>
      <p className="subhead mono">{run.runId}</p>
      <dl className="details">
        <div><dt>Repository</dt><dd>{run.repository}</dd></div>
        <div><dt>Installation</dt><dd>{run.installationId}</dd></div>
        <div><dt>State</dt><dd>{run.status}</dd></div>
        <div><dt>Accepted fixes</dt><dd>{run.acceptedFixes}</dd></div>
        <div><dt>Eligible for trusted review</dt><dd>{run.eligibleForReview ? "Yes" : "No"}</dd></div>
        <div><dt>Verified base commit</dt><dd className="mono">{run.verifiedBaseSha ?? "Not verified"}</dd></div>
        <div><dt>Checks needing attention</dt><dd>{run.failedChecks.length ? run.failedChecks.join(", ") : "None reported"}</dd></div>
        <div><dt>Unreconciled provider usage</dt><dd>{run.unknownUsage ? "Yes — blocked" : "No"}</dd></div>
        <div><dt>Recorded cost</dt><dd>$ {run.spentUsd.toFixed(6)} USD</dd></div>
        <div><dt>Recorded at</dt><dd><time dateTime={run.recordedAt}>{run.recordedAt}</time></dd></div>
      </dl>
      <p className="notice">This is an aggregate record. No original model report, source code, tokens or provider logs are available in this dashboard.</p>
    </>}
  </main>;
}
