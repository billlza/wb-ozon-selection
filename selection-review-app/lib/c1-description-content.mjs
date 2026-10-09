const text = value => typeof value === "string" && value.trim().length > 0;
const normalized = value => value.normalize("NFKC").replace(/\s+/gu, " ").trim();

/** Select original saved text once; never rewrite or infer equivalent meanings. */
export function selectC1DescriptionParts(description, bulletPoints) {
  if (!text(description) || !Array.isArray(bulletPoints) || bulletPoints.some(value => !text(value))) {
    throw new Error("C1_DESCRIPTION_CONTENT_INVALID");
  }
  const parts = [{ source: "description", index: 0, text: description }];
  const body = new Set([description, ...description.split(/\n+|(?<=[.!?])\s+/u)].map(normalized));
  const retained = new Set();
  bulletPoints.forEach((value, index) => {
    const key = normalized(value);
    if (body.has(key) || retained.has(key)) return;
    retained.add(key);
    parts.push({ source: "bullet", index, text: value });
  });
  return parts;
}
