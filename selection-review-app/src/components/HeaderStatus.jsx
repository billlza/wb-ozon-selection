import { headerStatusIndicator } from "../headerStatusView.js";

/**
 * 顶栏右边那一个状态指示器：插件、商品采集控制、运行方式三条合成一条。
 * 都正常时只有一个圆点和「一切正常」；任何一条不正常就把它展开成一句人话，说清楚现在影响什么。
 * 三条各自的原话始终留在 title 里，收起来的只是正常状态，不是信息。
 */
export default function HeaderStatus({ extensionStatus = null, captureControl = null, runtimeArchitecture = null }) {
  const status = headerStatusIndicator({ extensionStatus, captureControl, runtimeArchitecture });
  return (
    <span className={`header-status ${status.tone}`} data-testid="header-status" title={status.detail} role="status">
      <i aria-hidden="true" />
      {status.ok
        ? <span className="header-status-line">{status.label}</span>
        : <span className="header-status-lines">
          {status.issues.map(issue => <span key={`${issue.source}:${issue.code}`} className="header-status-line">{issue.sentence}</span>)}
        </span>}
    </span>
  );
}
