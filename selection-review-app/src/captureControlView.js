const textOf = value => (typeof value === "string" && value.trim() !== "" ? value.trim() : "");

/**
 * Whether a product's capture buttons can be pressed, and why not. Without team accounts one control covers the whole
 * service. With them (`scope: "this_computer"`) it covers only this computer, and `elsewhere` lists the products other
 * computers are reading, so the button can say who has this one.
 */
export function captureBlockFor(captureControl, candidateId) {
  const elsewhere = Array.isArray(captureControl?.elsewhere)
    ? captureControl.elsewhere.find(job => job?.candidateId === candidateId) ?? null : null;
  if (elsewhere) {
    const computer = textOf(elsewhere.computer);
    return { busy: true, label: `${computer ? `「${computer}」` : "另一台电脑"}正在采集这件商品`, button: "别的电脑正在采集这件" };
  }
  if (captureControl?.status !== "busy") return { busy: false, label: "", button: "" };
  const thisComputer = captureControl.scope === "this_computer";
  return { busy: true, label: textOf(captureControl.label), button: thisComputer ? "这台电脑正在采集" : "其他商品正在采集" };
}
