/**
 * Starts one Ozon image search from the search bar on Ozon's home page, for 在 Ozon 找同款 (以图搜).
 *
 * Runs in the ISOLATED world and must stay self-contained: chrome.scripting serializes this function alone. It does the
 * one thing the owner does by hand: open the search bar's photo upload and give it the one picture the review app handed
 * this job (as base64 JPEG). The file goes in through the page's own file input, the way a dropped or chosen file does;
 * Ozon then uploads it and moves the tab to /search-by-image?image_id=…, which the background waits for and reads.
 * Nothing else on the page is clicked, and nothing is typed into the search box.
 *
 * Returns { status: "uploaded" } once the file is handed to the page, or a failure code. "image_upload_unavailable" means
 * the upload control was not found on this page; it never means Ozon has no same product.
 */
export async function uploadOzonSearchImage(pictureBase64, contentType) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const failed = (failureCode) => ({ status: "failed", failureCode });
  if (typeof pictureBase64 !== "string" || !pictureBase64 || contentType !== "image/jpeg") return failed("search_image_unavailable");
  const pageBlocker = () => {
    if (document.querySelector?.('[id="captcha"], [data-widget="captcha"], iframe[src*="captcha"], #challenge-form, .challenge-form')) {
      return "site_verification_required";
    }
    if (/antibot|Доступ ограничен|Access denied/i.test(String(document.title || ""))) return "site_verification_required";
    return null;
  };
  // The photo control is named for what it does; Ozon labels it in Russian, an English build may say "photo"/"image".
  const PHOTO_CONTROL = /фото|изображени|картинк|камер|photo|image|camera/i;
  const nameOf = (element) => [element.getAttribute?.("aria-label"), element.getAttribute?.("title"), element.getAttribute?.("alt"),
    element.getAttribute?.("data-testid"), element.textContent].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 200);
  const imageInput = () => Array.from(document.querySelectorAll?.('input[type="file"]') || [])
    .find((input) => !input.disabled && (!input.accept || /image|jpe?g|png|webp/i.test(input.accept))) || null;
  const searchBar = () => document.querySelector?.('[data-widget^="searchBar"]') ||
    document.querySelector?.('form[action*="/search"]') || null;
  const photoControl = () => {
    const bar = searchBar();
    if (!bar) return null;
    const controls = Array.from(bar.querySelectorAll?.('button, [role="button"], label') || []);
    return controls.find((control) => control.getAttribute?.("type") !== "submit" && PHOTO_CONTROL.test(nameOf(control))) || null;
  };

  // The page script draws the search bar after the document commits; wait for it within the job's own deadline.
  const startedAt = Date.now();
  let input = null;
  let opened = false;
  while (Date.now() - startedAt < 15000) {
    const blocker = pageBlocker();
    if (blocker) return failed(blocker);
    input = imageInput();
    if (input) break;
    if (!opened) {
      const control = photoControl();
      if (control) { control.click(); opened = true; }
    }
    await sleep(300);
  }
  if (!input) return failed("image_upload_unavailable");

  let file;
  try {
    const binary = atob(pictureBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    file = new File([bytes], "photo.jpg", { type: contentType });
  } catch { return failed("search_image_unavailable"); }
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return { status: "uploaded" };
}
