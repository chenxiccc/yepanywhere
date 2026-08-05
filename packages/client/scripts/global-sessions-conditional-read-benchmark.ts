/**
 * How many session-collection walks a herd of tabs still asks for once each
 * one replays the generation it already holds rows for.
 *
 * The model server is the landed contract: it holds a generation, advances it
 * when the collection changes, and answers a read whose `knownGeneration`
 * matches with no rows. The client side is the real predicate, so the arms
 * differ only in whether the capability gate is on.
 */
import { knownGenerationToSend } from "../src/hooks/useGlobalSessionsFeed.js";

const TABS = 20;
const REVALIDATIONS = 10;
/** Rounds after which the collection actually changed. */
const CHANGED_ROUNDS = new Set([3, 7]);
const ROWS = 100;

interface Arm {
  /** Reads the server answered by walking and returning rows. */
  walks: number;
  /** Rows the server serialized and each tab re-applied to its store. */
  rows: number;
}

function measure(supported: boolean): Arm {
  const arm: Arm = { walks: 0, rows: 0 };
  let serverGeneration = 1;
  const accepted = new Map<number, number>();

  for (let round = 0; round <= REVALIDATIONS; round += 1) {
    if (CHANGED_ROUNDS.has(round)) serverGeneration += 1;

    for (let tab = 0; tab < TABS; tab += 1) {
      const offered = knownGenerationToSend({
        supported,
        accepted: accepted.get(tab),
        retained: accepted.has(tab),
        retainedRows: ROWS,
        requestedRows: ROWS,
        hasMore: false,
      });
      accepted.set(tab, serverGeneration);
      if (offered === serverGeneration) continue;

      arm.walks += 1;
      arm.rows += ROWS;
    }
  }

  return arm;
}

function percent(before: number, after: number): string {
  if (before === 0) return "0.00%";
  return `${(((before - after) / before) * 100).toFixed(2)}%`;
}

function main(): void {
  const ungated = measure(false);
  const gated = measure(true);
  const reads = TABS * (REVALIDATIONS + 1);

  console.log(
    `${TABS} tabs x ${REVALIDATIONS + 1} reads = ${reads}, ` +
      `collection changed ${CHANGED_ROUNDS.size} times`,
  );
  console.log(
    `walks: ${ungated.walks} -> ${gated.walks} ` +
      `(${percent(ungated.walks, gated.walks)} avoided, ` +
      `${(ungated.walks / gated.walks).toFixed(2)}x)`,
  );
  console.log(
    `rows returned: ${ungated.rows} -> ${gated.rows} ` +
      `(${percent(ungated.rows, gated.rows)} avoided)`,
  );

  // Every tab must still see every change: one full read each, plus the first.
  const expected = TABS * (CHANGED_ROUNDS.size + 1);
  if (gated.walks !== expected) {
    throw new Error(
      `${gated.walks} walks for ${expected} expected; a tab either missed a ` +
        `change or paid for one it did not need`,
    );
  }
  if (ungated.walks !== reads) {
    throw new Error(`ungated arm walked ${ungated.walks} of ${reads} reads`);
  }
}

main();
