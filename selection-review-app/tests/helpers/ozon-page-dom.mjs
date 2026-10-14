/**
 * 用真实抓下来的 outerHTML 搭一个只读 DOM，让 collector-ozon.js 在测试里看到的东西
 * 和它在 Chrome 里看到的一样：HTML 元素 tagName 大写、SVG 元素 tagName 保持小写、
 * 注释是 nodeType 8、空白文本节点照留、<img> 是空元素。
 *
 * 只实现采集器真正用到的那点 DOM 接口，其余一律抛错，免得将来某个样本悄悄走过去。
 * 页面 CSS 不在 dump 里，所以 getComputedStyle 由样本声明的"哪一个金额被划掉了"驱动。
 */

const HTML_VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"
]);

const collapse = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

function findTagEnd(html, start) {
  let quote = "";
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index;
  }
  throw new Error("OZON_FIXTURE_UNTERMINATED_TAG");
}

function readAttributes(body, nameLength) {
  const attributes = {};
  for (const match of body.slice(nameLength).matchAll(/([-A-Za-z0-9:_.]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

function createElement(rawName, attributes, foreign) {
  const element = {
    nodeType: 1,
    // In an HTML document only foreign (SVG) elements keep their lower-case name.
    tagName: foreign ? rawName : rawName.toUpperCase(),
    attributes,
    childNodes: [],
    shadowRoot: null,
    parentNode: null,
    parentElement: null,
    ownerDocument: null,
    getAttribute(name) {
      const key = String(name).toLowerCase();
      return key in element.attributes ? element.attributes[key] : null;
    }
  };
  Object.defineProperty(element, "children", {
    get: () => element.childNodes.filter((child) => child.nodeType === 1)
  });
  Object.defineProperty(element, "textContent", {
    get: () => element.childNodes.filter((child) => child.nodeType !== 8).map((child) => child.textContent).join("")
  });
  if (element.tagName === "IMG") {
    Object.defineProperty(element, "src", { get: () => element.getAttribute("src") || "" });
    element.currentSrc = "";
  }
  element.querySelectorAll = (selector) => queryAll(element, selector, false);
  element.querySelector = (selector) => queryAll(element, selector, true)[0] || null;
  return element;
}

/** Parses one widget's outerHTML into a single root element. */
export function parseWidgetHtml(html) {
  const holder = createElement("fixture-root", {}, false);
  const stack = [{ node: holder, foreign: false }];
  let cursor = 0;
  while (cursor < html.length) {
    const open = html.indexOf("<", cursor);
    if (open === -1) {
      appendText(stack, html.slice(cursor));
      break;
    }
    if (open > cursor) appendText(stack, html.slice(cursor, open));
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open);
      if (close === -1) throw new Error("OZON_FIXTURE_UNTERMINATED_COMMENT");
      append(stack, { nodeType: 8, textContent: html.slice(open + 4, close) });
      cursor = close + 3;
      continue;
    }
    const end = findTagEnd(html, open);
    const raw = html.slice(open + 1, end);
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim().toLowerCase();
      const depth = stack.findLastIndex((frame) => frame.node.nodeType === 1 && frame.node.tagName.toLowerCase() === name);
      if (depth <= 0) throw new Error(`OZON_FIXTURE_UNEXPECTED_CLOSE:${name}`);
      stack.length = depth;
      cursor = end + 1;
      continue;
    }
    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const name = (body.match(/^[A-Za-z][-A-Za-z0-9:]*/) || [""])[0];
    if (!name) throw new Error("OZON_FIXTURE_UNSUPPORTED_TAG");
    const foreign = stack[stack.length - 1].foreign || name.toLowerCase() === "svg";
    const element = createElement(name, readAttributes(body, name.length), foreign);
    append(stack, element);
    if (!selfClosing && !(!foreign && HTML_VOID_TAGS.has(name.toLowerCase()))) stack.push({ node: element, foreign });
    cursor = end + 1;
  }
  const roots = holder.childNodes.filter((child) => child.nodeType === 1);
  if (roots.length !== 1) throw new Error(`OZON_FIXTURE_SINGLE_ROOT_REQUIRED:${roots.length}`);
  const root = roots[0];
  root.parentNode = null;
  root.parentElement = null;
  return root;
}

function append(stack, node) {
  const parent = stack[stack.length - 1].node;
  node.parentNode = parent;
  node.parentElement = parent;
  parent.childNodes.push(node);
}

function appendText(stack, data) {
  if (!data) return;
  append(stack, { nodeType: 3, textContent: data });
}

function descendants(element) {
  const found = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      found.push(child);
      walk(child);
    }
  };
  walk(element);
  return found;
}

function matchesToken(element, token) {
  const shape = token.match(/^([A-Za-z][A-Za-z0-9-]*)?((?:\[[^\]]+\])*)$/);
  if (!shape || (!shape[1] && !shape[2])) throw new Error(`OZON_FIXTURE_UNSUPPORTED_SELECTOR:${token}`);
  if (shape[1] && element.tagName.toLowerCase() !== shape[1].toLowerCase()) return false;
  for (const clause of shape[2].match(/\[[^\]]+\]/g) || []) {
    const parsed = clause.match(/^\[([A-Za-z][-A-Za-z0-9_:.]*)(?:(\*?=)"([^"]*)")?\]$/);
    if (!parsed) throw new Error(`OZON_FIXTURE_UNSUPPORTED_SELECTOR:${clause}`);
    const value = element.getAttribute(parsed[1]);
    if (value === null) return false;
    if (parsed[2] === "=" && value !== parsed[3]) return false;
    if (parsed[2] === "*=" && !value.includes(parsed[3])) return false;
  }
  return true;
}

function matchesCompound(element, compound) {
  const tokens = compound.trim().split(/\s+/);
  if (!matchesToken(element, tokens[tokens.length - 1])) return false;
  let ancestor = element.parentElement;
  for (let index = tokens.length - 2; index >= 0; index -= 1) {
    while (ancestor && !matchesToken(ancestor, tokens[index])) ancestor = ancestor.parentElement;
    if (!ancestor) return false;
    ancestor = ancestor.parentElement;
  }
  return true;
}

function queryAll(scope, selector, firstOnly) {
  if (typeof selector !== "string" || !selector.trim()) throw new Error("OZON_FIXTURE_EMPTY_SELECTOR");
  const compounds = selector.split(",").map((part) => part.trim()).filter(Boolean);
  const matched = [];
  for (const element of scope.roots ? scope.roots.flatMap((root) => [root, ...descendants(root)]) : descendants(scope)) {
    if (!compounds.some((compound) => matchesCompound(element, compound))) continue;
    matched.push(element);
    if (firstOnly) break;
  }
  return matched;
}

/**
 * 装上一个只含给定组件的 Ozon 商品页。widgets 是 outerHTML 字符串。
 * lineThroughTexts 里的金额会被 getComputedStyle 报成 line-through。
 */
export function installOzonHtmlPage({ href, widgets, lineThroughTexts = [], pseudoStruckTexts = [] }) {
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  const roots = Object.values(widgets).map((html) => parseWidgetHtml(html));
  const struck = new Set(lineThroughTexts.map((value) => collapse(value)));
  // 真实页面（2026-09-14 实测）不用 text-decoration 画删除线，而是一个 ::after 细线盒子。
  // 这是线上失败而测试全绿的原因，所以样本按真实机制回放。
  const pseudoStruck = new Set(pseudoStruckTexts.map((value) => collapse(value)));
  const scope = { roots };
  const documentStub = {
    body: { innerText: "" },
    defaultView: null,
    querySelectorAll: (selector) => queryAll(scope, selector, false),
    querySelector: (selector) => queryAll(scope, selector, true)[0] || null
  };
  for (const root of roots) for (const element of [root, ...descendants(root)]) element.ownerDocument = documentStub;
  const windowStub = {
    location: { href },
    // The dump carries no CSS, so the strike-through the owner saw on the page is
    // replayed by amount instead of by a guessed build-hashed class name.
    getComputedStyle: (element, pseudo = null) => {
      if (!element || element.nodeType !== 1) throw new TypeError("OZON_FIXTURE_COMPUTED_STYLE_TARGET");
      if (pseudo) {
        const draws = pseudo === "::after" && pseudoStruck.has(collapse(element.textContent));
        // 实测值：content ""、背景取文字同色、高 0.994318px、宽 43.2528px、绝对定位压在行中间。
        return draws
          ? { content: '""', backgroundColor: "rgba(0, 26, 51, 0.6)", height: "0.994318px", width: "43.2528px",
              position: "absolute", top: "8.99858px" }
          : { content: "none", backgroundColor: "rgba(0, 0, 0, 0)", height: "auto", width: "auto",
              position: "static", top: "auto" };
      }
      const line = struck.has(collapse(element.textContent)) ? "line-through" : "none";
      return { textDecorationLine: line, textDecoration: `${line} solid rgb(0, 26, 52)` };
    }
  };
  documentStub.defaultView = windowStub;
  globalThis.window = windowStub;
  globalThis.document = documentStub;
  globalThis.fetch = async () => {
    throw new Error("collector must not reach the network");
  };
  return () => {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
  };
}
