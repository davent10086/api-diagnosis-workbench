import type { LocatedCandidate, LocationResult } from "./request-location-types";

/** Preserve the full review within the workbench's 10 KB context budget. */
export function buildLocationImport(candidate: LocatedCandidate, result: LocationResult) {
  const review = {
    locationStatus: "human_confirmed",
    rootCauseConfirmed: false,
    requestId: candidate.requestId,
    reviewedAt: new Date().toISOString(),
    username: result.username,
    originalTime: result.originalTime,
    interpretedTime: result.interpretedTime,
    timezoneOffsetMinutes: result.timezoneOffsetMinutes,
    clues: result.clues,
    rounds: result.rounds,
    searchStatus: result.status,
    stopReason: result.stopReason,
    searchError: result.error,
    requests: result.requests,
    scanned: result.scanned,
    matches: candidate.matches,
    conflicts: candidate.conflicts,
    relatedGroups: result.groups.filter((group) => group.requestIds.includes(candidate.requestId)),
  };
  const audit = `\nrequest_location_review=${JSON.stringify(review)}`;
  if (audit.length > 9500) throw new Error("定位依据过长，请缩小查询范围或减少关键词后再导入。");
  const content = candidate.imported.context.slice(0, Math.min(4000, 10000 - audit.length));
  return { metadata: candidate.imported.metadata, context: `${content}${audit}` };
}
