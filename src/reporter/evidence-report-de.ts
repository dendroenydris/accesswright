import { z } from "zod";

import { criterionReference, referenceEdition, referenceSource } from "../planner/references.js";
import { RunReportSchema } from "./report.js";
import type { RunReport } from "./report.js";
import type { EvidenceReportOptions } from "./evidence-report.js";

const commitSchema = z.object({
  id: z.string().min(1),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll("|", "&#124;")
    .replaceAll("@", "@\u200b").replace(/[\r\n]/g, " ");
}

function checkStatus(status: RunReport["checks"][number]["status"]): string {
  return status === "passed" ? "bestanden" : status === "failed" ? "fehlgeschlagen" : "nicht verfügbar";
}

function taskStatus(status: RunReport["outcomes"][number]["status"]): string {
  const values = {
    verified: "technisch verifiziert",
    rejected: "abgelehnt",
    "needs-human": "manuelle Prüfung erforderlich",
    ignored: "nicht bearbeitet",
    dropped: "aus der Änderung entfernt",
  } as const;
  return values[status];
}

/**
 * German technical evidence template. Automated checkers cannot certify
 * WCAG, EN 301 549 or EAA legal conformity. No source, screenshot, prompt
 * or provider credential is accepted by this aggregate output.
 */
export function renderGermanEvidenceReport(
  input: RunReport,
  rawOptions: EvidenceReportOptions,
): string {
  const report = RunReportSchema.parse(input);
  const commits = z.array(commitSchema).max(200).parse(rawOptions.commits);
  const accepted = report.final.acceptedFixIds;
  const commitment = new Map(commits.map(item => [item.id, item.commit]));
  if (
    new Set(accepted).size !== accepted.length ||
    commitment.size !== commits.length ||
    commits.length !== accepted.length ||
    accepted.some(id => !commitment.has(id))
  ) {
    throw new Error("Commit-Nachweise und akzeptierte Fix-IDs stimmen nicht überein");
  }
  const scan = report.scanSummary;
  const review = report.outcomes.filter(item =>
    ["needs-human", "rejected", "dropped"].includes(item.status));
  const incomplete = scan?.rules.reduce((sum, item) => sum + item.incomplete, 0) ?? null;

  const lines: string[] = [
    "# Technischer Barrierefreiheits-Prüfbericht",
    "",
    "**Dies ist kein Konformitätsnachweis** im Sinne von WCAG, EN 301 549 oder dem European Accessibility Act (EAA).",
    "Automatisierte Prüfungen bestätigen weder rechtliche Anwendbarkeit noch vollständige Barrierefreiheit.",
    "",
    "## Lauf und Entscheidung",
    "",
    "Prüfzeitraum: " + report.startedAt + " bis " + report.finishedAt + ".",
    "Abschluss: **" + (report.status === "verified" ? "technisch verifiziert" : "blockiert / nicht zur Freigabe geeignet") + "**.",
    "Reparaturgruppen: " + report.fixed + " als behoben gemeldet; " + report.rejected + " abgelehnt; " + report.needsHuman + " manuell zu prüfen.",
  ];
  if (report.final.failures.length) {
    lines.push("Offene abschließende Prüffehler: " + report.final.failures.map(item => escape(item.check)).join(", ") + ".");
  }
  lines.push(
    "",
    "## Befunde nach Prüfregel",
    "",
    "Zähleinheit: Befunde je Route und Prüfzustand; keine Anzahl einzigartiger Quellcodefehler.",
    "",
    "| Regel | WCAG | EN 301 549 | Gefunden | Differenz | Offen | Unklar |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: |",
  );
  if (scan?.rules.length) {
    for (const item of scan.rules) {
      const reviewedEn = criterionReference(item.criterion).en301549;
      lines.push("| " + escape(item.ruleId) + " | " + escape(item.criterion) + " | " +
        (reviewedEn ?? "nicht zugeordnet") + " | " + item.before + " | " +
        Math.max(0, item.before - item.remaining) + " | " + item.remaining + " | " + item.incomplete + " |");
    }
  } else {
    lines.push("| nicht erfasst | nicht erfasst | nicht zugeordnet | — | — | — | — |");
  }
  lines.push("", "## Git-Nachweise für verifizierte Änderungsgruppen", "");
  if (report.status === "blocked") {
    lines.push("**Die abschließende Gesamtprüfung ist blockiert.** Einzelne Commits sind dadurch nicht zur Freigabe berechtigt.", "");
  }
  if (accepted.length) {
    for (const id of accepted) {
      const outcome = report.outcomes.find(item => item.id === id);
      lines.push("- " + escape(outcome?.ruleId ?? "unbekannt") + " / " +
        escape(outcome?.criterion ?? "unbekannt") + ": " + commitment.get(id));
    }
  } else {
    lines.push("- Keine akzeptierten Reparatur-Commits.");
  }
  lines.push(
    "",
    "## Manuelle Prüfung und Grenzen",
    "",
    "Unklare Checker-Befunde: " + (incomplete ?? "nicht erfasst") + ". Nicht verfügbare Interaktionsproben: " + (scan?.probeUnavailable ?? "nicht erfasst") + ".",
    ...(review.length ? review.map(item =>
      "- " + escape(item.ruleId) + " / " + escape(item.criterion) + ": " + taskStatus(item.status) + ".",
    ) : ["- Keine explizit eskalierten Reparaturaufgaben dokumentiert."]),
    "",
    "- Semantische Angemessenheit von Alternativtexten und zugänglichen Namen manuell prüfen.",
    "- Tastaturbedienbarkeit, Screenreader-Verhalten und Nutzerabläufe separat prüfen.",
    "- Medienalternativen, Bewegung, Zeitbeschränkungen und kognitive Anforderungen separat bewerten.",
    "- Rechtliche Geltung und vollständige WCAG-/EN-/EAA-Konformität werden nicht bescheinigt.",
    "",
    "## Technischer Geltungsbereich",
    "",
    "Routen: " + (scan?.routes.map(escape).join(", ") || "nicht erfasst") + ".",
    "Prüfzustände: " + (scan?.conditions.map(escape).join(", ") || "nicht erfasst") + ".",
    "axe-core-Version: " + (scan?.checkerVersions.map(escape).join(", ") || "nicht erfasst") + ".",
    "Quellortzuordnung: " + (scan ? scan.sourceMapping.mapped + "/" + scan.sourceMapping.total : "nicht erfasst") + ".",
    "Abdeckung: " + (scan === undefined ? "nicht erfasst" : scan.coverageComplete
      ? "vollständige Abdeckung der dokumentierten Basis-Routen und Zustände" : "unvollständig") + ".",
    "Produktionsprüfungen: " + (report.checks.length
      ? report.checks.map(item => (item.check === "tests" ? "Tests" : item.check) + ": " + checkStatus(item.status)).join("; ")
      : "nicht erfasst") + ".",
    "Modellherkunft: " + escape(report.providerVerification) + "; Token: " + report.usage.inputTokens + " Eingang, " + report.usage.outputTokens + " Ausgang.",
    "Erfasste Modellkosten (USD): " + report.usage.spentUsd.toFixed(6) +
      (report.unknownUsage ? "; zusätzlich nicht abgeglichen / keine weiteren bezahlten Aufrufe erlaubt" : "") + ".",
    "",
    "Technische Quellenreferenz: " + referenceEdition + ". Quelle: " + referenceSource + ". Nicht überprüfte Zuordnungen bleiben offen.",
    "",
  );
  return lines.join("\n");
}
