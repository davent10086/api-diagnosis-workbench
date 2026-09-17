import type { Trace } from "./types";

const MASK = "[已遮蔽]";
const secretKey = /(authorization|cookie|password|passwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|credential|session)/i;
const inlinePatterns = [/(authorization\s*[:=]\s*)([^\s,;]+)/gi, /(bearer\s+)([A-Za-z0-9._-]+)/gi, /(sk-[A-Za-z0-9_-]{8,})/g, /([?&](?:api[-_]?key|token|access[-_]?token)=)([^&#\s]+)/gi, /(AIza[\w-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|-----BEGIN [A-Z ]+ KEY-----)/g];

export function redact(text:string) { return text.replace(inlinePatterns[0], (_match, prefix) => `${prefix}${MASK}`).replace(inlinePatterns[1], (_match, prefix) => `${prefix}${MASK}`).replace(inlinePatterns[2], MASK).replace(inlinePatterns[3], (_match, prefix) => `${prefix}${MASK}`).replace(inlinePatterns[4], MASK); }
export function hasSensitive(text:string) { return inlinePatterns.some((pattern) => { pattern.lastIndex=0; return pattern.test(text); }); }
export function redactValue(value:unknown):unknown { if (typeof value === "string") return redact(value); if (Array.isArray(value)) return value.map(redactValue); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, secretKey.test(key) ? MASK : redactValue(child)])); return value; }
export function redactTrace(trace:Trace):Trace { return redactValue(trace) as Trace; }
