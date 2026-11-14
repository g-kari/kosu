/**
 * Minimal dictionary-based i18n (phase 5 item 9).
 *
 * Scope (see docs/DESIGN.md): the app shell navigation, the dashboard
 * headings, the settings page and the public legal pages resolve their
 * strings through this dictionary. API error messages and the many
 * inline labels of the work pages remain Japanese for now; new UI
 * strings should be added here first.
 */

export type Locale = "ja" | "en";

const DICT = {
  "app.tagline": {
    ja: "工数とタスクを静かに管理する",
    en: "Quiet time & task tracking",
  },
  "nav.dashboard": { ja: "ダッシュボード", en: "Dashboard" },
  "nav.projects": { ja: "プロジェクト", en: "Projects" },
  "nav.gantt": { ja: "ガント", en: "Gantt" },
  "nav.reports": { ja: "レポート", en: "Reports" },
  "nav.settings": { ja: "連携設定", en: "Integrations" },
  "nav.preferences": { ja: "表示設定", en: "Preferences" },
  "nav.onboarding": { ja: "初期設定", en: "Getting started" },
  "nav.terms": { ja: "利用規約", en: "Terms" },
  "nav.privacy": { ja: "プライバシーポリシー", en: "Privacy" },
  "nav.login": { ja: "ログイン", en: "Sign in" },
  "nav.logout": { ja: "ログアウト", en: "Sign out" },
  "dashboard.title": { ja: "ダッシュボード", en: "Dashboard" },
  "dashboard.today": { ja: "今日", en: "Today" },
  "dashboard.week": { ja: "今週", en: "This week" },
  "dashboard.running": { ja: "計測中", en: "Running" },
  "dashboard.due_today": { ja: "今日締切", en: "Due today" },
  "dashboard.overdue": { ja: "期限超過", en: "Overdue" },
  "dashboard.estimate_gap": { ja: "見積差分", en: "Estimate vs actual" },
  "prefs.title": { ja: "表示設定", en: "Display preferences" },
  "prefs.theme": { ja: "テーマ", en: "Theme" },
  "prefs.theme_system": { ja: "システムに合わせる", en: "Follow system" },
  "prefs.theme_light": { ja: "ライト", en: "Light" },
  "prefs.theme_dark": { ja: "ダーク", en: "Dark" },
  "prefs.locale": { ja: "言語", en: "Language" },
  "prefs.week_start": { ja: "週の開始曜日", en: "Week starts on" },
  "prefs.save": { ja: "保存する", en: "Save" },
  "prefs.saved": { ja: "保存しました", en: "Saved" },
  "palette.placeholder": {
    ja: "タスクを検索、またはコマンドを入力…",
    en: "Search tasks or type a command…",
  },
  "palette.create_task": { ja: "タスクを作成", en: "Create task" },
  "palette.go_dashboard": { ja: "ダッシュボードへ移動", en: "Go to dashboard" },
  "terms.title": { ja: "利用規約", en: "Terms of Service" },
  "privacy.title": { ja: "プライバシーポリシー", en: "Privacy Policy" },
  "onboarding.title": { ja: "初期設定", en: "Getting started" },
  "onboarding.add_sample": {
    ja: "サンプルプロジェクトを追加",
    en: "Add a sample project",
  },
  "onboarding.remove_sample": {
    ja: "サンプルプロジェクトを削除",
    en: "Remove the sample project",
  },
  "share.progress": { ja: "進捗", en: "Progress" },
  "share.completed": { ja: "完了", en: "completed" },
  "weekday.1": { ja: "月曜日", en: "Monday" },
  "weekday.2": { ja: "火曜日", en: "Tuesday" },
  "weekday.3": { ja: "水曜日", en: "Wednesday" },
  "weekday.4": { ja: "木曜日", en: "Thursday" },
  "weekday.5": { ja: "金曜日", en: "Friday" },
  "weekday.6": { ja: "土曜日", en: "Saturday" },
  "weekday.7": { ja: "日曜日", en: "Sunday" },
} as const;

export type MessageKey = keyof typeof DICT;

export function t(locale: Locale, key: MessageKey): string {
  const entry = DICT[key] as { ja: string; en: string };
  return entry[locale] ?? entry.ja;
}

export function isLocale(value: unknown): value is Locale {
  return value === "ja" || value === "en";
}
