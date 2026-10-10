import { createPreparationSaveState } from '../../src/siblingPreparationState.js';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from '../../src/api.js';
import SiblingBatchPreparation from '../../src/components/SiblingBatchPreparation.jsx';
import '../../src/styles.css';

const password = 'synthetic password for bounded saved DE HTTP tests';

function BrowserFixture() {
  const [preparationSaveState]=useState(createPreparationSaveState);
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function refresh() {
    const document = await api.getState();
    setState(document);
    return document;
  }
  useEffect(() => { refresh().catch(cause => setError(cause.message)); }, []);
  async function login() {
    setError(''); setSaving(true);
    try {
      const access = await api.getOwnerAccess();
      if (access?.status === 'setup_required') await api.setupOwnerAccess({ password });
      else await api.loginOwnerAccess({ password });
      await refresh();
    } catch (cause) { setError(cause.message); }
    finally { setSaving(false); }
  }
  const parent = state?.candidates?.find(candidate => candidate.id === 'candidate:synthetic-parent');
  const siblings = state?.candidates?.filter(candidate => candidate.siblingSourceV1?.parentCandidateId === parent?.id) ?? [];
  return <main className="page-panel" style={{ maxWidth: 1320, margin: '24px auto', padding: 16 }}>
    <h1>合成三色 C1 持久预览与确认</h1>
    <p>所有状态由隔离测试 API 保存；刷新页面会重新读取持久合成记录。</p>
    <button type="button" disabled={saving} onClick={login}>登录合成主人身份</button>
    <button type="button" disabled={saving} onClick={() => refresh().catch(cause => setError(cause.message))}>刷新保存状态</button>
    {parent ? <p id="saved-c1-count">已保存 C2 规格：{siblings.filter(child => child.lifecycleV11?.skuPackage?.businessPhase === 'C2').length}</p> : null}
    {parent ? <SiblingBatchPreparation preparationSaveState={preparationSaveState} parent={parent} siblings={siblings}
      onPreviewC1={payload => api.previewSiblingBatchC1(parent.id, payload)}
      onConfirmC1={async payload => { const result = await api.confirmSiblingBatchC1(parent.id, payload); await refresh(); return result; }} /> : null}
    {error ? <p role="alert">{error}</p> : null}
  </main>;
}

createRoot(document.getElementById('root')).render(<BrowserFixture />);
