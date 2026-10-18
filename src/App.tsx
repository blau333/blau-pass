import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useState } from "react";
import logo from "./assets/logo.png";

type EntryKind = "password" | "ssh_key" | "api_token";
type Category = "all" | EntryKind | "totp";
type SharedEntry = {
  name: string;
  username: string;
  password: string;
  url: string;
};
type GoogleShareConfig = {
  scriptUrl: string;
  accessToken: string;
  spreadsheetUrl: string;
  shareKey: string;
};

type EntrySummary = {
  name: string;
  icon: string;
  username: string;
  url: string;
  kind: EntryKind;
  hasPassword: boolean;
  hasTotp: boolean;
  hasApiToken: boolean;
  hasSshPrivateKey: boolean;
};

type EntryDetails = {
  name: string;
  icon: string;
  kind: EntryKind;
  username: string;
  password: string;
  url: string;
  notes: string;
  apiToken: string;
  sshPrivateKey: string;
  code: string | null;
  secondsRemaining: number | null;
};

type EntryDraft = {
  name: string;
  icon: string;
  kind: EntryKind;
  username: string;
  password: string;
  url: string;
  notes: string;
  totpSecret: string;
  removeTotp: boolean;
  apiToken: string;
  sshPrivateKey: string;
};

const categories: { id: Category; label: string }[] = [
  { id: "all", label: "Все данные" },
  { id: "password", label: "Пароли от сайтов" },
  { id: "ssh_key", label: "Ключи для серверов" },
  { id: "api_token", label: "Ключи доступа к API" },
  { id: "totp", label: "Коды подтверждения" },
];

const entryIcons = [
  { value: "🌐", label: "Интернет" },
  { value: "🔐", label: "Защита" },
  { value: "🔑", label: "Ключ" },
  { value: "🐙", label: "GitHub" },
  { value: "💼", label: "Работа" },
  { value: "📧", label: "Почта" },
  { value: "☁️", label: "Облако" },
  { value: "🏦", label: "Финансы" },
  { value: "🎮", label: "Игры" },
  { value: "🛒", label: "Покупки" },
  { value: "🖥️", label: "Компьютер" },
  { value: "📱", label: "Телефон" },
];

const emptyDraft = (): EntryDraft => ({
  name: "",
  icon: "",
  kind: "password",
  username: "",
  password: "",
  url: "",
  notes: "",
  totpSecret: "",
  removeTotp: false,
  apiToken: "",
  sshPrivateKey: "",
});

function categoryFor(kind: EntryKind): string {
  if (kind === "ssh_key") return "Закрытый ключ для сервера";
  if (kind === "api_token") return "Ключ доступа к API";
  return "Пароль от сайта";
}

function defaultEntryIcon(kind: EntryKind): string {
  if (kind === "ssh_key") return "🔐";
  if (kind === "api_token") return "🔑";
  return "🌐";
}

function App() {
  const [hasVault, setHasVault] = useState<boolean | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [entries, setEntries] = useState<EntrySummary[]>([]);
  const [selectedName, setSelectedName] = useState("");
  const [details, setDetails] = useState<EntryDetails | null>(null);
  const [category, setCategory] = useState<Category>("all");
  const [search, setSearch] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");
  const [editing, setEditing] = useState(false);
  const [originalName, setOriginalName] = useState<string | null>(null);
  const [draft, setDraft] = useState<EntryDraft>(emptyDraft);
  const [showPassword, setShowPassword] = useState(false);
  const [importPath, setImportPath] = useState("");
  const [importPassword, setImportPassword] = useState("");
  const [confirmImport, setConfirmImport] = useState(false);
  const [notice, setNotice] = useState("");
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareSelection, setShareSelection] = useState<string[]>([]);
  const [shareScriptUrl, setShareScriptUrl] = useState("");
  const [shareAccessToken, setShareAccessToken] = useState("");
  const [shareSheetUrl, setShareSheetUrl] = useState("");
  const [shareKeyInput, setShareKeyInput] = useState("");
  const [receivedShare, setReceivedShare] = useState<SharedEntry[] | null>(null);
  const [shareError, setShareError] = useState("");
  const [shareNotice, setShareNotice] = useState("");
  const [shareBusy, setShareBusy] = useState(false);

  function closeShareDialog() {
    setShareDialogOpen(false);
    setShareSelection([]);
    setReceivedShare(null);
    setShareError("");
    setShareNotice("");
    setShareScriptUrl("");
    setShareAccessToken("");
    setShareSheetUrl("");
    setShareKeyInput("");
  }

  async function openShareDialog() {
    setShareSelection([]);
    setReceivedShare(null);
    setShareError("");
    setShareNotice("");
    setShareDialogOpen(true);
    try {
      const config = await invoke<GoogleShareConfig | null>("get_google_share_config");
      if (config) {
        setShareScriptUrl(config.scriptUrl);
        setShareAccessToken(config.accessToken);
        setShareSheetUrl(config.spreadsheetUrl);
        setShareKeyInput(config.shareKey);
      } else {
        setShareScriptUrl("");
        setShareAccessToken("");
        setShareSheetUrl("");
        const key = await invoke<string>("create_google_share_key");
        setShareKeyInput(key);
      }
    } catch (err) {
      setShareError(String(err));
    }
  }

  async function saveGoogleShareConfig() {
    await invoke("save_google_share_config", {
      scriptUrl: shareScriptUrl.trim(),
      accessToken: shareAccessToken.trim(),
      spreadsheetUrl: shareSheetUrl.trim(),
      shareKey: shareKeyInput.trim(),
    });
  }

  async function publishToGoogleSheet() {
    setShareError("");
    setShareBusy(true);
    try {
      await saveGoogleShareConfig();
      const count = await invoke<number>("sync_google_sheet", { names: shareSelection });
      setShareNotice(`Таблица обновлена. Общих записей: ${count}.`);
    } catch (err) {
      setShareError(String(err));
    } finally {
      setShareBusy(false);
    }
  }

  async function readFromGoogleSheet() {
    setShareError("");
    setReceivedShare(null);
    setShareBusy(true);
    try {
      await saveGoogleShareConfig();
      const packageValue = await invoke<string>("google_sheet_exchange", { action: "read" });
      if (!packageValue) {
        throw new Error("В таблице пока нет пакета. Сначала опубликуйте записи.");
      }
      const result = await invoke<SharedEntry[]>("decrypt_share_package", {
        package: packageValue,
        key: shareKeyInput,
      });
      setReceivedShare(result);
    } catch (err) {
      setShareError(String(err));
    } finally {
      setShareBusy(false);
    }
  }

  async function generateBridgeToken() {
    setShareError("");
    try {
      setShareAccessToken(await invoke<string>("create_google_share_key"));
    } catch (err) {
      setShareError(String(err));
    }
  }

  async function copyShareValue(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setShareNotice("Ключ скопирован. Передайте его участникам отдельно от таблицы.");
      window.setTimeout(() => setShareNotice(""), 3500);
    } catch (err) {
      setShareError(`Не удалось скопировать: ${String(err)}`);
    }
  }

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<EntrySummary[]>("list_entries");
      setEntries(result);
      setSelectedName((current) =>
        result.some((entry) => entry.name === current) ? current : result[0]?.name ?? "",
      );
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    invoke<boolean>("vault_exists")
      .then(setHasVault)
      .catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    if (unlocked) void refresh();
  }, [unlocked, refresh]);

  useEffect(() => {
    if (!unlocked || !selectedName || editing) {
      setDetails(null);
      return;
    }
    const selectedEntry = entries.find((entry) => entry.name === selectedName);
    let cancelled = false;
    const load = async () => {
      try {
        const result = await invoke<EntryDetails>("get_entry", { name: selectedName });
        if (!cancelled) setDetails(result);
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    };
    void load();
    if (!selectedEntry?.hasTotp) {
      return () => {
        cancelled = true;
      };
    }
    const timer = window.setInterval(() => void load(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [unlocked, selectedName, editing, entries]);

  const filteredEntries = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return entries.filter((entry) => {
      const matchesCategory = (() => {
        if (category === "all") return true;
        if (category === "totp") return entry.hasTotp;
        return category === entry.kind;
      })();
      const matchesSearch =
        !query ||
        entry.name.toLocaleLowerCase().includes(query) ||
        entry.username.toLocaleLowerCase().includes(query) ||
        entry.url.toLocaleLowerCase().includes(query);
      return matchesCategory && matchesSearch;
    });
  }, [category, entries, search]);

  const counts = useMemo(
    () => ({
      all: entries.length,
      password: entries.filter((entry) => entry.kind === "password").length,
      ssh_key: entries.filter((entry) => entry.kind === "ssh_key").length,
      api_token: entries.filter((entry) => entry.kind === "api_token").length,
      totp: entries.filter((entry) => entry.hasTotp).length,
    }),
    [entries],
  );

  useEffect(() => {
    if (!filteredEntries.some((entry) => entry.name === selectedName)) {
      setSelectedName(filteredEntries[0]?.name ?? "");
    }
  }, [filteredEntries, selectedName]);

  async function submitPassword(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await invoke(hasVault ? "unlock" : "initialize", { password });
      setPassword("");
      setHasVault(true);
      setUnlocked(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function lockVault() {
    try {
      await invoke("lock");
      setUnlocked(false);
      setEntries([]);
      setSelectedName("");
      setDetails(null);
      setHasVault(true);
    } catch (err) {
      setError(String(err));
    }
  }

  async function exportVault() {
    setError("");
    setNotice("");
    try {
      const destination = await save({
        title: "Экспорт зашифрованной копии",
        defaultPath: "blau-backup.rsv",
        filters: [{ name: "Зашифрованное хранилище Blau", extensions: ["rsv"] }],
      });
      if (!destination) return;
      await invoke("export_vault", { destination });
      setNotice("Зашифрованная копия сохранена.");
    } catch (err) {
      setError(String(err));
    }
  }

  async function chooseImportFile() {
    setError("");
    setNotice("");
    try {
      const selected = await open({
        title: "Выберите копию хранилища Blau",
        multiple: false,
        directory: false,
        filters: [{ name: "Зашифрованное хранилище Blau", extensions: ["rsv"] }],
      });
      if (typeof selected !== "string") return;
      setImportPath(selected);
      setImportPassword("");
      setConfirmImport(false);
    } catch (err) {
      setError(String(err));
    }
  }

  async function importVault(event: React.FormEvent) {
    event.preventDefault();
    if (!confirmImport || !importPath) return;
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await invoke("import_vault", { source: importPath, password: importPassword });
      setImportPath("");
      setImportPassword("");
      setConfirmImport(false);
      setEditing(false);
      setNotice("Хранилище импортировано. Текущие записи заменены; мастер-пароль Blau сохранён.");
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  function startNewEntry() {
    setOriginalName(null);
    setDraft(emptyDraft());
    setShowPassword(false);
    setError("");
    setEditing(true);
  }

  function startEditing() {
    if (!details) return;
    setOriginalName(details.name);
    setDraft({
      name: details.name,
      icon: details.icon,
      kind: details.kind,
      username: details.username,
      password: details.password,
      url: details.url,
      notes: details.notes,
      totpSecret: "",
      removeTotp: false,
      apiToken: details.apiToken,
      sshPrivateKey: details.sshPrivateKey,
    });
    setShowPassword(false);
    setError("");
    setEditing(true);
  }

  async function submitEntry(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await invoke("save_entry", {
        input: {
          originalName,
          ...draft,
        },
      });
      setSelectedName(draft.name.trim());
      setEditing(false);
      setOriginalName(null);
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeEntry() {
    if (!details || !window.confirm(`Удалить запись «${details.name}»?`)) return;
    setError("");
    try {
      await invoke("remove_entry", { name: details.name });
      setDetails(null);
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  async function copyValue(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied(""), 1400);
    } catch (err) {
      setError(`Не удалось скопировать: ${String(err)}`);
    }
  }

  const originalHasTotp = originalName
    ? entries.find((entry) => entry.name === originalName)?.hasTotp ?? false
    : false;

  if (hasVault === null) {
    return error
      ? <main className="center"><p className="error">{error}</p></main>
      : <main className="center"><span className="spinner" />Загрузка…</main>;
  }

  if (!unlocked) {
    return (
      <main className="auth-screen">
        <section className="auth-panel">
          <div className="auth-brand">
            <img className="brand-mark" src={logo} alt="Логотип blau" />
            <h1>blau</h1>
          </div>
          <p className="auth-copy">
            {hasVault
              ? "Введите мастер-пароль, чтобы расшифровать хранилище."
              : "Создайте мастер-пароль для нового зашифрованного хранилища."}
          </p>
          <form onSubmit={submitPassword} className="auth-form">
            <label htmlFor="master-password">Главный пароль для разблокировки хранилища</label>
            <input
              id="master-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={hasVault ? undefined : 12}
              required
            />
            <button className="primary auth-submit" disabled={busy}>
              {busy ? "Подождите…" : hasVault ? "Разблокировать" : "Создать хранилище"}
            </button>
          </form>
          {error && <p className="error">{error}</p>}
          <p className="auth-footnote">
            Хранилище — один зашифрованный файл на этом устройстве. Мастер-пароль нигде не сохраняется.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="vault-window">
      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-brand"><img className="brand-mark sidebar-mark" src={logo} alt="" /><strong>blau</strong></div>
          <nav aria-label="Категории">
            {categories.map((item) => (
              <button
                key={item.id}
                className={`nav-item ${category === item.id ? "active" : ""}`}
                onClick={() => setCategory(item.id)}
              >
                <span>{item.label}</span><span className="nav-count">{counts[item.id]}</span>
              </button>
            ))}
          </nav>
          <button className="new-entry" onClick={startNewEntry}><span>+</span> Добавить</button>
          <div className="backup-actions">
            <span>Резервная копия</span>
            <button onClick={() => void exportVault()}>Экспорт в файл</button>
            <button onClick={() => void chooseImportFile()}>Импорт из файла</button>
          </div>
          <div className="share-actions">
            <span>Совместный доступ</span>
            <button onClick={() => void openShareDialog()}>Google Таблица</button>
          </div>
          <div className="sidebar-status">
            <span className="status-dot" /> Хранилище разблокировано
            <button onClick={() => void lockVault()}>Заблокировать</button>
          </div>
        </aside>

        <section className="entry-column" aria-label="Список записей">
          <div className="search-wrap">
            <input
              aria-label="Поиск по записям"
              placeholder="Поиск по записям"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="list-heading">{categories.find((item) => item.id === category)?.label}<span>{filteredEntries.length}</span></div>
          <div className="entry-list">
            {filteredEntries.map((entry) => (
              <button
                key={entry.name}
                className={`entry-row ${selectedName === entry.name && !editing ? "selected" : ""}`}
                onClick={() => {
                  setEditing(false);
                  setSelectedName(entry.name);
                  setError("");
                }}
              >
                <span className="entry-avatar">
                  {entry.icon || defaultEntryIcon(entry.kind)}
                </span>
                <span className="entry-copy">
                  <strong>{entry.name}</strong>
                  <small>{entry.kind === "password" ? entry.username || (entry.hasTotp ? "Код 2FA" : "Пароль от сайта") : categoryFor(entry.kind)}{entry.hasTotp ? " · 2FA" : ""}</small>
                </span>
              </button>
            ))}
            {filteredEntries.length === 0 && (
              <div className="list-empty">
                <span>{search ? "⌕" : "+"}</span>
                <p>{search ? "Ничего не найдено" : "В этой категории пока нет записей"}</p>
                {!search && <button onClick={startNewEntry}>Добавить запись</button>}
              </div>
            )}
          </div>
        </section>

        <section className="detail-column" aria-label="Сведения о записи">
          {notice && <p className="operation-notice" role="status">{notice}</p>}
          {error && !editing && !importPath && <p className="error operation-error" role="alert">{error}</p>}
          {editing ? (
            <form className="edit-view" onSubmit={submitEntry}>
              <div className="detail-heading edit-heading">
                <span className="detail-avatar">+</span>
                <div><h1>{originalName ? "Изменить запись" : "Новая запись"}</h1><p>Поля шифруются перед сохранением</p></div>
              </div>
              <div className="edit-fields">
                <label>Название сайта или сервиса<input autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Например, Почта или GitHub" required /></label>
                <fieldset className="icon-picker">
                  <legend>Значок для записи</legend>
                  <div className="icon-options">
                    <button
                      type="button"
                      className={`icon-option icon-auto ${draft.icon === "" ? "selected" : ""}`}
                      aria-label="Значок по умолчанию"
                      aria-pressed={draft.icon === ""}
                      title="Значок по умолчанию"
                      onClick={() => setDraft({ ...draft, icon: "" })}
                    >{defaultEntryIcon(draft.kind)}</button>
                    {entryIcons.map((icon) => (
                      <button
                        key={icon.value}
                        type="button"
                        className={`icon-option ${draft.icon === icon.value ? "selected" : ""}`}
                        aria-label={icon.label}
                        aria-pressed={draft.icon === icon.value}
                        title={icon.label}
                        onClick={() => setDraft({ ...draft, icon: icon.value })}
                      >{icon.value}</button>
                    ))}
                  </div>
                </fieldset>
                <label>Что сохраняем?
                  <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as EntryKind })}>
                    <option value="password">Пароль от сайта</option><option value="ssh_key">Закрытый ключ для сервера (SSH)</option><option value="api_token">Ключ доступа к API</option>
                  </select>
                </label>
                {draft.kind === "password" && <>
                  <label>Имя пользователя или логин<input autoComplete="username" value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} placeholder="Имя для входа на сайт" /></label>
                  <label>Пароль для входа<input type="password" autoComplete="new-password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} /></label>
                </>}
                {draft.kind === "api_token" && <label>Секретный ключ API<textarea rows={4} autoComplete="off" value={draft.apiToken} onChange={(e) => setDraft({ ...draft, apiToken: e.target.value })} placeholder="Ключ, который выдал сервис" required /></label>}
                {draft.kind === "ssh_key" && <label>Закрытый SSH-ключ для входа на сервер<textarea rows={7} spellCheck={false} autoComplete="off" value={draft.sshPrivateKey} onChange={(e) => setDraft({ ...draft, sshPrivateKey: e.target.value })} placeholder="Вставьте закрытую часть ключа" required /></label>}
                <label>Адрес сайта или сервиса<input type="url" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://example.com" /></label>
                <label>Заметка для себя (необязательно)<textarea rows={3} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="Например, для чего используется эта запись" /></label>
                {draft.kind === "password" && (
                  <>
                    <label>Секрет для кодов двухфакторной защиты (2FA)
                      <small>Вставьте секретный ключ или ссылку настройки вида otpauth:// из приложения-аутентификатора.</small>
                      <input autoComplete="off" value={draft.totpSecret} onChange={(e) => setDraft({ ...draft, totpSecret: e.target.value, removeTotp: false })} placeholder={originalHasTotp ? "Оставьте пустым, чтобы не менять" : "Необязательно"} />
                    </label>
                    {originalHasTotp && <label className="checkbox-label"><input type="checkbox" checked={draft.removeTotp} onChange={(e) => setDraft({ ...draft, removeTotp: e.target.checked, totpSecret: "" })} /> Удалить секрет для кодов подтверждения</label>}
                  </>
                )}
              </div>
              {error && <p className="error">{error}</p>}
              <div className="edit-actions"><button type="button" className="secondary" onClick={() => { setEditing(false); setError(""); }}>Отмена</button><button className="primary" disabled={busy}>{busy ? "Сохранение…" : "Сохранить"}</button></div>
            </form>
          ) : details ? (
            <>
              <div className="detail-heading">
                <span className="detail-avatar">{details.icon || defaultEntryIcon(details.kind)}</span>
                <div className="detail-title"><h1>{details.name}</h1><p>{details.username ? `${details.username} · ` : ""}{categoryFor(details.kind)}{details.code ? " · 2FA" : ""}</p></div>
                <div className="detail-actions">
                  <button className="secondary" onClick={startEditing}>Изменить</button>
                  {(details.password || details.apiToken || details.sshPrivateKey) && (
                    <button
                      className="primary copy-primary"
                      onClick={() => void copyValue(details.password || details.apiToken || details.sshPrivateKey, "credential")}
                    >{copied === "credential" ? "Скопировано" : details.kind === "ssh_key" ? "Копировать ключ" : details.kind === "api_token" ? "Копировать токен" : "Копировать пароль"}</button>
                  )}
                  <button className="delete-entry" onClick={() => void removeEntry()} title="Удалить запись" aria-label="Удалить запись">×</button>
                </div>
              </div>
              <div className="detail-card">
                {details.kind === "password" && <>
                  {details.username && <DetailField label="Имя пользователя или логин" value={details.username} onError={setError} />}
                  <div className="detail-field">
                    <span className="field-label">Пароль для входа на сайт</span>
                    <div className="password-line">
                      <div className="masked-value">
                        {details.password ? showPassword ? details.password : "•".repeat(Math.min(details.password.length, 24)) : <span className="field-empty">Пароль не задан</span>}
                        {details.password && <div className="strength-bars"><i /><i /><i /><i /></div>}
                      </div>
                      {details.password && <button className="inline-action" onClick={() => setShowPassword(!showPassword)}>{showPassword ? "Скрыть" : "Показать"}</button>}
                      {details.password && <button className="inline-action" onClick={() => void copyValue(details.password, "password")}>{copied === "password" ? "Скопировано" : "Копировать"}</button>}
                    </div>
                  </div>
                </>}
                {details.kind === "api_token" && <DetailField label="Секретный ключ API" value={details.apiToken} secret onError={setError} />}
                {details.kind === "ssh_key" && <DetailField label="Закрытый ключ для входа на сервер" value={details.sshPrivateKey} secret multiline onError={setError} />}
                        {details.code && <div className="detail-field totp-field">
                  <div><span className="field-label">Код двухфакторной защиты</span><span className="totp-code" key={details.code}>{details.code.slice(0, 3)} {details.code.slice(3)}</span></div>
                  <span className="totp-time">обновится через {details.secondsRemaining} с</span>
                  <div className="detail-progress"><i style={{ width: `${((details.secondsRemaining ?? 0) / 30) * 100}%` }} /></div>
                  <button className="totp-copy" onClick={() => void copyValue(details.code!, "totp")}>{copied === "totp" ? "Скопировано" : "Копировать код"}</button>
                </div>}
                {details.url && <DetailField label="Адрес сайта или сервиса" value={details.url} onError={setError} />}
                {details.notes && <DetailField label="Заметка для себя" value={details.notes} multiline onError={setError} />}
                {details.kind === "password" && !details.username && !details.password && !details.code && !details.url && !details.notes && <div className="detail-field"><span className="field-empty">В этой записи пока нет дополнительных данных.</span></div>}
              </div>
              {error && <p className="error">{error}</p>}
              <footer className="security-note">Шифрование: XChaCha20-Poly1305 · KDF: Argon2id · данные только на этом устройстве</footer>
            </>
          ) : (
            <div className="detail-placeholder">
              <span className="placeholder-mark">F</span>
              <h2>Выберите запись</h2>
              <p>Или создайте новую, чтобы начать работу с хранилищем.</p>
              <button className="primary" onClick={startNewEntry}>Добавить запись</button>
            </div>
          )}
        </section>
      </div>
      {importPath && (
        <div className="modal-backdrop" role="presentation">
          <form className="import-dialog" onSubmit={importVault} role="dialog" aria-modal="true" aria-labelledby="import-title">
            <span className="dialog-kicker">ИМПОРТ РЕЗЕРВНОЙ КОПИИ</span>
            <h2 id="import-title">Заменить содержимое хранилища?</h2>
            <p className="dialog-copy">Выбранный зашифрованный файл будет проверен и импортирован. Все текущие записи заменятся записями из копии.</p>
            <label className="selected-file">Выбранная резервная копия<input value={importPath} readOnly /></label>
            <label className="import-password">Пароль, которым зашифрована эта копия<input type="password" autoFocus autoComplete="off" value={importPassword} onChange={(event) => setImportPassword(event.target.value)} required /></label>
            <label className="checkbox-label confirm-import"><input type="checkbox" checked={confirmImport} onChange={(event) => setConfirmImport(event.target.checked)} /> Я понимаю, что текущие записи будут заменены</label>
            {error && <p className="error" role="alert">{error}</p>}
            <div className="dialog-actions">
              <button type="button" className="secondary" disabled={busy} onClick={() => { setImportPath(""); setError(""); }}>Отмена</button>
              <button className="primary" disabled={busy || !confirmImport}>{busy ? "Импорт…" : "Импортировать"}</button>
            </div>
          </form>
        </div>
      )}
      {shareDialogOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="import-dialog share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-title">
            <span className="dialog-kicker">ТАБЛИЦА GOOGLE · СКВОЗНОЕ ШИФРОВАНИЕ</span>
            <h2 id="share-title">Подключение таблицы</h2>
            <p className="dialog-copy">
              Однократно разверните Apps Script-мост для своей таблицы, затем blau сможет читать её и добавлять/обновлять записи. Удаление записей из общего набора пока не синхронизируется. В таблице хранится только шифротекст.
            </p>
            <label className="selected-file">Адрес скрипта-посредника Google
              <small>Ссылка заканчивается на /exec. Это адрес опубликованного Apps Script, а не ссылка на таблицу.</small>
              <input type="url" autoComplete="off" value={shareScriptUrl} onChange={(event) => setShareScriptUrl(event.target.value)} placeholder="https://script.google.com/macros/s/…/exec" />
            </label>
            <label className="selected-file">Секретный код доступа к скрипту
              <small>Создайте код кнопкой справа и укажите тот же код в настройках скрипта.</small>
              <div className="share-key-row">
                <input type="password" autoComplete="new-password" value={shareAccessToken} onChange={(event) => setShareAccessToken(event.target.value)} />
                <button type="button" className="secondary" onClick={() => void generateBridgeToken()}>Создать</button>
                <button type="button" className="secondary" onClick={() => void copyShareValue(shareAccessToken)}>Копировать</button>
              </div>
            </label>
            <label className="selected-file">Ссылка на общую таблицу Google
              <small>Вставьте ссылку на саму таблицу, которой пользуются участники.</small>
              <input type="url" autoComplete="off" value={shareSheetUrl} onChange={(event) => setShareSheetUrl(event.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
            </label>
            <label className="selected-file">Общий ключ шифрования паролей
              <small>Одинаковый у всех участников. Передавайте его отдельно от ссылки на таблицу.</small>
              <div className="share-key-row">
                <input type="password" autoComplete="off" value={shareKeyInput} onChange={(event) => setShareKeyInput(event.target.value)} />
                <button type="button" className="secondary" onClick={() => void copyShareValue(shareKeyInput)}>Копировать</button>
              </div>
            </label>
            <p className="share-warning">Секретный код скрипта и ключ шифрования сохраняются внутри защищённого хранилища blau. Чтобы подключиться к общему доступу, участникам нужны адрес скрипта, секретный код, ссылка на таблицу и одинаковый ключ шифрования.</p>
            <div className="share-entry-list">
              <strong>Какие пароли добавить или обновить в общей таблице?</strong>
              {entries.filter((entry) => entry.kind === "password" && entry.hasPassword).map((entry) => (
                <label className="share-entry-option" key={entry.name}>
                  <input
                    type="checkbox"
                    checked={shareSelection.includes(entry.name)}
                    onChange={(event) => {
                      setShareSelection((current) => event.target.checked
                        ? [...current, entry.name]
                        : current.filter((name) => name !== entry.name));
                    }}
                  />
                  <span>{entry.name}{entry.username ? ` · ${entry.username}` : ""}</span>
                </label>
              ))}
              {!entries.some((entry) => entry.kind === "password" && entry.hasPassword) && (
                <p className="dialog-copy">Нет записей с заданным паролем.</p>
              )}
            </div>
            <div className="share-sync-actions">
              <button type="button" className="primary" disabled={shareBusy || !shareSelection.length} onClick={() => void publishToGoogleSheet()}>
                {shareBusy ? "Синхронизация…" : "Добавить / обновить выбранное"}
              </button>
              <button type="button" className="secondary" disabled={shareBusy} onClick={() => void readFromGoogleSheet()}>
                {shareBusy ? "Чтение…" : "Прочитать из таблицы"}
              </button>
            </div>
            {receivedShare && (
              <div className="received-share">
                {receivedShare.map((entry) => (
                  <div className="received-share-entry" key={entry.name}>
                    <strong>{entry.name}</strong>
                    {entry.username && <span>Имя пользователя: {entry.username}</span>}
                    {entry.url && <span>Адрес сайта или сервиса: {entry.url}</span>}
                    <button type="button" className="inline-action" onClick={() => void copyShareValue(entry.password)}>Скопировать пароль</button>
                  </div>
                ))}
              </div>
            )}
            {shareError && <p className="error" role="alert">{shareError}</p>}
            {shareNotice && <p className="share-copy-notice" role="status">{shareNotice}</p>}
            <div className="dialog-actions">
              <button type="button" className="secondary" onClick={closeShareDialog}>Закрыть и очистить</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function DetailField({ label, value, secret = false, multiline = false, onError }: { label: string; value: string; secret?: boolean; multiline?: boolean; onError: (message: string) => void }) {
  const [visible, setVisible] = useState(!secret);
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (err) {
      onError(`Не удалось скопировать значение записи: ${String(err)}`);
    }
  }
  return (
    <div className="detail-field">
      <span className="field-label">{label}</span>
      <div className="field-value-row">
        <span className={`field-value ${multiline ? "multiline" : ""}`}>{value ? visible ? value : "•".repeat(Math.min(value.length, 28)) : <span className="field-empty">Не задано</span>}</span>
        {value && secret && <button className="inline-action" onClick={() => setVisible(!visible)}>{visible ? "Скрыть" : "Показать"}</button>}
        {value && <button className="inline-action" onClick={() => void copy()}>{copied ? "Скопировано" : "Копировать"}</button>}
      </div>
    </div>
  );
}

export default App;
