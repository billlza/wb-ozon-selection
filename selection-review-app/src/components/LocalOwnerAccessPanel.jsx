import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { createLatestRead, createSubmitLock } from "../formState.js";
import { assertOwnerAccessDto, ownerAccessPasswordInput } from "../ownerAccess.js";

/**
 * 已登录是常态，不必每一页头上都声明一遍：showAuthenticated 为假时这一条整条不显示（「退出登录」在「维护」里）。
 * 其余每一种状态 —— 还在读、读不出来、只是预览身份、要设密码、要登录 —— 都必须照旧显眼，因为那时主人确实要动手。
 */
export function LocalOwnerAccessView({ state, saving, password, repeatedPassword, inputError, showAuthenticated = false,
  onPasswordChange, onRepeatedPasswordChange, onSubmit, onRefresh }) {
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
  if (access.status === "authenticated") return showAuthenticated ? <section className="local-owner-access">
    <b>主人已登录</b><span>商品确认仍以当前方案和服务端权限为准。</span>
    <button type="button" className="button secondary" disabled={saving} onClick={onSubmit}>{saving ? "正在退出…" : "退出登录"}</button>
  </section> : null;
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

export default function LocalOwnerAccessPanel({ onAccessResolved, onAccessUnknown, showAuthenticated = false }) {
  const [state, setState] = useState({ status: "loading", access: null, error: "" });
  const [password, setPassword] = useState("");
  const [repeatedPassword, setRepeatedPassword] = useState("");
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
  useEffect(() => {
    mounted.current = true;
    refresh();
    return () => { mounted.current = false; read.current.cancel(); };
  }, [refresh]);

  function submit(event) {
    event.preventDefault();
    return submitLock.current(async () => {
      if (state.status !== "loaded") return;
      const access = state.access;
      let input;
      if (access.status !== "authenticated") {
        try { input = ownerAccessPasswordInput({ access, password, repeatedPassword }); }
        catch (error) { setPassword(""); setRepeatedPassword(""); setInputError(error.message); return; }
      }
      setSaving(true); setInputError("");
      onAccessUnknown();
      try {
        await read.current.run(async signal => {
          const result = assertOwnerAccessDto(await (access.status === "authenticated" ? api.logoutOwnerAccess() :
            access.status === "setup_required" ? api.setupOwnerAccess(input) : api.loginOwnerAccess(input)));
          signal.throwIfAborted();
          if (result.providerType !== "local_owner_password" || result.status !== (access.status === "authenticated" ? "login_required" : "authenticated")) {
            throw new Error("登录操作回执与本次请求不一致，当前身份尚未确认。");
          }
          await onAccessResolved(result, { signal });
          signal.throwIfAborted();
          return result;
        }, result => setState({ status: "loaded", access: result, error: "" }));
      } catch (error) {
        if (!mounted.current) return;
        onAccessUnknown();
        setState({ status: "failed", access: null, error: error.message });
      } finally {
        if (mounted.current) { setPassword(""); setRepeatedPassword(""); setSaving(false); }
      }
    });
  }
  return <LocalOwnerAccessView state={state} saving={saving} password={password} repeatedPassword={repeatedPassword} inputError={inputError}
    showAuthenticated={showAuthenticated}
    onPasswordChange={setPassword} onRepeatedPasswordChange={setRepeatedPassword} onSubmit={submit} onRefresh={refresh} />;
}
