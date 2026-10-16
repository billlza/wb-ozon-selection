import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { createSubmitLock } from "../formState.js";
import { handWorkstationKeyToPlugin, workstationKeyMessage } from "../workstationKey.js";

const LIST_REFRESH_MS = 30000;

function seenAt(value) {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleString("zh-CN");
}

function presence(workstation) {
  if (workstation.online) return workstation.extensionVersion ? `在线 · 插件 v${workstation.extensionVersion}` : "在线";
  return workstation.lastSeenAt ? `不在线 · 最后一次 ${seenAt(workstation.lastSeenAt)}` : "不在线";
}

/**
 * 干活的电脑（只有团队账号才有）：装了插件、替大家读 1688、拼多多、Ozon 和 Seerfar 页面的那几台。每台有自己的一把钥匙，
 * 插件领作业、交结果都带着；哪台领的作业只能由哪台交回。登录的人坐在哪台电脑前，就在那台上把它加进来；谁都能移除一台，
 * 移除后它的钥匙马上作废。`thisComputer` 是本页插件说的：有没有回话、它拿着哪台电脑的钥匙。
 */
export function WorkstationView({ thisComputer, list, name, saving, message, confirmingId, addedHere = "",
  onNameChange, onAdd, onConfirmRemove, onCancelRemove, onRemove }) {
  const mineId = thisComputer.workstation?.workstationId || addedHere;
  const mine = list.workstations?.find(workstation => workstation.workstationId === mineId) ?? null;
  return <section className="local-owner-access workstation-panel">
    <div><b>干活的电脑</b><p>装了插件、替大家读 1688、拼多多、Ozon 和 Seerfar 页面的电脑。每台有自己的一把钥匙，插件领作业、交结果都带着；哪台领的作业只能由哪台交回。</p></div>
    {mine ? <p>这台电脑是「{mine.name}」，已经加进来了。</p>
      : !thisComputer.answered ? <p>这个页面里没有找到插件：这台电脑要先装好插件并启用，刷新页面后才能加进来。</p>
      : list.status !== "loaded" ? null
      : <form onSubmit={onAdd}>
        <label>给这台电脑起个名字<input required type="text" maxLength={40} placeholder="比如：老板甲的 MacBook" value={name} disabled={saving}
          onChange={event => onNameChange(event.target.value)} /></label>
        <button type="submit" className="button primary" disabled={saving || name.trim() === ""}>{saving ? "正在加…" : "把这台电脑加进来"}</button>
      </form>}
    {message ? <p role={message.type === "error" ? "alert" : "status"}>{message.text}</p> : null}
    {list.status === "loading" ? <p>正在读有哪几台电脑…</p> : null}
    {list.status === "failed" ? <p role="alert">{list.error}</p> : null}
    {list.status === "loaded" && list.workstations.length === 0 ? <p>还没有加进来的电脑。</p> : null}
    {list.status === "loaded" && list.workstations.length > 0 ? <ul className="workstation-list">
      {list.workstations.map(workstation => <li key={workstation.workstationId}>
        <span>{workstation.name}{workstation.workstationId === mine?.workstationId ? "（这台）" : ""}</span>
        <span>{presence(workstation)}</span>
        {confirmingId === workstation.workstationId ? <>
          <span>移除后它的钥匙马上作废，它正在做的作业也交不回来。</span>
          <button type="button" className="button secondary" disabled={saving} onClick={() => onRemove(workstation)}>确定移除</button>
          <button type="button" className="button secondary" disabled={saving} onClick={onCancelRemove}>不移除</button>
        </> : <button type="button" className="button secondary" disabled={saving}
          onClick={() => onConfirmRemove(workstation.workstationId)}>移除</button>}
      </li>)}
    </ul> : null}
  </section>;
}

export default function WorkstationPanel({ thisComputer, onAccessChanged }) {
  const [list, setList] = useState({ status: "loading", workstations: null, error: "" });
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [confirmingId, setConfirmingId] = useState("");
  // Until this page's plugin next says which computer it is, the one just added here counts as this one.
  const [addedHere, setAddedHere] = useState("");
  const lock = useRef(createSubmitLock());
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const reload = useCallback(async (signal) => {
    try {
      const result = await api.listWorkstations(signal);
      if (mounted.current && !signal?.aborted) setList({ status: "loaded", workstations: result.workstations, error: "" });
    } catch (error) {
      if (signal?.aborted || !mounted.current) return;
      setList(current => current.status === "loaded" ? current : { status: "failed", workstations: null, error: error.message });
      if (error.status === 401) await onAccessChanged();
    }
  }, [onAccessChanged]);
  useEffect(() => {
    const controller = new AbortController();
    reload(controller.signal);
    const timer = setInterval(() => reload(controller.signal), LIST_REFRESH_MS);
    return () => { controller.abort(); clearInterval(timer); };
  }, [reload]);

  function add(event) {
    event.preventDefault();
    return lock.current(async () => {
      setSaving(true); setMessage(null);
      try {
        const { workstation, key } = await api.addWorkstation({ name: name.trim() });
        const ack = await handWorkstationKeyToPlugin({ workstationId: workstation.workstationId, name: workstation.name, key });
        // A key no plugin took is taken back at once, so the list never shows a computer that cannot work.
        let withdrawn = false;
        if (!ack.accepted) withdrawn = await api.removeWorkstation({ workstationId: workstation.workstationId }).then(() => true, () => false);
        if (!mounted.current) return;
        if (ack.accepted) { setAddedHere(workstation.workstationId); setName(""); }
        setMessage({ type: ack.accepted ? "status" : "error", text: workstationKeyMessage(ack, workstation.name, { withdrawn }) });
      } catch (error) {
        if (mounted.current) setMessage({ type: "error", text: error.message });
        if (error.status === 401) await onAccessChanged();
      } finally {
        if (mounted.current) setSaving(false);
        await reload();
      }
    });
  }
  function remove(workstation) {
    return lock.current(async () => {
      setSaving(true); setMessage(null);
      try {
        await api.removeWorkstation({ workstationId: workstation.workstationId });
        if (mounted.current) setMessage({ type: "status", text: `「${workstation.name}」已经移除，它的钥匙不能再用了。` });
      } catch (error) {
        if (mounted.current) setMessage({ type: "error", text: error.message });
        if (error.status === 401) await onAccessChanged();
      } finally {
        if (mounted.current) { setSaving(false); setConfirmingId(""); }
        await reload();
      }
    });
  }
  return <WorkstationView thisComputer={thisComputer} list={list} name={name} saving={saving} message={message}
    confirmingId={confirmingId} addedHere={addedHere} onNameChange={value => { setName(value); setMessage(null); }} onAdd={add}
    onConfirmRemove={setConfirmingId} onCancelRemove={() => setConfirmingId("")} onRemove={remove} />;
}
