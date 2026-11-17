// Privacy layer. The UI only ever receives objects built from allow-listed
// fields (see runner.ts publicRecord). This module is the second layer: it
// scrubs any string that reaches the public record, and can scan a serialized
// object for anything that still looks sensitive.

const PATTERNS: [RegExp, string][] = [
  [/[A-Za-z0-9._%+-]+@(?!example\.(?:com|net|org)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/https?:\/\/[^\s"'<>]*(?:lambdatest\.com|testmuai\.com|testmu\.ai)[^\s"'<>]*/gi, '[link removed]'],
  [/[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\s"'<>]+/gi, '[local path]'],
  [/(?:\/Users|\/home)\/[^\s"'<>/]+[^\s"'<>]*/g, '[local path]'],
  [/[A-Za-z]:\\[^\s"'<>]+/g, '[local path]'],
  [/\b(?:org_id|project_id|testcase_id|folder_id|user_name|user_email|session_id|commit_id)\b["']?\s*[:=]\s*["']?[^\s"',}]+/gi, '[id removed]'],
  [/\b(?:access[_-]?key|api[_-]?key|token|bearer|authorization|password)\b["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi, '[secret removed]'],
];

export function scrub(value: string): string {
  let out = value;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Deep-scrub every string in a JSON-like value. */
export function scrubDeep<T>(value: T): T {
  if (typeof value === 'string') return scrub(value) as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v);
    return out as T;
  }
  return value;
}

const LEAK_CHECKS: [string, RegExp][] = [
  ['email', /[A-Za-z0-9._%+-]+@(?!example\.(?:com|net|org)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['share link', /(?:lambdatest\.com|testmuai\.com)\//i],
  ['local path', /[A-Za-z]:[\\/]+Users[\\/]|\/home\/|\/Users\//i],
  ['account id field', /\b(?:org_id|user_name|user_email|testcase_id|project_id|folder_id|session_dir|run_dir|test_url)\b/i],
];

/** Returns the names of any sensitive patterns found in the serialized value. */
export function findLeaks(value: unknown): string[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return LEAK_CHECKS.filter(([, re]) => re.test(text)).map(([name]) => name);
}
