import type { CycleRecord, PhaseRecord, WorkItem, WorkSize } from "./types.js";

const SIZE_ORDER: WorkSize[] = ["tiny", "small", "medium", "large", "oversized"];
const SIZE_POINTS: Record<WorkSize, number> = {
  tiny: 1,
  small: 2,
  medium: 4,
  large: 7,
  oversized: 10,
};

export interface WorkBreakdownSummary {
  itemCount: number;
  leafCount: number;
  maxDepth: number;
  estimatedPoints: number;
  largestLeafSize: WorkSize | null;
}

export interface ActualWorkSummary {
  size: WorkSize;
  uniqueFilesTouched: number;
  commandsRun: number;
  branchCandidates: number;
}

export function flattenWorkBreakdown(items: WorkItem[]): WorkItem[] {
  return items.flatMap((item) => [item, ...flattenWorkBreakdown(item.children ?? [])]);
}

export function leafWorkItems(items: WorkItem[]): WorkItem[] {
  return flattenWorkBreakdown(items).filter((item) => (item.children?.length ?? 0) === 0);
}

export function deriveProgramWorkItems(items: WorkItem[]): WorkItem[] {
  if (items.length === 0) {
    return [];
  }

  let current = items;
  while (
    current.length === 1
    && (current[0]?.children?.length ?? 0) > 0
    && (current[0]?.size === "large" || current[0]?.size === "oversized")
  ) {
    current = current[0]!.children!;
  }

  return current.slice(0, 8);
}

export function summarizeWorkBreakdown(items: WorkItem[]): WorkBreakdownSummary {
  if (items.length === 0) {
    return {
      itemCount: 0,
      leafCount: 0,
      maxDepth: 0,
      estimatedPoints: 0,
      largestLeafSize: null,
    };
  }

  const all = flattenWorkBreakdown(items);
  const leaves = leafWorkItems(items);

  function depth(itemsAtLevel: WorkItem[], level: number): number {
    return itemsAtLevel.reduce((maxDepth, item) => {
      const nextDepth = item.children?.length ? depth(item.children, level + 1) : level;
      return Math.max(maxDepth, nextDepth);
    }, level);
  }

  const largestLeafSize = leaves.reduce<WorkSize | null>((largest, item) => {
    if (!largest) {
      return item.size;
    }
    return SIZE_ORDER.indexOf(item.size) > SIZE_ORDER.indexOf(largest) ? item.size : largest;
  }, null);

  return {
    itemCount: all.length,
    leafCount: leaves.length,
    maxDepth: depth(items, 1),
    estimatedPoints: leaves.reduce((sum, item) => sum + SIZE_POINTS[item.size], 0),
    largestLeafSize,
  };
}

function phaseRecordsForActualSize(cycle: CycleRecord): PhaseRecord[] {
  return [
    ...cycle.phases,
    ...cycle.branches.flatMap((branch) => branch.phases),
  ];
}

function classifyActualSize(
  uniqueFilesTouched: number,
  commandsRun: number,
  branchCandidates: number,
): WorkSize {
  if (uniqueFilesTouched >= 30 || commandsRun >= 12 || branchCandidates >= 3) {
    return "oversized";
  }
  if (uniqueFilesTouched >= 16 || commandsRun >= 8 || branchCandidates >= 2) {
    return "large";
  }
  if (uniqueFilesTouched >= 8 || commandsRun >= 4) {
    return "medium";
  }
  if (uniqueFilesTouched >= 3 || commandsRun >= 2) {
    return "small";
  }
  return "tiny";
}

export function summarizeActualWork(cycle: CycleRecord): ActualWorkSummary {
  const records = phaseRecordsForActualSize(cycle);
  const uniqueFilesTouched = new Set(
    records.flatMap((phase) => phase.output.filesTouched ?? []),
  ).size;
  const commandsRun = records.reduce(
    (sum, phase) => sum + (phase.output.commandsRun?.length ?? 0),
    0,
  );
  const branchCandidates = cycle.branches.length;

  return {
    size: classifyActualSize(uniqueFilesTouched, commandsRun, branchCandidates),
    uniqueFilesTouched,
    commandsRun,
    branchCandidates,
  };
}

export function selectActiveWorkItems(
  items: WorkItem[],
  options?: { maxItems?: number; maxPoints?: number },
): WorkItem[] {
  const maxItems = options?.maxItems ?? 4;
  const maxPoints = options?.maxPoints ?? 8;

  function pickLeaves(leaves: WorkItem[], allowLarge = false): WorkItem[] {
    if (leaves.length === 0) {
      return [];
    }
    const preferredByTrack = leaves.filter((item) => item.track !== "exploration");
    const trackSource = preferredByTrack.length > 0 ? preferredByTrack : leaves;
    const preferred = allowLarge
      ? trackSource.filter((item) => item.size !== "oversized")
      : trackSource.filter((item) => item.size !== "large" && item.size !== "oversized");
    const source = preferred.length > 0 ? preferred : trackSource;
    const active: WorkItem[] = [];
    let usedPoints = 0;

    for (const item of source) {
      if (item.size === "oversized") {
        continue;
      }
      const points = SIZE_POINTS[item.size];
      const wouldOverflow = usedPoints + points > maxPoints;
      if (active.length > 0 && (active.length >= maxItems || wouldOverflow)) {
        continue;
      }
      active.push(item);
      usedPoints += points;
      if (active.length >= maxItems) {
        break;
      }
    }

    return active.length > 0 ? active : [source[0]!];
  }

  const programItems = deriveProgramWorkItems(items);
  for (let index = 0; index < programItems.length; index += 1) {
    const item = programItems[index]!;
    const hasChildren = (item.children?.length ?? 0) > 0;
    if (hasChildren || item.size === "large" || item.size === "oversized") {
      const active = pickLeaves(leafWorkItems([item]), false);
      if (active.length > 0) {
        return active;
      }
      continue;
    }

    const frontier: WorkItem[] = [];
    for (let cursor = index; cursor < programItems.length; cursor += 1) {
      const candidate = programItems[cursor]!;
      if ((candidate.children?.length ?? 0) > 0 || candidate.size === "large" || candidate.size === "oversized") {
        break;
      }
      frontier.push(candidate);
    }
    const active = pickLeaves(frontier, true);
    if (active.length > 0) {
      return active;
    }
  }

  return pickLeaves(leafWorkItems(items));
}

export function selectCurrentProgramSlice(
  items: WorkItem[],
  activeItems: WorkItem[],
): WorkItem | undefined {
  if (activeItems.length === 0) {
    return undefined;
  }

  const activeIds = new Set(activeItems.map((item) => item.id));
  for (const item of deriveProgramWorkItems(items)) {
    const leaves = leafWorkItems([item]);
    if (leaves.some((leaf) => activeIds.has(leaf.id))) {
      return item;
    }
  }

  return undefined;
}

export function selectDeferredWorkItems(
  items: WorkItem[],
  activeItems: WorkItem[],
): WorkItem[] {
  const activeIds = new Set(activeItems.map((item) => item.id));
  const orderedLeaves = deriveProgramWorkItems(items).flatMap((item) => leafWorkItems([item]));
  const source = orderedLeaves.length > 0 ? orderedLeaves : leafWorkItems(items);
  return source.filter((item) => !activeIds.has(item.id)).slice(0, 8);
}
