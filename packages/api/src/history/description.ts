/**
 * Description versions. The issue history already stores old and new values of every description change
 * (field `description`), so no extra table is needed: versions are derived from those rows.
 * Version 1 is the text the issue was created with (the old value of the first change).
 */

export interface DescriptionChange {
  id: number;
  at: Date;
  from: string | null;
  to: string | null;
  by: number | null;
}

export interface DescriptionVersion {
  /** 1-based, oldest first */
  version: number;
  /** history row that produced this version; null for the original text */
  historyId: number | null;
  createdAt: Date | null;
  authorId: number | null;
  text: string;
  current: boolean;
}

export function buildDescriptionVersions(input: {
  createdAt: Date | null;
  creatorId: number | null;
  changes: DescriptionChange[];
}): DescriptionVersion[] {
  const changes = [...input.changes].sort((a, b) => a.at.getTime() - b.at.getTime() || a.id - b.id);
  const out: DescriptionVersion[] = [];
  if (changes.length === 0) return out;
  out.push({ version: 1, historyId: null, createdAt: input.createdAt, authorId: input.creatorId, text: changes[0].from ?? '', current: false });
  for (const ch of changes) {
    out.push({ version: out.length + 1, historyId: ch.id, createdAt: ch.at, authorId: ch.by, text: ch.to ?? '', current: false });
  }
  out[out.length - 1].current = true;
  return out;
}
