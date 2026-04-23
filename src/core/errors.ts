// Error taxonomy. Every failure mode has a stable code for clients.
// Codes are MCP-compatible (JSON-RPC application errors use negative space below -32000).

export const ErrorCodes = {
  // Input & validation
  invalid_params:          -32602,
  schema_violation:        -32000,
  path_invalid:            -32001,
  cursor_invalid:          -32002,

  // Auth & capability
  unauthenticated:         -32010,
  forbidden:               -32011,
  capability_missing:      -32012,
  write_mode_denied:       -32013, // raw write refused; use a transition

  // State & preconditions
  precondition_failed:     -32020,
  not_found:               -32021,
  conflict:                -32022,
  bounds_violation:        -32023,
  lock_held:               -32024,
  lock_fence_mismatch:     -32025,
  version_conflict:        -32026,

  // Control plane
  schema_immutable:        -32030,
  transition_unavailable:  -32031,
  transition_name_taken:   -32032,
  policy_invalid:          -32033,

  // Limits
  rate_limited:            -32040,
  too_large:               -32041,
  validation_timeout:      -32042,

  // Server
  internal:                -32099,
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

export class LedgerError extends Error {
  public readonly code: ErrorCode;
  public readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "LedgerError";
  }

  toJsonRpcError(): { code: number; message: string; data?: Record<string, unknown> } {
    const err: { code: number; message: string; data?: Record<string, unknown> } = {
      code: ErrorCodes[this.code],
      message: this.message,
    };
    if (this.details !== undefined) err.data = { code: this.code, ...this.details };
    else err.data = { code: this.code };
    return err;
  }
}
