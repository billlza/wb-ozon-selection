/**
 * 「维护」里的旧页面只能看，不能改（主人 2026-10-11 认可的那份改动清单）。商品自己的页面已经能做完从「做这件」到上架、
 * 回读的每一步，旧页面上的按钮再点下去就是第二条路。这里不动旧页面本身：整块放进一个禁用的 fieldset，里面每个按钮、
 * 输入框和下拉都点不动，链接和展开收起照常能用。
 */
export default function MaintenanceReadOnly({ children, onOpenProduct = null }) {
  return <div className="maint-readonly">
    <p className="maint-readonly-note" role="note">
      <span>这是以前的页面，只能看，不能改。{typeof onOpenProduct === "function" ? "" : "要处理商品，请从「进行中」或「需要你处理」打开它自己的页面。"}</span>
      {typeof onOpenProduct === "function"
        ? <button type="button" className="button secondary" onClick={onOpenProduct}>打开这件商品自己的页面</button> : null}
    </p>
    <fieldset className="maint-readonly-body" disabled>{children}</fieldset>
  </div>;
}
