import { useCallback, useEffect, useRef, useState } from "react";
import {
  STORE_PROFILES_UNAVAILABLE_MESSAGE,
  storeProfileCards,
  storeProfileForm,
  storeProfileSaveError,
  storeProfileValues
} from "../storeProfileCardView.js";

function ProfileForm({ card, onSave, onCancel }) {
  const [form, setForm] = useState(() => storeProfileForm(card.profile));
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const inFlight = useRef(false);
  const field = name => ({ value: form[name], onChange: event => setForm(current => ({ ...current, [name]: event.target.value })) });

  async function submit(event) {
    event.preventDefault();
    if (inFlight.current) return;
    const { errors: found, values } = storeProfileValues(form);
    setErrors(found);
    if (values === null) return;
    inFlight.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({ store: card.store, baseVersion: card.version, values });
    } catch (error) {
      setSaveError(storeProfileSaveError(error));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <form className="store-profile-form" onSubmit={submit} aria-label={`改 ${card.title}`}>
      <label>店铺定位<input type="text" maxLength={200} {...field("positioning")} /></label>
      <label>主打类目（一行一条，层级用「 &gt; 」连）<textarea rows={4} {...field("categoryPaths")} /></label>
      <label>不做的类目（一行一条）<textarea rows={2} {...field("excludedCategoryPaths")} /></label>
      <div className="store-profile-form-row">
        <label>价格下限 ₽<input type="number" min="0" inputMode="decimal" {...field("priceMin")} /></label>
        <label>价格上限 ₽<input type="number" min="0" inputMode="decimal" {...field("priceMax")} /></label>
        <label>重量上限 kg<input type="number" min="0" step="0.01" inputMode="decimal" {...field("maxWeightKg")} /></label>
        <label>预售最多等（天）<input type="number" min="0" max="90" step="1" inputMode="numeric" {...field("presaleMaxDays")} /></label>
      </div>
      <span className="store-profile-note">价格和重量留空表示不限。保存后存成新版本，旧版本留着。</span>
      {errors.length > 0 ? <ul role="alert" className="intake-error">{errors.map(error => <li key={error}>{error}</li>)}</ul> : null}
      {saveError ? <p role="alert" className="intake-error">{saveError.message}</p> : null}
      <div className="store-profile-actions">
        <button type="submit" className="button primary" disabled={saving}>{saving ? "正在保存…" : "保存"}</button>
        <button type="button" className="button secondary" disabled={saving} onClick={() => onCancel(saveError?.conflict === true)}>
          {saveError?.conflict ? "重新读取" : "取消"}
        </button>
      </div>
    </form>
  );
}

/**
 * 每家店的店铺档案：主打类目、价格带、重量上限、预售最多等几天。Seerfar 自动选品和录入流水线都按它来挑和提醒。
 * 只在主人点「改」并保存时写；档案后台没上线时只说一句，不显示假的档案。
 */
export default function StoreProfileCards({ loadProfiles, saveProfile }) {
  const [state, setState] = useState({ response: null, error: null, unavailable: false });
  const [editing, setEditing] = useState(null);
  const [epoch, setEpoch] = useState(0);
  const reload = useCallback(() => setEpoch(value => value + 1), []);

  useEffect(() => {
    if (typeof loadProfiles !== "function") return undefined;
    const controller = new AbortController();
    loadProfiles(controller.signal)
      .then(response => { if (!controller.signal.aborted) setState({ response, error: null, unavailable: false }); })
      .catch(error => {
        if (!controller.signal.aborted) setState({ response: null, error: error?.message ?? String(error), unavailable: error?.status === 404 });
      });
    return () => controller.abort();
  }, [loadProfiles, epoch]);

  async function save(payload) {
    const response = await saveProfile(payload);
    setState({ response, error: null, unavailable: false });
    setEditing(null);
  }

  if (state.unavailable) return <p role="status" className="store-profile-note">{STORE_PROFILES_UNAVAILABLE_MESSAGE}</p>;
  if (state.error) {
    return <p role="alert" className="intake-error">读取店铺档案失败：{state.error}
      <button type="button" className="intake-link" onClick={reload}>再读一次</button></p>;
  }
  if (state.response === null) return <p role="status" className="store-profile-note">正在读取店铺档案…</p>;
  const cards = storeProfileCards(state.response);
  if (cards.length === 0) return <p className="store-profile-note">还没有店铺档案。</p>;

  return (
    <div className="store-profiles">
      {cards.map(card => (
        <div key={card.store} className="store-profile" data-testid="store-profile">
          <div className="store-profile-head">
            <strong>{card.title}</strong>
            {editing === card.store ? null
              : <button type="button" className="intake-link" onClick={() => setEditing(card.store)} aria-label={`改 ${card.title}`}>改</button>}
          </div>
          {editing === card.store
            ? <ProfileForm card={card} onSave={save}
              onCancel={stale => { setEditing(null); if (stale) reload(); }} />
            : <dl>
              <dt>店铺定位</dt><dd>{card.positioning}</dd>
              <dt>主打类目</dt><dd>{card.categoriesLine}</dd>
              {card.excludedLine ? <><dt>不做</dt><dd>{card.excludedLine}</dd></> : null}
              <dt>价格带</dt><dd>{card.priceLine}</dd>
              <dt>重量上限</dt><dd>{card.weightLine}</dd>
              <dt>预售最多等</dt><dd>{card.presaleLine}</dd>
            </dl>}
          <span className="store-profile-note">{card.sourceLine}{card.skipLine ? ` · ${card.skipLine}` : ""}</span>
        </div>
      ))}
      <p className="store-profile-note">你点「不做这件」时选的原因，也会记进那家店的店铺档案。</p>
    </div>
  );
}
