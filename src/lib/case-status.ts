export const caseStatus = {
  uploading: "uploading",
  completed: "completed",
  analyzing: "analyzing",
} as const;

export type ManagedCaseStatus = (typeof caseStatus)[keyof typeof caseStatus];

export function canCompleteCase(status: string) {
  return status === caseStatus.uploading;
}
