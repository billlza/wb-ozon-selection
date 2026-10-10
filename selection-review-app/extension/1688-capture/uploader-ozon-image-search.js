/**
 * Starts one Ozon image search from the search bar on Ozon's home page, for 在 Ozon 找同款 (以图搜).
 *
 * Runs in the ISOLATED world and must stay self-contained: chrome.scripting serializes this function alone. It does the
 * one thing the owner does by hand: open the search bar's photo upload and give it the one picture the review app handed
 * this job (as base64 JPEG). The file goes in through the page's own file input, the way a dropped or chosen file does;
 * Ozon then uploads it and moves the tab to /search-by-image?image_id=…, which the background waits for and reads.
 * Nothing else on the page is clicked, and nothing is typed into the search box.
 *
 * Ozon's desktop search bar (data-widget="searchBarDesktop") has no file input until the camera button is pressed, and
 * the camera button carries no name: it is the icon-only type="button" between the text box and the search button.
 * Other extensions in the owner's Chrome put their own file inputs on Ozon pages (a 1688 sourcing drawer does), so a file
 * input that was already on the page outside the search bar before the click is never used.
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
  // A photo control that is named for what it does wins; Ozon may label it later, in Russian or English.
  const PHOTO_CONTROL = /фото|изображени|картинк|камер|photo|image|camera/i;
  const nameOf = (element) => [element.getAttribute?.("aria-label"), element.getAttribute?.("title"), element.getAttribute?.("alt"),
    element.getAttribute?.("data-testid"), element.textContent].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 200);
  const typeOf = (element) => String(element.getAttribute?.("type") || "").toLowerCase();
  const follows = (first, second) => Boolean(first && second && (first.compareDocumentPosition?.(second) & 4));
  const within = (outer, inner) => Boolean(outer && inner && (outer === inner || outer.contains?.(inner)));
  const imageInputs = () => Array.from(document.querySelectorAll?.('input[type="file"]') || [])
    .filter((input) => !input.disabled && (!input.accept || /image|jpe?g|png|webp/i.test(input.accept)));
  const searchBar = () => document.querySelector?.('[data-widget="searchBarDesktop"]') ||
    document.querySelector?.('[data-widget^="searchBar"]') || document.querySelector?.('form[action*="/search"]') || null;
  const photoControl = (bar) => {
    const controls = Array.from(bar.querySelectorAll?.('button, [role="button"], label') || []).filter((control) => typeOf(control) !== "submit");
    const named = controls.find((control) => PHOTO_CONTROL.test(nameOf(control)));
    if (named) return named;
    const submit = bar.querySelector?.('button[type="submit"]');
    const box = bar.querySelector?.('input[type="text"], input[type="search"], input[name="text"]');
    const iconOnly = controls.filter((control) => String(control.tagName || "").toLowerCase() === "button" && typeOf(control) === "button" &&
      control.querySelector?.("svg") && (!submit || follows(control, submit)) && (!box || follows(box, control)));
    // The camera sits right before the search button; a clear-text button, when there is one, sits before the camera.
    return iconOnly.length ? iconOnly[iconOnly.length - 1] : null;
  };

  // The page script draws the search bar after the document commits; wait for it within the job's own deadline.
  const startedAt = Date.now();
  let bar = null;
  let control = null;
  let input = null;
  while (Date.now() - startedAt < 15000) {
    const blocker = pageBlocker();
    if (blocker) return failed(blocker);
    bar = searchBar();
    if (bar) {
      input = imageInputs().find((candidate) => within(bar, candidate)) || null;
      control = input ? null : photoControl(bar);
      if (input || control) break;
    }
    await sleep(300);
  }
  if (!input && !control) return failed("image_upload_unavailable");

  if (!input) {
    const foreign = new Set(imageInputs());
    control.click();
    const clickedAt = Date.now();
    while (Date.now() - clickedAt < 6000) {
      const blocker = pageBlocker();
      if (blocker) return failed(blocker);
      const fresh = imageInputs().filter((candidate) => !foreign.has(candidate));
      input = fresh.find((candidate) => within(bar, candidate)) || fresh[fresh.length - 1] || null;
      if (input) break;
      await sleep(250);
    }
    if (!input) return failed("image_upload_unavailable");
  }

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
