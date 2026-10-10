import FormRevisionNotice, { useCandidateForm, useSubmit } from './FormRevisionNotice.jsx';

const statusLabels = { queued: '读取授权已保存，等待执行', claimed: '账户核验进行中', waiting_platform: '账户核验进行中',
  completed: '三项账户资料已保存', failed: '本次账户核验已停止', unknown_outcome: '请求结果待核对' };
const methodLabels = { roles: '方法权限', seller_info: '公司币种', warehouse_list: '指定仓库' };

export default function OzonAccountReadCard({ preparation, onAuthorize, onContinue }) {
  const { saving, error, run } = useSubmit();
  const [form, setForm, guard] = useCandidateForm({ id: preparation.candidateId, dataRevision: preparation.expectedRevision },
    { bindingId: '', scopeRef: '', expiresAt: '', confirmed: false, idempotencyKey: `account-read:${crypto.randomUUID()}` });
  const selected = preparation.options.find(option => option.bindingId === form.bindingId && option.scopeRef === form.scopeRef);
  const current = preparation.runtime.find(value => value.isCurrent);
  const occupied = current && ['queued', 'claimed', 'waiting_platform', 'unknown_outcome', 'completed'].includes(current.status);
  const ready = selected && form.expiresAt && form.confirmed && !guard.conflict && !occupied && !saving && typeof onAuthorize === 'function';
  function update(fields) {
    setForm(value => ({ ...value, ...fields, confirmed: false, idempotencyKey: `account-read:${crypto.randomUUID()}` }));
  }
  function submit(event) {
    event.preventDefault();
    return run(async () => {
      guard.assertCurrent();
      if (!ready) throw new Error('请先核对当前账户、仓库和本次读取范围。');
      const expiresAt = new Date(form.expiresAt);
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) throw new Error('请选择有效的读取截止时间。');
      await onAuthorize({ candidateId: preparation.candidateId, skuPackageId: preparation.skuPackageId,
        expectedRevision: preparation.expectedRevision, bindingId: selected.bindingId, configurationVersion: selected.configurationVersion,
        scopeRef: selected.scopeRef, expiresAt: expiresAt.toISOString(), confirmReadOnce: true, idempotencyKey: form.idempotencyKey });
    });
  }
  return <section className="de-software-runtime-card" aria-label="Ozon账户只读核验">
    <header><h3>账户只读核验</h3></header>
    <p>{preparation.message}</p>
    {current ? <div role="status">
      <strong>{statusLabels[current.status]}</strong>
      {current.expired ? <p>本次读取许可已过期，不能继续发送请求。</p> : null}
      {current.admissionBlocker ? <p>已保存的读取许可或凭据绑定未通过当前校验，不能继续发送请求。</p> : null}
      <p>已发送读取请求：{current.requestsSent === 'unknown' ? '待核对' : `${current.requestsSent} 次`}。</p>
      {current.observedMethods.length ? <p>已取得：{current.observedMethods.map(method => methodLabels[method]).join('、')}。</p> : null}
      {current.companyCurrency ? <p>已读取的公司币种：{current.companyCurrency}。</p> : null}
      {current.gaps.length ? <ul>{current.gaps.map(gap => <li key={`${gap.code}:${gap.field}`}>{gap.message}</li>)}</ul> : null}
      {current.status === 'completed' ? <p>账户资料已保存；能否继续生产，以生产任务的当前校验结果为准。</p> : null}
      {current.status === 'failed' || current.status === 'unknown_outcome' ? <p>已保留取得的资料和请求状态，未自动重发。</p> : null}
      {current.canContinue ? <button type="button" disabled={saving || typeof onContinue !== 'function'} onClick={() => run(() =>
        onContinue({ candidateId: preparation.candidateId, jobId: current.jobId, expectedRevision: current.expectedRevision }))}>
        继续已授权的账户核验</button> : null}
    </div> : null}
    {preparation.options.length > 0 && !occupied ? <form onSubmit={submit}>
      <FormRevisionNotice guard={guard} disabled={saving} />
      <fieldset disabled={saving}>
        <label>本次核验账户与仓库<select required value={form.bindingId} onChange={event => {
          const option = preparation.options.find(value => value.bindingId === event.target.value);
          update({ bindingId: option ? option.bindingId : '', scopeRef: option ? option.scopeRef : '' });
        }}><option value="">请选择本次范围</option>{preparation.options.map(option =>
          <option key={option.bindingId} value={option.bindingId}>{option.storeName} · {option.warehouseName}</option>)}</select></label>
        {selected ? <p>账户编号：{selected.clientId} · 仓库编号：{selected.warehouseId} · 凭据别名：{selected.credentialAlias}</p> : null}
        <label>本次读取许可截止时间<input type="datetime-local" required value={form.expiresAt}
          onChange={event => update({ expiresAt: event.target.value })} /></label>
        <p>仅为本件商品读取方法权限、公司币种和指定仓库，各一次，合计最多三次；失败即停止。</p>
        <label><input type="checkbox" checked={form.confirmed} onChange={event => setForm(value => ({ ...value, confirmed: event.target.checked }))} />
          我确认以上账户和仓库，允许软件在截止时间前执行本次只读核验。</label>
      </fieldset>
      <button type="submit" disabled={!ready}>{saving ? '正在核验…' : current?.status === 'failed' ? '重新授权读取一次' : '授权读取一次'}</button>
    </form> : null}
    {error ? <p role="alert">{error}</p> : null}
    <small>此卡只授权账户读取。商品生产范围以已保存的生产确认卡为准。</small>
  </section>;
}
