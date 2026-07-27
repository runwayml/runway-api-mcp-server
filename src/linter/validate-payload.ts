import { ENDPOINTS } from "./generated/constraints.js";
import type {
  EndpointConstraints,
  ModelVariant,
  ParamConstraint,
} from "./types.js";

export interface PayloadValidationResult {
  ok: boolean;
  findings: string[];
}

type ScalarValue = string | number | boolean;

const ENDPOINTS_BY_PATH = new Map(
  Object.values(ENDPOINTS).map((endpoint) => [endpoint.path, endpoint])
);

function formatList(values: readonly (string | number)[]): string {
  return values.map((v) => JSON.stringify(v)).join(", ");
}

/** Normalize MCP paths (`/image_to_video`) and OpenAPI paths (`/v1/image_to_video`). */
function resolveEndpoint(path: string): EndpointConstraints | undefined {
  if (ENDPOINTS_BY_PATH.has(path)) return ENDPOINTS_BY_PATH.get(path);
  const withV1 = path.startsWith("/v1/") ? path : `/v1${path.startsWith("/") ? path : `/${path}`}`;
  return ENDPOINTS_BY_PATH.get(withV1);
}

/**
 * Valid model IDs for a generation endpoint, ordered with `recommended` first
 * when provided. Returns [] for unknown / non-generation paths. Used to build
 * validated `model` enums on the MCP tools from the same OpenAPI source.
 */
export function modelIdsForPath(path: string, recommended?: string): string[] {
  const endpoint = resolveEndpoint(path);
  if (!endpoint) return [];
  const ids = Object.keys(endpoint.models);
  if (recommended && ids.includes(recommended)) {
    return [recommended, ...ids.filter((id) => id !== recommended)];
  }
  return ids;
}

function checkNumeric(
  value: ScalarValue,
  constraint: ParamConstraint
): string | null {
  if (typeof value !== "number") {
    return `expected ${constraint.type ?? "number"}, got ${JSON.stringify(value)}`;
  }
  if (constraint.type === "integer" && !Number.isInteger(value)) {
    return `expected integer, got ${JSON.stringify(value)}`;
  }
  const { minimum, maximum } = constraint;
  if (
    (minimum !== undefined && value < minimum) ||
    (maximum !== undefined && value > maximum)
  ) {
    return `must be between ${minimum ?? "-∞"} and ${maximum ?? "∞"}, got ${value}`;
  }
  return null;
}

function checkString(
  value: ScalarValue,
  constraint: ParamConstraint
): string | null {
  if (typeof value !== "string") {
    return `expected string, got ${JSON.stringify(value)}`;
  }
  const { minLength, maxLength } = constraint;
  const tooShort = minLength !== undefined && value.length < minLength;
  const tooLong = maxLength !== undefined && value.length > maxLength;
  if (tooShort || tooLong) {
    return `must be ${minLength ?? 0}–${maxLength ?? "∞"} characters, got ${value.length}`;
  }
  return null;
}

function checkValue(
  value: ScalarValue,
  constraint: ParamConstraint
): string | null {
  if (constraint.const !== undefined && value !== constraint.const) {
    return `must be exactly ${JSON.stringify(constraint.const)}, got ${JSON.stringify(value)}`;
  }
  if (
    constraint.enum &&
    !constraint.enum.includes(value as string | number)
  ) {
    return `got ${JSON.stringify(value)}; allowed values: ${formatList(constraint.enum)}`;
  }
  if (constraint.type === "integer" || constraint.type === "number") {
    return checkNumeric(value, constraint);
  }
  if (
    constraint.type === "string" &&
    (constraint.minLength !== undefined || constraint.maxLength !== undefined)
  ) {
    return checkString(value, constraint);
  }
  if (constraint.type === "boolean" && typeof value !== "boolean") {
    return `expected boolean, got ${JSON.stringify(value)}`;
  }
  return null;
}

function isScalar(value: unknown): value is ScalarValue {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function checkParam(
  model: string,
  variant: ModelVariant,
  name: string,
  value: unknown,
  findings: string[]
): void {
  const constraint = variant.params[name];
  if (!constraint) {
    findings.push(
      `'${name}' is not a parameter of model '${model}'. Known parameters: ${Object.keys(variant.params).join(", ")}.`
    );
    return;
  }
  // Nested objects/arrays have empty constraints — known but not scalar-checked.
  if (!isScalar(value)) return;
  const problem = checkValue(value, constraint);
  if (problem) {
    findings.push(`Model '${model}' parameter '${name}': ${problem}.`);
  }
}

/**
 * Validate a Runway generation request body against OpenAPI-derived model
 * constraints. Unknown / non-generation paths return ok (no-op) so task and
 * org calls stay untouched.
 */
export function validatePayload(
  path: string,
  body: unknown
): PayloadValidationResult {
  const endpoint = resolveEndpoint(path);
  if (!endpoint) return { ok: true, findings: [] };

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      findings: [`Request body for ${endpoint.path} must be a JSON object.`],
    };
  }

  const payload = body as Record<string, unknown>;
  const findings: string[] = [];
  const model = payload.model;

  if (model === undefined) {
    return {
      ok: false,
      findings: [
        `Missing required 'model' parameter for ${endpoint.path}. Valid models: ${formatList(Object.keys(endpoint.models))}.`,
      ],
    };
  }

  if (typeof model !== "string") {
    return {
      ok: false,
      findings: [
        `Model must be a string for ${endpoint.path}, got ${JSON.stringify(model)}.`,
      ],
    };
  }

  const variant = endpoint.models[model];
  if (!variant) {
    return {
      ok: false,
      findings: [
        `Unknown model '${model}' for ${endpoint.path}. Valid models: ${formatList(Object.keys(endpoint.models))}.`,
      ],
    };
  }

  for (const [name, value] of Object.entries(payload)) {
    if (name === "model" || value === undefined) continue;
    checkParam(model, variant, name, value, findings);
  }

  const missing = variant.required.filter(
    (name) => name !== "model" && !(name in payload && payload[name] !== undefined)
  );
  if (missing.length > 0) {
    findings.push(
      `Missing required parameters for model '${model}': ${missing.join(", ")}.`
    );
  }

  return { ok: findings.length === 0, findings };
}
