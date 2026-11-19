export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

export class ScimError extends Error {
  constructor(public status: number, public scimType: string | undefined, public detail: string) {
    super(detail);
    this.name = 'ScimError';
  }
  static invalidFilter(detail: string) { return new ScimError(400, 'invalidFilter', detail); }
  static invalidValue(detail: string) { return new ScimError(400, 'invalidValue', detail); }
  static invalidSyntax(detail: string) { return new ScimError(400, 'invalidSyntax', detail); }
  static invalidPath(detail: string) { return new ScimError(400, 'invalidPath', detail); }
  static noTarget(detail: string) { return new ScimError(400, 'noTarget', detail); }
  static mutability(detail: string) { return new ScimError(400, 'mutability', detail); }
  static uniqueness(detail: string) { return new ScimError(409, 'uniqueness', detail); }
  static notFound(detail = 'Resource not found') { return new ScimError(404, undefined, detail); }
  static unauthorized() { return new ScimError(401, undefined, 'Authentication required'); }
}

export function errorBody(status: number, detail: string, scimType?: string) {
  return { schemas: [SCIM_ERROR_SCHEMA], status: String(status), ...(scimType ? { scimType } : {}), detail };
}
