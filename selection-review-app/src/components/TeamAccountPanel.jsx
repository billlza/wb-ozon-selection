import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { createSubmitLock } from "../formState.js";
import { TEAM_PASSWORD_MIN_CHARACTERS, TEAM_ROLE_LABELS, teamNewPasswordInput } from "../ownerAccess.js";

/**
 * 团队账号的密码：每个人都能改自己的（要先填现在的密码）；老板还能给另一位老板或测试的人重设密码。
 * 建账号、停用账号只在命令行做，这里没有。
 */
export function TeamAccountView({ user, own, reset, accounts, onOwnChange, onOwnSubmit, onResetChange, onResetSubmit }) {
  const boss = user.role === "boss";
  return <section className="local-owner-access team-account-panel">
    <div><b>改我的密码</b><p>新密码至少{TEAM_PASSWORD_MIN_CHARACTERS}个字符。改完以后，你在别的地方登着的都会退出，这里继续登着。</p></div>
    <form onSubmit={onOwnSubmit}>
      <label>现在的密码<input required type="password" autoComplete="current-password" value={own.currentPassword} disabled={own.saving}
        onChange={event => onOwnChange({ currentPassword: event.target.value })} /></label>
      <label>新密码<input required type="password" autoComplete="new-password" value={own.newPassword} disabled={own.saving}
        onChange={event => onOwnChange({ newPassword: event.target.value })} /></label>
      <label>再输一遍新密码<input required type="password" autoComplete="new-password" value={own.repeatedPassword} disabled={own.saving}
        onChange={event => onOwnChange({ repeatedPassword: event.target.value })} /></label>
      <button type="submit" className="button primary" disabled={own.saving}>{own.saving ? "正在改…" : "改密码"}</button>
      {own.message ? <p role={own.message.type === "error" ? "alert" : "status"}>{own.message.text}</p> : null}
    </form>
    {boss ? <>
      <div><b>给别人重设密码</b><p>重设以后，那个人在各处登着的都会退出，要用新密码重新登录。新密码请当面或电话告诉他。</p></div>
      {accounts.status === "failed" ? <p role="alert">{accounts.error}</p> : null}
      <form onSubmit={onResetSubmit}>
        <label>账号<select value={reset.userId} disabled={reset.saving || accounts.status !== "loaded"}
          onChange={event => onResetChange({ userId: event.target.value })}>
          <option value="">{accounts.status === "loading" ? "正在读账号…" : "选一个账号"}</option>
          {(accounts.list ?? []).map(account => <option key={account.userId} value={account.userId}>
            {account.displayName}（{account.loginName}，{TEAM_ROLE_LABELS[account.role]}{account.status === "disabled" ? "，已停用" : ""}）
          </option>)}
        </select></label>
        <label>新密码<input required type="password" autoComplete="new-password" value={reset.newPassword} disabled={reset.saving}
          onChange={event => onResetChange({ newPassword: event.target.value })} /></label>
        <label>再输一遍新密码<input required type="password" autoComplete="new-password" value={reset.repeatedPassword} disabled={reset.saving}
          onChange={event => onResetChange({ repeatedPassword: event.target.value })} /></label>
        <button type="submit" className="button secondary" disabled={reset.saving || !reset.userId}>{reset.saving ? "正在重设…" : "重设密码"}</button>
        {reset.message ? <p role={reset.message.type === "error" ? "alert" : "status"}>{reset.message.text}</p> : null}
      </form>
    </> : null}
  </section>;
}

const emptyOwn = { currentPassword: "", newPassword: "", repeatedPassword: "", saving: false, message: null };
const emptyReset = { userId: "", newPassword: "", repeatedPassword: "", saving: false, message: null };

export default function TeamAccountPanel({ user, onAccessChanged }) {
  const [own, setOwn] = useState(emptyOwn);
  const [reset, setReset] = useState(emptyReset);
  const [accounts, setAccounts] = useState({ status: "loading", list: null, error: "" });
  const lock = useRef(createSubmitLock());
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    if (user.role !== "boss") return undefined;
    const controller = new AbortController();
    api.listTeamAccounts(controller.signal)
      .then(result => setAccounts({ status: "loaded", list: result.accounts.filter(account => account.userId !== user.userId), error: "" }))
      .catch(error => { if (!controller.signal.aborted) setAccounts({ status: "failed", list: null, error: error.message }); });
    return () => controller.abort();
  }, [user.role, user.userId]);

  function submitOwn(event) {
    event.preventDefault();
    return lock.current(async () => {
      let newPassword;
      try { newPassword = teamNewPasswordInput({ newPassword: own.newPassword, repeatedPassword: own.repeatedPassword }); }
      catch (error) { setOwn(current => ({ ...current, newPassword: "", repeatedPassword: "", message: { type: "error", text: error.message } })); return; }
      setOwn(current => ({ ...current, saving: true, message: null }));
      try {
        await api.changeOwnPassword({ currentPassword: own.currentPassword, newPassword });
        if (mounted.current) setOwn({ ...emptyOwn, message: { type: "status", text: "密码已改好。" } });
      } catch (error) {
        if (mounted.current) setOwn({ ...emptyOwn, message: { type: "error", text: error.message } });
        // A 401 means this session is gone; read the sign-in state again.
        if (error.status === 401) await onAccessChanged();
      }
    });
  }
  function submitReset(event) {
    event.preventDefault();
    return lock.current(async () => {
      let newPassword;
      try { newPassword = teamNewPasswordInput({ newPassword: reset.newPassword, repeatedPassword: reset.repeatedPassword }); }
      catch (error) { setReset(current => ({ ...current, newPassword: "", repeatedPassword: "", message: { type: "error", text: error.message } })); return; }
      const target = accounts.list?.find(account => account.userId === reset.userId);
      setReset(current => ({ ...current, saving: true, message: null }));
      try {
        await api.resetTeamPassword({ userId: reset.userId, newPassword });
        if (mounted.current) setReset({ ...emptyReset, message: { type: "status", text: `已给${target?.displayName ?? "这个账号"}重设密码。` } });
      } catch (error) {
        if (mounted.current) setReset(current => ({ ...current, newPassword: "", repeatedPassword: "", saving: false, message: { type: "error", text: error.message } }));
        if (error.status === 401) await onAccessChanged();
      }
    });
  }
  return <TeamAccountView user={user} own={own} reset={reset} accounts={accounts}
    onOwnChange={change => setOwn(current => ({ ...current, ...change, message: null }))} onOwnSubmit={submitOwn}
    onResetChange={change => setReset(current => ({ ...current, ...change, message: null }))} onResetSubmit={submitReset} />;
}
