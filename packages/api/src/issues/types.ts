export interface CreateIssueRequest {
  projectId: number;
  issueTypeId: number;
  summary: string;
  description?: string;
  priorityId?: number;
  assigneeId?: number;
  parentId?: number;
  labels?: string[];
  components?: number[];
  fixVersions?: number[];
  affectsVersions?: number[];
  dueDate?: string;
  startDate?: string | null;
  storyPoints?: number | null;
  timeEstimate?: number;
  environment?: string;
  customFields?: Array<{ fieldId: number; value: any }>;
  /** undefined = the project's default level; null = no level. The caller checks SET_ISSUE_SECURITY when this is given. */
  securityLevelId?: number | null;
}

export interface UpdateIssueRequest {
  summary?: string;
  description?: string;
  priorityId?: number | null;
  assigneeId?: number | null;
  statusId?: number;
  resolutionId?: number;
  labels?: string[];
  components?: number[];
  fixVersions?: number[];
  affectsVersions?: number[];
  dueDate?: string | null;
  startDate?: string | null;
  storyPoints?: number | null;
  timeEstimate?: number;
  timeSpent?: number;
  environment?: string;
  parentId?: number | null;
  flagged?: boolean;
  customFields?: Array<{ fieldId: number; value: any }>;
  securityLevelId?: number | null;
}

export interface IssueResponse {
  id: number;
  key: string;
  self: string;
  fields: Record<string, any>;
}
