import Link from "next/link";
import { dashboardReader } from "../lib/reader-instance";
import type { DashboardRun } from "../lib/run-data";

export const dynamic = "force-dynamic";

function Status({ value }: { value: DashboardRun["status"] }) {
  return <span className={"status status-" + value}>{value.replaceAll("-", " ")}</span>;
}

export default async function HomePage() {
  let runs: DashboardRun[] = [];
  let limited = false;
  let available = true;
  try {
    ({ runs, limited } = await dashboardReader().list());
  } catch {
    available = false;
  }
  const ready = runs.filter(run => run.status === "ready-for-review").length;
  const blocked = runs.filter(run => run.status === "blocked").length;
  return (
    <main className="page">
      <p className="eyebrow">OPERATIONS / HOSTED RUNS</p>
      <h1>Accessibility repair runs</h1>
      <p className="subhead">Metadata from the trusted coordinator only. This view does not display target source, prompts, screenshots, secrets or unverified fixes.</p>
      {!available ? <div role="alert" className="notice">Dashboard backend unavailable or unauthorized. No cached or fabricated run data is shown.</div> : <>
        <div className="stats">
          <article><strong>{runs.length}</strong><span>Runs listed</span></article>
          <article><strong>{ready}</strong><span>Ready for review</span></article>
          <article><strong>{blocked}</strong><span>Blocked</span></article>
        </div>
        {limited && <p className="notice">Only the first 250 Firestore records were loaded. This is not a complete run history.</p>}
        {runs.length === 0 ? <p className="empty">There are no run records in the selected Firestore collection.</p> :
          <div className="table-wrap"><table>
            <thead><tr><th>Run</th><th>Repository</th><th>Status</th><th>Accepted fixes</th><th>Recorded</th></tr></thead>
            <tbody>{runs.map(run => <tr key={run.runId}>
              <td><Link href={"/runs/" + encodeURIComponent(run.runId)} className="run-link">{run.runId.slice(0, 14)}</Link></td>
              <td className="mono">{run.repository}</td>
              <td><Status value={run.status}/></td>
              <td>{run.acceptedFixes}</td>
              <td><time dateTime={run.recordedAt}>{new Date(run.recordedAt).toLocaleString("en-GB", { timeZone: "UTC" })} UTC</time></td>
            </tr>)}</tbody>
          </table></div>}
      </>}
    </main>
  );
}
