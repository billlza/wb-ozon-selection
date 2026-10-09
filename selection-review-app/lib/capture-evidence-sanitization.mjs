// Capture DTO boundary: never coerce booleans, arrays or objects into facts.
export function captureNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : null;
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed <= Number.MAX_SAFE_INTEGER ? parsed : null;
}

export function captureText(value, limit = 500) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

export function cleanCaptureAttributes(value, limit = 120) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, limit).flatMap(([key, item]) => {
    const name = captureText(key, 120);
    const scalar = typeof item === "number" && Number.isFinite(item) ? String(item) : captureText(item);
    // Only scalar public product facts survive; no nested payloads or secret-bearing URLs.
    if (!name || !scalar || /^(?:__proto__|prototype|constructor)$/i.test(name) ||
        /(?:token|cookie|password|authorization|secret|api[_-]?key)/i.test(name) ||
        /[\u0000-\u001f\u007f]|https?:\/\/|(?:bearer\s+|(?:token|cookie|password|secret|api[_-]?key)\s*[:=])/i.test(scalar)) return [];
    return [[name, scalar]];
  }));
}

export function canonicalOzonImageUrl(value) {
  return canonicalCaptureImageUrl(value, host => host === "ir.ozone.ru");
}

export function canonicalSupplierImageUrl(value) {
  return canonicalCaptureImageUrl(value, host => host === "alicdn.com" || host.endsWith(".alicdn.com"));
}

// Pinduoduo serves product pictures from its own image hosts; nothing else on its pages counts as a product image.
export function canonicalPinduoduoImageUrl(value) {
  return canonicalCaptureImageUrl(value, host => host === "pddpic.com" || host.endsWith(".pddpic.com") ||
    host.endsWith(".yangkeduo.com"));
}

function canonicalCaptureImageUrl(value, allowedHost) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        !allowedHost(url.hostname)) return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}
