/** Model-output validation and public, safe errors. This module has no SDK/server imports. */
export interface SemanticPath {
  anchors: string[];
  entropy: number[];
  confidence: number[];
}

export type SemanticGenerationErrorCode =
  | "timeout" | "invalid_response" | "truncated" | "refused" | "rate_limit"
  | "authentication" | "credits" | "unavailable" | "network" | "configuration";

const SAFE_MESSAGES: Record<SemanticGenerationErrorCode, string> = {
  timeout: "The model timed out. No artwork was generated.",
  invalid_response: "The model returned an invalid or incomplete semantic path. No artwork was generated.",
  truncated: "The model response was truncated. No artwork was generated.",
  refused: "The model declined this request. No artwork was generated.",
  rate_limit: "The model is temporarily rate limited. Please try again later.",
  authentication: "The model provider rejected authentication. Check the server configuration.",
  credits: "The model provider requires additional credits.",
  unavailable: "The requested model is unavailable. No artwork was generated.",
  network: "The model provider could not be reached. Please try again later.",
  configuration: "The model request is not configured or is unsupported. Check the server configuration.",
};

export class SemanticGenerationError extends Error {
  readonly code: SemanticGenerationErrorCode;
  readonly retryable: boolean;
  readonly attempts: number;

  constructor(code: SemanticGenerationErrorCode, retryable: boolean, attempts = 0) {
    super(code === "unavailable" && retryable
      ? "The model provider is temporarily unavailable. Please try again later."
      : SAFE_MESSAGES[code]);
    this.name = "SemanticGenerationError";
    this.code = code;
    this.retryable = retryable;
    this.attempts = attempts;
    // Never retain the provider error as `cause`: it may contain request headers
    // or raw upstream text, and these errors cross API/logging boundaries.
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function isSemanticGenerationError(value: unknown): value is SemanticGenerationError {
  const error = record(value);
  return !!error && typeof error.code === "string"
    && Object.prototype.hasOwnProperty.call(SAFE_MESSAGES, error.code)
    && typeof error.retryable === "boolean" && typeof error.attempts === "number";
}

function providerError(value: unknown) {
  const outer = record(value) ?? {};
  const inner = record(outer.error) ?? outer;
  const nested = record(inner.error) ?? inner;
  const metadata = record(nested.metadata) ?? record(inner.metadata) ?? record(outer.metadata) ?? {};
  const rawStatus = outer.status ?? nested.code ?? inner.code ?? outer.code;
  const status = typeof rawStatus === "number" ? rawStatus : Number(rawStatus);
  return { outer, inner: nested, status, type: metadata.error_type ?? nested.type ?? inner.type ?? outer.type };
}

/** An optional JSON-mode compatibility retry is not an arbitrary 400 retry. */
export function isUnsupportedJsonMode(value: unknown): boolean {
  const { outer, inner, status } = providerError(value);
  if (status !== 400 && status !== 422) return false;
  const message = typeof inner.message === "string" ? inner.message : typeof outer.message === "string" ? outer.message : "";
  return /response[_ ]format|json[_ ]object|json mode|structured output/i.test(message)
    && /not support|unsupported|not available|not permitted|not allowed|invalid parameter/i.test(message);
}

/** Only stable metadata/status/name is exposed as a safe application error. */
export function classifySemanticGenerationError(value: unknown, attempts = 0): SemanticGenerationError {
  if (isSemanticGenerationError(value)) return new SemanticGenerationError(value.code, value.retryable, attempts || value.attempts);
  const { outer, status, type } = providerError(value);
  if (status === 401 || status === 403 || type === "authentication" || type === "permission_denied") {
    return new SemanticGenerationError("authentication", false, attempts);
  }
  if (status === 402 || type === "payment_required") return new SemanticGenerationError("credits", false, attempts);
  if (type === "refusal" || type === "content_policy_violation") return new SemanticGenerationError("refused", false, attempts);
  if (status === 404 || type === "not_found") return new SemanticGenerationError("unavailable", false, attempts);
  if (status === 429 || type === "rate_limit_exceeded") return new SemanticGenerationError("rate_limit", true, attempts);
  if (status === 408 || status === 504 || type === "timeout"
    || ["AbortError", "TimeoutError", "APIUserAbortError", "APITimeoutError", "APIConnectionTimeoutError"].includes(String(outer.name))) {
    return new SemanticGenerationError("timeout", true, attempts);
  }
  if (status >= 500 || type === "server" || type === "provider_overloaded" || type === "provider_unavailable") {
    return new SemanticGenerationError("unavailable", true, attempts);
  }
  if (["APIConnectionError", "FetchError"].includes(String(outer.name))
    || ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(String(outer.code))) {
    return new SemanticGenerationError("network", true, attempts);
  }
  if (isUnsupportedJsonMode(value)) return new SemanticGenerationError("invalid_response", true, attempts);
  // Unknown/programming errors are not retried blindly (or leaked to clients).
  return new SemanticGenerationError("configuration", false, attempts);
}

function invalid(): never {
  throw new SemanticGenerationError("invalid_response", true);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function scalar(value: unknown): number {
  // Numeric strings are harmless format variation. Empty strings, booleans,
  // null, hex, NaN and out-of-range values are not data to clamp or invent.
  const numeric = typeof value === "number" ? value
    : typeof value === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())
      ? Number(value.trim()) : NaN;
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) invalid();
  return numeric;
}

function anchor(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 256) invalid();
  return value.trim();
}

function oneAlias(value: Record<string, unknown>, keys: readonly string[]): unknown {
  const present = keys.filter((key) => Object.prototype.hasOwnProperty.call(value, key));
  if (present.length !== 1) invalid();
  return value[present[0]];
}

function isUnterminatedJson(text: string): boolean {
  if (!/^[\[{]/.test(text)) return false;
  const stack: string[] = [];
  let quoted = false;
  let escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      if (stack.pop() !== (char === "}" ? "{" : "[")) return false;
    }
  }
  return quoted || stack.length > 0;
}

/** JSON.parse otherwise silently accepts conflicting duplicate object keys. */
function rejectDuplicateKeys(source: string): void {
  const containers: (Set<string> | null)[] = [];
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "{") containers.push(new Set());
    else if (char === "[") containers.push(null);
    else if (char === "}" || char === "]") containers.pop();
    else if (char === '"') {
      const start = i++;
      while (i < source.length) {
        if (source[i] === "\\") i += 2;
        else if (source[i] === '"') break;
        else i++;
      }
      let next = i + 1;
      while (/\s/.test(source[next] ?? "") && next < source.length) next++;
      const keys = containers[containers.length - 1];
      if (source[next] === ":" && keys) {
        const key = JSON.parse(source.slice(start, i + 1)) as string;
        if (keys.has(key)) invalid();
        keys.add(key);
      }
    }
  }
}

/** Accept complete JSON (optionally one code fence), never salvage a prefix. */
export function parseSemanticPath(text: string, from: string, to: string): SemanticPath {
  let source = text.trim();
  if (!source || source.length > 32_768) invalid();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(source);
  if (fence) source = fence[1].trim();
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch {
    if (isUnterminatedJson(source)) throw new SemanticGenerationError("truncated", true);
    invalid();
  }
  rejectDuplicateKeys(source);
  let rows: unknown[] | undefined;
  let semantic: SemanticPath | undefined;
  if (Array.isArray(parsed)) rows = parsed;
  else {
    const obj = record(parsed);
    if (!obj) invalid();
    if (obj.refusal === true || (typeof obj.refusal === "string" && obj.refusal.trim())) {
      throw new SemanticGenerationError("refused", false);
    }
    const rowKey = ["steps", "path", "semantic_path"].find((key) => Array.isArray(obj[key]) && (obj[key] as unknown[]).some((entry) => record(entry)));
    if (rowKey) {
      if (!hasOnlyKeys(obj, [rowKey])) invalid();
      rows = obj[rowKey] as unknown[];
    } else {
      if (!hasOnlyKeys(obj, ["path", "anchors", "semantic_path", "entropy", "entropy_profile", "confidence", "confidence_profile"])) invalid();
      const anchors = oneAlias(obj, ["path", "anchors", "semantic_path"]);
      const entropy = oneAlias(obj, ["entropy", "entropy_profile"]);
      const confidence = oneAlias(obj, ["confidence", "confidence_profile"]);
      if (!Array.isArray(anchors) || !Array.isArray(entropy) || !Array.isArray(confidence)
        || anchors.length !== entropy.length || anchors.length !== confidence.length) invalid();
      semantic = { anchors: anchors.map(anchor), entropy: entropy.map(scalar), confidence: confidence.map(scalar) };
    }
  }
  if (rows) {
    semantic = { anchors: [], entropy: [], confidence: [] };
    for (const row of rows) {
      const obj = record(row);
      if (!obj || !hasOnlyKeys(obj, ["anchor", "entropy", "confidence"])) invalid();
      semantic.anchors.push(anchor(obj.anchor));
      semantic.entropy.push(scalar(obj.entropy));
      semantic.confidence.push(scalar(obj.confidence));
    }
  }
  if (!semantic || semantic.anchors.length < 2 || semantic.anchors.length > 64) invalid();
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  if (!same(semantic.anchors[0], from) || !same(semantic.anchors[semantic.anchors.length - 1], to)) invalid();
  // Only harmless case/whitespace normalization, never replace a wrong concept.
  semantic.anchors[0] = from;
  semantic.anchors[semantic.anchors.length - 1] = to;
  return semantic;
}

export function semanticContent(completion: unknown): string {
  const response = record(completion);
  const choices = response?.choices;
  const choice = Array.isArray(choices) ? record(choices[0]) : null;
  const message = record(choice?.message);
  return typeof message?.content === "string" ? message.content : "";
}

/** Check refusals/errors/truncation before trusting even syntactically valid JSON. */
export function semanticPathFromCompletion(completion: unknown, from: string, to: string): SemanticPath {
  const response = record(completion);
  if (response?.error) throw classifySemanticGenerationError(response);
  const choices = response?.choices;
  const choice = Array.isArray(choices) ? record(choices[0]) : null;
  if (choice?.error) throw classifySemanticGenerationError(choice);
  const message = record(choice?.message);
  if (choice?.finish_reason === "content_filter" || message?.refusal === true
    || (typeof message?.refusal === "string" && message.refusal.trim())) {
    throw new SemanticGenerationError("refused", false);
  }
  if (choice?.finish_reason === "length") throw new SemanticGenerationError("truncated", true);
  if (choice?.finish_reason === "error") throw new SemanticGenerationError("unavailable", true);
  if (choice?.finish_reason != null && choice.finish_reason !== "stop") invalid();
  return parseSemanticPath(semanticContent(completion), from, to);
}
