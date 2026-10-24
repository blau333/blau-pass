import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useMemo, useState } from "react";
import logo from "./assets/logo.png";
import { languages, loadLanguage, translate, type Language } from "./i18n";

type EntryKind = "password" | "ssh_key" | "api_token" | "wifi_network";
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
type Appearance = {
  theme: "blau" | "midnight" | "forest" | "light";
  accent: string;
  density: "comfortable" | "compact";
  fontSize: "small" | "standard" | "large";
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
  { id: "wifi_network", label: "Сети Wi-Fi" },
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
  { value: "📶", label: "Wi-Fi" },
];

const appearanceKey = "blau-appearance";
const defaultAppearance: Appearance = {
  theme: "blau",
  accent: "#e96e36",
  density: "comfortable",
  fontSize: "standard",
};
const accentColors = [
  { value: "#e96e36", label: "Терракотовый" },
  { value: "#33a9c2", label: "Бирюзовый" },
  { value: "#9b7bdb", label: "Фиолетовый" },
  { value: "#55ad79", label: "Зелёный" },
  { value: "#df668e", label: "Розовый" },
];

function loadAppearance(): Appearance {
  try {
    const saved = localStorage.getItem(appearanceKey);
    if (!saved) return defaultAppearance;
    const value: unknown = JSON.parse(saved);
    if (!value || typeof value !== "object") return defaultAppearance;
    const settings = value as Partial<Appearance>;
    return {
      theme: ["blau", "midnight", "forest", "light"].includes(settings.theme ?? "")
        ? settings.theme as Appearance["theme"]
        : defaultAppearance.theme,
      accent: accentColors.some((accent) => accent.value === settings.accent)
        ? settings.accent!
        : defaultAppearance.accent,
      density: settings.density === "compact" ? "compact" : "comfortable",
      fontSize: ["small", "standard", "large"].includes(settings.fontSize ?? "")
        ? settings.fontSize as Appearance["fontSize"]
        : defaultAppearance.fontSize,
    };
  } catch {
    return defaultAppearance;
  }
}

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

function categoryFor(kind: EntryKind, language: Language): string {
  if (kind === "ssh_key") return translate(language, "Закрытый ключ для сервера");
  if (kind === "api_token") return translate(language, "Ключ доступа к API");
  if (kind === "wifi_network") return translate(language, "Сеть Wi-Fi");
  return translate(language, "Пароль от сайта");
}

function defaultEntryIcon(kind: EntryKind): string {
  if (kind === "ssh_key") return "🔐";
  if (kind === "api_token") return "🔑";
  if (kind === "wifi_network") return "📶";
  return "🌐";
}

function isLanguage(value: string): value is Language {
  return languages.some((language) => language.code === value);
}

function App() {
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance);
  const [language, setLanguage] = useState<Language>(loadLanguage);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [currentMasterPassword, setCurrentMasterPassword] = useState("");
  const [newMasterPassword, setNewMasterPassword] = useState("");
  const [confirmMasterPassword, setConfirmMasterPassword] = useState("");
  const [passwordChangeBusy, setPasswordChangeBusy] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [settingsNotice, setSettingsNotice] = useState("");
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
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateStatus, setUpdateStatus] = useState("");
  const t = (source: string) => translate(language, source);

  useEffect(() => {
    document.documentElement.dataset.theme = appearance.theme;
    document.documentElement.dataset.density = appearance.density;
    document.documentElement.dataset.fontSize = appearance.fontSize;
    document.documentElement.style.setProperty("--accent", appearance.accent);
    try {
      localStorage.setItem(appearanceKey, JSON.stringify(appearance));
    } catch (err) {
      setSettingsError(`${t("Не удалось сохранить настройки оформления: ")}${String(err)}`);
    }
  }, [appearance]);

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
    try {
      localStorage.setItem("blau-language", language);
    } catch (err) {
      setSettingsError(`${t("Не удалось сохранить настройки оформления: ")}${String(err)}`);
    }
  }, [language]);

  function renderLanguageSelect(className?: string) {
    return (
      <label className={className}>
        {t("Язык")}
        <select
          value={language}
          onChange={(event) => {
            if (isLanguage(event.target.value)) setLanguage(event.target.value);
          }}
        >
          {languages.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}
        </select>
      </label>
    );
  }

  function closeSettings() {
    setSettingsOpen(false);
    setCurrentMasterPassword("");
    setNewMasterPassword("");
    setConfirmMasterPassword("");
    setSettingsError("");
    setSettingsNotice("");
  }

  async function changeMasterPassword(event: React.FormEvent) {
    event.preventDefault();
    setSettingsError("");
    setSettingsNotice("");
    if (newMasterPassword !== confirmMasterPassword) {
      setSettingsError(t("Новый мастер-пароль и подтверждение не совпадают."));
      return;
    }
    if (newMasterPassword.length < 12) {
      setSettingsError(t("Мастер-пароль должен быть не короче 12 символов."));
      return;
    }
    setPasswordChangeBusy(true);
    try {
      await invoke("change_master_password", {
        currentPassword: currentMasterPassword,
        newPassword: newMasterPassword,
      });
      setCurrentMasterPassword("");
      setNewMasterPassword("");
      setConfirmMasterPassword("");
      setSettingsNotice(t("Мастер-пароль изменён. Используйте его при следующей разблокировке."));
    } catch (err) {
      setSettingsError(String(err));
    } finally {
      setPasswordChangeBusy(false);
    }
  }

  async function checkForUpdates() {
    setUpdateBusy(true);
    setUpdateStatus("");
    try {
      const update = await check();
      if (!update) {
        setUpdateStatus(t("Установлена последняя версия."));
        return;
      }
      if (!window.confirm(`${t("Доступно обновление до версии ")}${update.version}. ${t("Скачать и установить её?")}`)) {
        setUpdateStatus(`${t("Доступно обновление до версии ")}${update.version}.`);
        return;
      }
      setUpdateStatus(t("Скачивание и установка обновления…"));
      await update.downloadAndInstall();
      setUpdateStatus(t("Обновление установлено. Перезапуск приложения…"));
      await relaunch();
    } catch (err) {
      setUpdateStatus(`${t("Не удалось обновить приложение: ")}${String(err)}`);
    } finally {
      setUpdateBusy(false);
    }
  }

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
      setShareNotice(`${t("Таблица обновлена. Общих записей: ")}${count}.`);
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
        throw new Error(t("В таблице пока нет пакета. Сначала опубликуйте записи."));
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
      setShareNotice(t("Ключ скопирован. Передайте его участникам отдельно от таблицы."));
      window.setTimeout(() => setShareNotice(""), 3500);
    } catch (err) {
      setShareError(`${t("Не удалось скопировать: ")}${String(err)}`);
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
      wifi_network: entries.filter((entry) => entry.kind === "wifi_network").length,
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
        title: t("Экспорт зашифрованной копии"),
        defaultPath: "blau-backup.rsv",
        filters: [{ name: t("Зашифрованное хранилище Blau"), extensions: ["rsv"] }],
      });
      if (!destination) return;
      await invoke("export_vault", { destination });
      setNotice(t("Зашифрованная копия сохранена."));
    } catch (err) {
      setError(String(err));
    }
  }

  async function chooseImportFile() {
    setError("");
    setNotice("");
    try {
      const selected = await open({
        title: t("Выберите копию хранилища Blau"),
        multiple: false,
        directory: false,
        filters: [{ name: t("Зашифрованное хранилище Blau"), extensions: ["rsv"] }],
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
      setNotice(t("Хранилище импортировано. Текущие записи заменены; мастер-пароль Blau сохранён."));
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
    if (!details || !window.confirm(`${t("Удалить запись «")}${details.name}${t("»?")}`)) return;
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
      setError(`${t("Не удалось скопировать: ")}${String(err)}`);
    }
  }

  const originalHasTotp = originalName
    ? entries.find((entry) => entry.name === originalName)?.hasTotp ?? false
    : false;

  if (hasVault === null) {
    return error
      ? <main className="center"><p className="error">{error}</p></main>
      : <main className="center"><span className="spinner" />{t("Загрузка…")}</main>;
  }

  if (!unlocked) {
    return (
      <main className="auth-screen">
        <section className="auth-panel">
          <div className="auth-brand">
            <img className="brand-mark" src={logo} alt="blau" />
            <h1>blau</h1>
          </div>
          {renderLanguageSelect("language-select auth-language")}
          <p className="auth-copy">
            {hasVault
              ? t("Введите мастер-пароль, чтобы расшифровать хранилище.")
              : t("Создайте мастер-пароль для нового зашифрованного хранилища.")}
          </p>
          <form onSubmit={submitPassword} className="auth-form">
            <label htmlFor="master-password">{t("Главный пароль для разблокировки хранилища")}</label>
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
              {busy ? t("Подождите…") : hasVault ? t("Разблокировать") : t("Создать хранилище")}
            </button>
          </form>
          {error && <p className="error">{error}</p>}
          <button className="secondary auth-update" onClick={() => void checkForUpdates()} disabled={updateBusy}>
            {updateBusy ? t("Проверка обновлений…") : t("Проверить обновления")}
          </button>
          {updateStatus && (
            <p className={`update-status${updateStatus.startsWith(t("Не удалось обновить приложение: ")) ? " error" : ""}`}
              role={updateStatus.startsWith(t("Не удалось обновить приложение: ")) ? "alert" : "status"}>
              {updateStatus}
            </p>
          )}
          <p className="auth-footnote">
            {t("Хранилище — один зашифрованный файл на этом устройстве. Мастер-пароль нигде не сохраняется.")}
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
          <nav aria-label={t("Категории")}>
            {categories.map((item) => (
              <button
                key={item.id}
                className={`nav-item ${category === item.id ? "active" : ""}`}
                onClick={() => setCategory(item.id)}
              >
                <span>{t(item.label)}</span><span className="nav-count">{counts[item.id]}</span>
              </button>
            ))}
          </nav>
          <button className="new-entry" onClick={startNewEntry}><span>+</span> {t("Добавить")}</button>
          <button className="settings-open" onClick={() => { setSettingsError(""); setSettingsNotice(""); setSettingsOpen(true); }}>
            <span aria-hidden="true">⚙</span><span>{t("Настройки")}</span>
          </button>
          <div className="backup-actions">
            <span>{t("Резервная копия")}</span>
            <button onClick={() => void exportVault()}>{t("Экспорт в файл")}</button>
            <button onClick={() => void chooseImportFile()}>{t("Импорт из файла")}</button>
          </div>
          <div className="share-actions">
            <span>{t("Совместный доступ")}</span>
            <button onClick={() => void openShareDialog()}>{t("Google Таблица")}</button>
          </div>
          {renderLanguageSelect("language-select sidebar-language")}
          <div className="sidebar-status">
            <span className="status-dot" /> {t("Хранилище разблокировано")}
            <button onClick={() => void checkForUpdates()} disabled={updateBusy}>
              {updateBusy ? t("Обновление…") : t("Проверить обновления")}
            </button>
            {updateStatus && (
              <span className={`update-status${updateStatus.startsWith(t("Не удалось обновить приложение: ")) ? " error" : ""}`}
                role={updateStatus.startsWith(t("Не удалось обновить приложение: ")) ? "alert" : "status"}>
                {updateStatus}
              </span>
            )}
            <button onClick={() => void lockVault()}>{t("Заблокировать")}</button>
          </div>
        </aside>

        <section className="entry-column" aria-label={t("Список записей")}>
          <div className="search-wrap">
            <input
              aria-label={t("Поиск по записям")}
              placeholder={t("Поиск по записям")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="list-heading">{t(categories.find((item) => item.id === category)?.label ?? "")}<span>{filteredEntries.length}</span></div>
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
                  <small>{entry.kind === "password" ? entry.username || (entry.hasTotp ? t("Код 2FA") : categoryFor(entry.kind, language)) : categoryFor(entry.kind, language)}{entry.hasTotp ? " · 2FA" : ""}</small>
                </span>
              </button>
            ))}
            {filteredEntries.length === 0 && (
              <div className="list-empty">
                <span>{search ? "⌕" : "+"}</span>
                <p>{search ? t("Ничего не найдено") : t("В этой категории пока нет записей")}</p>
                {!search && <button onClick={startNewEntry}>{t("Добавить запись")}</button>}
              </div>
            )}
          </div>
        </section>

        <section className="detail-column" aria-label={t("Сведения о записи")}>
          {notice && <p className="operation-notice" role="status">{notice}</p>}
          {error && !editing && !importPath && <p className="error operation-error" role="alert">{error}</p>}
          {editing ? (
            <form className="edit-view" onSubmit={submitEntry}>
              <div className="detail-heading edit-heading">
                <span className="detail-avatar">+</span>
                <div><h1>{originalName ? t("Изменить запись") : t("Новая запись")}</h1><p>{t("Поля шифруются перед сохранением")}</p></div>
              </div>
              <div className="edit-fields">
                <label>{t(draft.kind === "wifi_network" ? "Название сети (SSID)" : "Название сайта или сервиса")}<input autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t(draft.kind === "wifi_network" ? "Например, Домашняя сеть" : "Например, Почта или GitHub")} required /></label>
                <fieldset className="icon-picker">
                  <legend>{t("Значок для записи")}</legend>
                  <div className="icon-options">
                    <button
                      type="button"
                      className={`icon-option icon-auto ${draft.icon === "" ? "selected" : ""}`}
                      aria-label={t("Значок по умолчанию")}
                      aria-pressed={draft.icon === ""}
                      title={t("Значок по умолчанию")}
                      onClick={() => setDraft({ ...draft, icon: "" })}
                    >{defaultEntryIcon(draft.kind)}</button>
                    {entryIcons.map((icon) => (
                      <button
                        key={icon.value}
                        type="button"
                        className={`icon-option ${draft.icon === icon.value ? "selected" : ""}`}
                        aria-label={t(icon.label)}
                        aria-pressed={draft.icon === icon.value}
                        title={t(icon.label)}
                        onClick={() => setDraft({ ...draft, icon: icon.value })}
                      >{icon.value}</button>
                    ))}
                  </div>
                </fieldset>
                <label>{t("Что сохраняем?")}
                  <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as EntryKind })}>
                    <option value="password">{t("Пароль от сайта")}</option><option value="wifi_network">{t("Пароль от сети Wi-Fi")}</option><option value="ssh_key">{t("Закрытый ключ для сервера (SSH)")}</option><option value="api_token">{t("Ключ доступа к API")}</option>
                  </select>
                </label>
                {draft.kind === "password" && <>
                  <label>{t("Имя пользователя или логин")}<input autoComplete="username" value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} placeholder={t("Имя для входа на сайт")} /></label>
                  <label>{t("Пароль для входа")}<input type="password" autoComplete="new-password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} /></label>
                </>}
                {draft.kind === "wifi_network" && <label>{t("Пароль сети Wi-Fi")}<input type="password" autoComplete="new-password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} required /></label>}
                {draft.kind === "api_token" && <label>{t("Секретный ключ API")}<textarea rows={4} autoComplete="off" value={draft.apiToken} onChange={(e) => setDraft({ ...draft, apiToken: e.target.value })} placeholder={t("Ключ, который выдал сервис")} required /></label>}
                {draft.kind === "ssh_key" && <label>{t("Закрытый SSH-ключ для входа на сервер")}<textarea rows={7} spellCheck={false} autoComplete="off" value={draft.sshPrivateKey} onChange={(e) => setDraft({ ...draft, sshPrivateKey: e.target.value })} placeholder={t("Вставьте закрытую часть ключа")} required /></label>}
                <label>{t("Адрес сайта или сервиса")}<input type="url" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://example.com" /></label>
                <label>{t("Заметка для себя (необязательно)")}<textarea rows={3} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder={t("Например, для чего используется эта запись")} /></label>
                {draft.kind === "password" && (
                  <>
                    <label>{t("Секрет для кодов двухфакторной защиты (2FA)")}
                      <small>{t("Вставьте секретный ключ или ссылку otpauth:// из приложения-аутентификатора. Алгоритм, число цифр и интервал из ссылки будут учтены.")}</small>
                      <input autoComplete="off" value={draft.totpSecret} onChange={(e) => setDraft({ ...draft, totpSecret: e.target.value, removeTotp: false })} placeholder={originalHasTotp ? t("Оставьте пустым, чтобы не менять") : t("Необязательно")} />
                    </label>
                    {originalHasTotp && <label className="checkbox-label"><input type="checkbox" checked={draft.removeTotp} onChange={(e) => setDraft({ ...draft, removeTotp: e.target.checked, totpSecret: "" })} /> {t("Удалить секрет для кодов подтверждения")}</label>}
                  </>
                )}
              </div>
              {error && <p className="error">{error}</p>}
              <div className="edit-actions"><button type="button" className="secondary" onClick={() => { setEditing(false); setError(""); }}>{t("Отмена")}</button><button className="primary" disabled={busy}>{busy ? t("Сохранение…") : t("Сохранить")}</button></div>
            </form>
          ) : details ? (
            <>
              <div className="detail-heading">
                <span className="detail-avatar">{details.icon || defaultEntryIcon(details.kind)}</span>
                <div className="detail-title"><h1>{details.name}</h1><p>{details.username ? `${details.username} · ` : ""}{categoryFor(details.kind, language)}{details.code ? " · 2FA" : ""}</p></div>
                <div className="detail-actions">
                  <button className="secondary" onClick={startEditing}>{t("Изменить")}</button>
                  {(details.password || details.apiToken || details.sshPrivateKey) && (
                    <button
                      className="primary copy-primary"
                      onClick={() => void copyValue(details.password || details.apiToken || details.sshPrivateKey, "credential")}
                    >{copied === "credential" ? t("Скопировано") : details.kind === "ssh_key" ? t("Копировать ключ") : details.kind === "api_token" ? t("Копировать токен") : details.kind === "wifi_network" ? t("Копировать пароль Wi-Fi") : t("Копировать пароль")}</button>
                  )}
                  <button className="delete-entry" onClick={() => void removeEntry()} title={t("Удалить запись")} aria-label={t("Удалить запись")}>×</button>
                </div>
              </div>
              <div className="detail-card">
                {(details.kind === "password" || details.kind === "wifi_network") && <>
                  {details.kind === "password" && details.username && <DetailField label={t("Имя пользователя или логин")} value={details.username} language={language} onError={setError} />}
                  <div className="detail-field">
                    <span className="field-label">{t(details.kind === "wifi_network" ? "Пароль сети Wi-Fi" : "Пароль для входа на сайт")}</span>
                    <div className="password-line">
                      <div className="masked-value">
                        {details.password ? showPassword ? details.password : "•".repeat(Math.min(details.password.length, 24)) : <span className="field-empty">{t("Пароль не задан")}</span>}
                        {details.password && <div className="strength-bars"><i /><i /><i /><i /></div>}
                      </div>
                      {details.password && <button className="inline-action" onClick={() => setShowPassword(!showPassword)}>{showPassword ? t("Скрыть") : t("Показать")}</button>}
                      {details.password && <button className="inline-action" onClick={() => void copyValue(details.password, "password")}>{copied === "password" ? t("Скопировано") : t("Копировать")}</button>}
                    </div>
                  </div>
                </>}
                {details.kind === "api_token" && <DetailField label={t("Секретный ключ API")} value={details.apiToken} secret language={language} onError={setError} />}
                {details.kind === "ssh_key" && <DetailField label={t("Закрытый ключ для входа на сервер")} value={details.sshPrivateKey} secret multiline language={language} onError={setError} />}
                        {details.code && <div className="detail-field totp-field">
                  <div><span className="field-label">{t("Код двухфакторной защиты")}</span><span className="totp-code" key={details.code}>{details.code.slice(0, details.code.length / 2)} {details.code.slice(details.code.length / 2)}</span></div>
                  <span className="totp-time">{t("обновится через")} {details.secondsRemaining} {language === "ru" ? "с" : "s"}</span>
                  <div className="detail-progress"><i style={{ width: `${((details.secondsRemaining ?? 0) / 30) * 100}%` }} /></div>
                  <button className="totp-copy" onClick={() => void copyValue(details.code!, "totp")}>{copied === "totp" ? t("Скопировано") : t("Копировать код")}</button>
                </div>}
                {details.url && <DetailField label={t("Адрес сайта или сервиса")} value={details.url} language={language} onError={setError} />}
                {details.notes && <DetailField label={t("Заметка для себя")} value={details.notes} multiline language={language} onError={setError} />}
                {(details.kind === "password" || details.kind === "wifi_network") && !details.username && !details.password && !details.code && !details.url && !details.notes && <div className="detail-field"><span className="field-empty">{t("В этой записи пока нет дополнительных данных.")}</span></div>}
              </div>
              {error && <p className="error">{error}</p>}
              <footer className="security-note">{t("Шифрование: XChaCha20-Poly1305 · KDF: Argon2id · данные только на этом устройстве")}</footer>
            </>
          ) : (
            <div className="detail-placeholder">
              <span className="placeholder-mark">F</span>
              <h2>{t("Выберите запись")}</h2>
              <p>{t("Или создайте новую, чтобы начать работу с хранилищем.")}</p>
              <button className="primary" onClick={startNewEntry}>{t("Добавить запись")}</button>
            </div>
          )}
        </section>
      </div>
      {importPath && (
        <div className="modal-backdrop" role="presentation">
          <form className="import-dialog" onSubmit={importVault} role="dialog" aria-modal="true" aria-labelledby="import-title">
            <span className="dialog-kicker">{t("ИМПОРТ РЕЗЕРВНОЙ КОПИИ")}</span>
            <h2 id="import-title">{t("Заменить содержимое хранилища?")}</h2>
            <p className="dialog-copy">{t("Выбранный зашифрованный файл будет проверен и импортирован. Все текущие записи заменятся записями из копии.")}</p>
            <label className="selected-file">{t("Выбранная резервная копия")}<input value={importPath} readOnly /></label>
            <label className="import-password">{t("Пароль, которым зашифрована эта копия")}<input type="password" autoFocus autoComplete="off" value={importPassword} onChange={(event) => setImportPassword(event.target.value)} required /></label>
            <label className="checkbox-label confirm-import"><input type="checkbox" checked={confirmImport} onChange={(event) => setConfirmImport(event.target.checked)} /> {t("Я понимаю, что текущие записи будут заменены")}</label>
            {error && <p className="error" role="alert">{error}</p>}
            <div className="dialog-actions">
              <button type="button" className="secondary" disabled={busy} onClick={() => { setImportPath(""); setError(""); }}>{t("Отмена")}</button>
              <button className="primary" disabled={busy || !confirmImport}>{busy ? t("Импорт…") : t("Импортировать")}</button>
            </div>
          </form>
        </div>
      )}
      {shareDialogOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="import-dialog share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-title">
            <span className="dialog-kicker">{t("ТАБЛИЦА GOOGLE · СКВОЗНОЕ ШИФРОВАНИЕ")}</span>
            <h2 id="share-title">{t("Подключение таблицы")}</h2>
            <p className="dialog-copy">
              {t("Однократно разверните Apps Script-мост для своей таблицы, затем blau сможет читать её и добавлять/обновлять записи. Удаление записей из общего набора пока не синхронизируется. В таблице хранится только шифротекст.")}
            </p>
            <label className="selected-file">{t("Адрес скрипта-посредника Google")}
              <small>{t("Ссылка заканчивается на /exec. Это адрес опубликованного Apps Script, а не ссылка на таблицу.")}</small>
              <input type="url" autoComplete="off" value={shareScriptUrl} onChange={(event) => setShareScriptUrl(event.target.value)} placeholder="https://script.google.com/macros/s/…/exec" />
            </label>
            <label className="selected-file">{t("Секретный код доступа к скрипту")}
              <small>{t("Создайте код кнопкой справа и укажите тот же код в настройках скрипта.")}</small>
              <div className="share-key-row">
                <input type="password" autoComplete="new-password" value={shareAccessToken} onChange={(event) => setShareAccessToken(event.target.value)} />
                <button type="button" className="secondary" onClick={() => void generateBridgeToken()}>{t("Создать")}</button>
                <button type="button" className="secondary" onClick={() => void copyShareValue(shareAccessToken)}>{t("Копировать")}</button>
              </div>
            </label>
            <label className="selected-file">{t("Ссылка на общую таблицу Google")}
              <small>{t("Вставьте ссылку на саму таблицу, которой пользуются участники.")}</small>
              <input type="url" autoComplete="off" value={shareSheetUrl} onChange={(event) => setShareSheetUrl(event.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
            </label>
            <label className="selected-file">{t("Общий ключ шифрования паролей")}
              <small>{t("Одинаковый у всех участников. Передавайте его отдельно от ссылки на таблицу.")}</small>
              <div className="share-key-row">
                <input type="password" autoComplete="off" value={shareKeyInput} onChange={(event) => setShareKeyInput(event.target.value)} />
                <button type="button" className="secondary" onClick={() => void copyShareValue(shareKeyInput)}>{t("Копировать")}</button>
              </div>
            </label>
            <p className="share-warning">{t("Секретный код скрипта и ключ шифрования сохраняются внутри защищённого хранилища blau. Чтобы подключиться к общему доступу, участникам нужны адрес скрипта, секретный код, ссылка на таблицу и одинаковый ключ шифрования.")}</p>
            <div className="share-entry-list">
              <strong>{t("Какие пароли добавить или обновить в общей таблице?")}</strong>
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
                <p className="dialog-copy">{t("Нет записей с заданным паролем.")}</p>
              )}
            </div>
            <div className="share-sync-actions">
              <button type="button" className="primary" disabled={shareBusy || !shareSelection.length} onClick={() => void publishToGoogleSheet()}>
                {shareBusy ? t("Синхронизация…") : t("Добавить / обновить выбранное")}
              </button>
              <button type="button" className="secondary" disabled={shareBusy} onClick={() => void readFromGoogleSheet()}>
                {shareBusy ? t("Чтение…") : t("Прочитать из таблицы")}
              </button>
            </div>
            {receivedShare && (
              <div className="received-share">
                {receivedShare.map((entry) => (
                  <div className="received-share-entry" key={entry.name}>
                    <strong>{entry.name}</strong>
                    {entry.username && <span>{t("Имя пользователя: ")}{entry.username}</span>}
                    {entry.url && <span>{t("Адрес сайта или сервиса")}: {entry.url}</span>}
                    <button type="button" className="inline-action" onClick={() => void copyShareValue(entry.password)}>{t("Скопировать пароль")}</button>
                  </div>
                ))}
              </div>
            )}
            {shareError && <p className="error" role="alert">{shareError}</p>}
            {shareNotice && <p className="share-copy-notice" role="status">{shareNotice}</p>}
            <div className="dialog-actions">
              <button type="button" className="secondary" onClick={closeShareDialog}>{t("Закрыть и очистить")}</button>
            </div>
          </section>
        </div>
      )}
      {settingsOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="import-dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <span className="dialog-kicker">{t("ПЕРСОНАЛИЗАЦИЯ И БЕЗОПАСНОСТЬ")}</span>
            <h2 id="settings-title">{t("Настройки приложения")}</h2>
            <div className="settings-options">
              {renderLanguageSelect()}
              <label>{t("Тема оформления")}
                <select value={appearance.theme} onChange={(event) => setAppearance({ ...appearance, theme: event.target.value as Appearance["theme"] })}>
                  <option value="blau">{t("Blau — тёмная")}</option>
                  <option value="midnight">{t("Полночь — синяя")}</option>
                  <option value="forest">{t("Лес — зелёная")}</option>
                  <option value="light">{t("Светлая")}</option>
                </select>
              </label>
              <fieldset className="accent-picker">
                <legend>{t("Акцентный цвет")}</legend>
                <div className="accent-options">
                  {accentColors.map((accent) => (
                    <button
                      key={accent.value}
                      type="button"
                      className={`accent-option ${appearance.accent === accent.value ? "selected" : ""}`}
                      style={{ "--swatch": accent.value } as React.CSSProperties}
                      aria-label={t(accent.label)}
                      aria-pressed={appearance.accent === accent.value}
                      title={t(accent.label)}
                      onClick={() => setAppearance({ ...appearance, accent: accent.value })}
                    />
                  ))}
                </div>
              </fieldset>
              <label>{t("Плотность списка")}
                <select value={appearance.density} onChange={(event) => setAppearance({ ...appearance, density: event.target.value as Appearance["density"] })}>
                  <option value="comfortable">{t("Свободная")}</option>
                  <option value="compact">{t("Компактная")}</option>
                </select>
              </label>
              <label>{t("Размер текста")}
                <select value={appearance.fontSize} onChange={(event) => setAppearance({ ...appearance, fontSize: event.target.value as Appearance["fontSize"] })}>
                  <option value="small">{t("Маленький")}</option>
                  <option value="standard">{t("Обычный")}</option>
                  <option value="large">{t("Крупный")}</option>
                </select>
              </label>
            </div>
            <form className="password-change" onSubmit={changeMasterPassword}>
              <h3>{t("Изменить мастер-пароль")}</h3>
              <p className="dialog-copy">{t("Все записи будут заново зашифрованы. Для резервных копий, сделанных ранее, останется нужен прежний пароль.")}</p>
              <label>{t("Текущий мастер-пароль")}<input type="password" autoComplete="current-password" value={currentMasterPassword} onChange={(event) => setCurrentMasterPassword(event.target.value)} required /></label>
              <label>{t("Новый мастер-пароль")}<input type="password" autoComplete="new-password" minLength={12} value={newMasterPassword} onChange={(event) => setNewMasterPassword(event.target.value)} required /></label>
              <label>{t("Повторите новый мастер-пароль")}<input type="password" autoComplete="new-password" minLength={12} value={confirmMasterPassword} onChange={(event) => setConfirmMasterPassword(event.target.value)} required /></label>
              {settingsError && <p className="error" role="alert">{settingsError}</p>}
              {settingsNotice && <p className="settings-notice" role="status">{settingsNotice}</p>}
              <div className="dialog-actions">
                <button type="button" className="secondary" onClick={closeSettings} disabled={passwordChangeBusy}>{t("Закрыть")}</button>
                <button className="primary" disabled={passwordChangeBusy}>{passwordChangeBusy ? t("Изменение…") : t("Изменить пароль")}</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}

function DetailField({ label, value, secret = false, multiline = false, language, onError }: { label: string; value: string; secret?: boolean; multiline?: boolean; language: Language; onError: (message: string) => void }) {
  const [visible, setVisible] = useState(!secret);
  const [copied, setCopied] = useState(false);
  const t = (source: string) => translate(language, source);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (err) {
      onError(`${t("Не удалось скопировать значение записи: ")}${String(err)}`);
    }
  }
  return (
    <div className="detail-field">
      <span className="field-label">{label}</span>
      <div className="field-value-row">
        <span className={`field-value ${multiline ? "multiline" : ""}`}>{value ? visible ? value : "•".repeat(Math.min(value.length, 28)) : <span className="field-empty">{t("Не задано")}</span>}</span>
        {value && secret && <button className="inline-action" onClick={() => setVisible(!visible)}>{visible ? t("Скрыть") : t("Показать")}</button>}
        {value && <button className="inline-action" onClick={() => void copy()}>{copied ? t("Скопировано") : t("Копировать")}</button>}
      </div>
    </div>
  );
}

export default App;
