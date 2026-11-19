export interface Condition {
  type: 'user_in_project_role' | 'user_in_group' | 'issue_field_value' | 'permission_check' | 'always_true';
  role_id?: number;
  group_id?: number;
  field?: string;
  operator?: string;
  value?: any;
  permission?: string;
}

export interface Validator {
  type: 'field_required' | 'field_regex' | 'field_value' | 'custom_script' | 'approval_required' | 'module_check';
  /** approval_required: only approvals created from the template with this name count (all approvals when empty). */
  template?: string;
  /** module_check: name of a check registered by a module (for example `itsm.postmortem`). */
  check?: string;
  field?: string;
  pattern?: string;
  operator?: string;
  value?: any;
  script?: string;
}

export interface PostFunction {
  type: 'update_field' | 'assign_to_user' | 'set_resolution' | 'clear_field' | 'add_comment' | 'fire_event' | 'update_date' | 'request_approval';
  /** request_approval: name of the approval template (in the issue's project) to start. */
  template?: string;
  field?: string;
  value?: any;
  user_id?: number | null;
  resolution_id?: number | null;
  body?: string;
  event_id?: string;
}
