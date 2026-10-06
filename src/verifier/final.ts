export type FinalCheck = "build" | "typecheck" | "lint" | "tests" | "violations";

export interface FinalCheckSnapshot {
  build: string[];
  typecheck: string[];
  lint: string[];
  tests: string[];
  violations: string[];
}

export interface FinalFailure {
  check: FinalCheck;
  id: string;
}

export interface VerifyFinalOptions {
  baseline: FinalCheckSnapshot;
  fixIds: readonly string[];
  runChecks: (fixIds: readonly string[]) => Promise<FinalCheckSnapshot>;
  rerunTests: (
    fixIds: readonly string[],
    failingTests: readonly string[],
  ) => Promise<readonly string[]>;
}

export interface FinalVerificationResult {
  acceptedFixIds: string[];
  droppedFixIds: string[];
  failures: FinalFailure[];
}

const checks: readonly FinalCheck[] = [
  "build",
  "typecheck",
  "lint",
  "tests",
  "violations",
];

function difference(
  current: readonly string[],
  baseline: readonly string[],
): string[] {
  const baselineSet = new Set(baseline);
  return current.filter((item) => !baselineSet.has(item));
}

async function checkFixSet(
  options: VerifyFinalOptions,
  fixIds: readonly string[],
): Promise<FinalFailure[]> {
  const snapshot = await options.runChecks(fixIds);
  const failures: FinalFailure[] = [];

  for (const check of checks) {
    if (check === "tests") continue;
    for (const id of difference(snapshot[check], options.baseline[check])) {
      failures.push({ check, id });
    }
  }

  const newTestFailures = difference(snapshot.tests, options.baseline.tests);
  if (newTestFailures.length > 0) {
    const persistent = await options.rerunTests(fixIds, newTestFailures);
    const expected = new Set(newTestFailures);
    for (const id of persistent) {
      if (expected.has(id)) failures.push({ check: "tests", id });
    }
  }

  return failures;
}

async function findSingleCulprit(
  options: VerifyFinalOptions,
  fixIds: readonly string[],
): Promise<string | null> {
  if (fixIds.length === 0) return null;

  if (fixIds.length === 1) {
    const failures = await checkFixSet(options, fixIds);
    return failures.length === 0 ? null : fixIds[0] ?? null;
  }

  const midpoint = Math.ceil(fixIds.length / 2);
  const left = fixIds.slice(0, midpoint);
  const right = fixIds.slice(midpoint);

  if ((await checkFixSet(options, left)).length > 0) {
    return findSingleCulprit(options, left);
  }

  if ((await checkFixSet(options, right)).length > 0) {
    return findSingleCulprit(options, right);
  }

  return null;
}

export async function verifyFinal(
  options: VerifyFinalOptions,
): Promise<FinalVerificationResult> {
  const accepted = [...options.fixIds];
  const dropped: string[] = [];

  while (true) {
    const failures = await checkFixSet(options, accepted);
    if (failures.length === 0) {
      return {
        acceptedFixIds: accepted,
        droppedFixIds: dropped,
        failures: [],
      };
    }

    const culprit = await findSingleCulprit(options, accepted);
    if (culprit === null) {
      return {
        acceptedFixIds: accepted,
        droppedFixIds: dropped,
        failures,
      };
    }

    const index = accepted.indexOf(culprit);
    if (index === -1) {
      return {
        acceptedFixIds: accepted,
        droppedFixIds: dropped,
        failures,
      };
    }

    accepted.splice(index, 1);
    dropped.push(culprit);
  }
}
