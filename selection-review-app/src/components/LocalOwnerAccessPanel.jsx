import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { createLatestRead, createSubmitLock } from "../formState.js";
import { assertOwnerAccessDto, ownerAccessPasswordInput, TEAM_ROLE_LABELS } from "../ownerAccess.js";
import TeamAccountPanel from "./TeamAccountPanel.jsx";
import WorkstationPanel from "./WorkstationPanel.jsx";

// What this page's plugin said last: whether it answered, and which team computer's key it holds.
const NO_PLUGIN_ANSWER = Object.freeze({ answered: false, workstation: null });

/**
 * 已登录是常态，不必每一页头上都声明一遍：showAuthenticated 为假时这一条整条不显示（「退出登录」在「维护」里）。
 * 其余每一种状态 —— 还在读、读不出来、只是预览身份、要设密码、要登录 —— 都必须照旧显眼，因为那时主人确实要动手。
 * 团队账号（两位老板和测试各一个登录名）：登录要填登录名；登着时「维护」里写明是谁、什么角色，下面是改密码。
 */
export function LocalOwnerAccessView({ state, saving, password, repeatedPassword, loginName = "", inputError, showAuthenticated = false,
  thisComputer = NO_PLUGIN_ANSWER, onPasswordChange, onRepeatedPasswordChange, onLoginNameChange, onSubmit, onRefresh }) {
  if (state.status === "loading") return <section className="local-owner-access" aria-busy="true"><b>主人登录</b><span>正在读取登录状态…</span></section>;
  if (state.status === "failed") return <section className="local-owner-access">
    <b>主人登录状态未确认</b><p role="alert">{state.error}</p>
    <button type="button" className="button secondary" disabled={saving} onClick={onRefresh}>重新读取登录状态</button>
  </section>;
  const access = assertOwnerAccessDto(state.access);
  if (access.status === "development_only") return <section className="local-owner-access">
    <b>当前为预览身份</b><span>本服务尚未启用主人登录，不能保存正式生产授权。</span>
    <button type="button" className="button secondary" disabled={saving} onClick={onRefresh}>刷新登录状态</button>
  </section>;
  const team = access.providerType === "team_accounts";
  if (access.status === "authenticated") return showAuthenticated ? <>
    <section className="local-owner-access">
      {team ? <><b>已登录：{access.user.displayName}（{TEAM_ROLE_LABELS[access.user.role]}）</b>
        <span>{access.user.role === "boss" ? "商品确认仍以当前方案和服务端权限为准。" : "测试账号什么都能做，只有确认供货、确认利润和许可上架要老板来做。"}</span></>
        : <><b>主人已登录</b><span>商品确认仍以当前方案和服务端权限为准。</span></>}
      <button type="button" className="button secondary" disabled={saving} onClick={onSubmit}>{saving ? "正在退出…" : "退出登录"}</button>
    </section>
    {team ? <TeamAccountPanel user={access.user} onAccessChanged={onRefresh} /> : null}
    {team ? <WorkstationPanel thisComputer={thisComputer} onAccessChanged={onRefresh} /> : null}
  </> : null;
  if (team) return <section className="local-owner-access">
    <div><b>登录</b><p>用你自己的登录名和密码。账号由管服务器的人用命令行开，网页上开不了。</p></div>
    <form onSubmit={onSubmit}>
      <label>登录名<input required type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} value={loginName}
        disabled={saving} onChange={event => onLoginNameChange(event.target.value)} /></label>
      <label>密码<input required type="password" autoComplete="current-password" value={password} disabled={saving}
        onChange={event => onPasswordChange(event.target.value)} /></label>
      <button type="submit" className="button primary" disabled={saving || loginName.trim() === "" || password.length === 0}>
        {saving ? "正在验证…" : "登录"}
      </button>
      {inputError ? <p role="alert">{inputError}</p> : null}
    </form>
  </section>;
  const setup = access.status === "setup_required";
  return <section className="local-owner-access">
    <div><b>{setup ? "首次设置主人密码" : "主人登录"}</b><p>此处只验证主人身份，不确认商品、不创建作业，也不执行生产。</p></div>
    <form onSubmit={onSubmit}>
      {setup ? <p>请设置至少4个字符、最多1024字节的密码；空格会原样保留。</p> : null}
      <label>{setup ? "设置密码" : "主人密码"}<input required type="password" autoComplete={setup ? "new-password" : "current-password"}
        value={password} disabled={saving} onChange={event => onPasswordChange(event.target.value)} /></label>
      {setup ? <label>再次输入密码<input required type="password" autoComplete="new-password" value={repeatedPassword}
        disabled={saving} onChange={event => onRepeatedPasswordChange(event.target.value)} /></label> : null}
      <button type="submit" className="button primary" disabled={saving || password.length === 0 || setup && repeatedPassword.length === 0}>
        {saving ? "正在验证…" : setup ? "设置密码并登录" : "登录"}
      </button>
      {inputError ? <p role="alert">{inputError}</p> : null}
    </form>
  </section>;
}

export default function LocalOwnerAccessPanel({ onAccessResolved, onAccessUnknown, showAuthenticated = false, accessCheck = 0,
  thisComputer = NO_PLUGIN_ANSWER }) {
  const [state, setState] = useState({ status: "loading", access: null, error: "" });
  const [password, setPassword] = useState("");
  const [repeatedPassword, setRepeatedPassword] = useState("");
  const [loginName, setLoginName] = useState("");
  const [inputError, setInputError] = useState("");
  const [saving, setSaving] = useState(false);
  const read = useRef(createLatestRead());
  const mounted = useRef(false);
  const submitLock = useRef(createSubmitLock());
  const refresh = useCallback(async () => {
    setPassword(""); setRepeatedPassword(""); setInputError("");
    setState({ status: "loading", access: null, error: "" });
    onAccessUnknown();
    try {
      await read.current.run(async signal => {
        const access = assertOwnerAccessDto(await api.getOwnerAccess(signal));
        signal.throwIfAborted();
        await onAccessResolved(access, { signal });
        signal.throwIfAborted();
        return access;
      }, access => setState({ status: "loaded", access, error: "" }));
    } catch (error) {
      if (!mounted.current) return;
      onAccessUnknown();
      setState({ status: "failed", access: null, error: error.message });
    }
  }, [onAccessResolved, onAccessUnknown]);
  // accessCheck goes up when the page found the sign-in gone (a team session that ended elsewhere); read it again then.
  useEffect(() => {
    mounted.current = true;
    refresh();
    return () => { mounted.current = false; read.current.cancel(); };
  }, [refresh, accessCheck]);

  function submit(event) {
    event.preventDefault();
    return submitLock.current(async () => {
      if (state.status !== "loaded") return;
      const access = state.access;
      let input;
      if (access.status !== "authenticated") {
        try { input = ownerAccessPasswordInput({ access, password, repeatedPassword, loginName }); }
        catch (error) { setPassword(""); setRepeatedPassword(""); setInputError(error.message); return; }
      }
      setSaving(true); setInputError("");
      onAccessUnknown();
      try {
        await read.current.run(async signal => {
          const result = assertOwnerAccessDto(await (access.status === "authenticated" ? api.logoutOwnerAccess() :
            access.status === "setup_required" ? api.setupOwnerAccess(input) : api.loginOwnerAccess(input)));
          signal.throwIfAborted();
          if (result.providerType !== access.providerType || access.providerType === "development_default" ||
              result.status !== (access.status === "authenticated" ? "login_required" : "authenticated")) {
            throw new Error("登录操作回执与本次请求不一致，当前身份尚未确认。");
          }
          await onAccessResolved(result, { signal });
          signal.throwIfAborted();
          return result;
        }, result => setState({ status: "loaded", access: result, error: "" }));
      } catch (error) {
        if (!mounted.current) return;
        // A team sign-in the server turned down (wrong name or password, too many tries) changed nothing: nobody was signed
        // in before and nobody is now, so the form stays and says why.
        if (access.providerType === "team_accounts" && access.status === "login_required" && [400, 401, 429].includes(error.status)) {
          setInputError(error.message);
          return;
        }
        onAccessUnknown();
        setState({ status: "failed", access: null, error: error.message });
      } finally {
        if (mounted.current) { setPassword(""); setRepeatedPassword(""); setSaving(false); }
      }
    });
  }
  return <LocalOwnerAccessView state={state} saving={saving} password={password} repeatedPassword={repeatedPassword} loginName={loginName}
    inputError={inputError} showAuthenticated={showAuthenticated} thisComputer={thisComputer}
    onPasswordChange={setPassword} onRepeatedPasswordChange={setRepeatedPassword} onLoginNameChange={setLoginName}
    onSubmit={submit} onRefresh={refresh} />;
}
