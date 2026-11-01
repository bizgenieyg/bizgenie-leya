/**
 * Z15: «Нужен ответ» as the owner's one entry point — settings, BizGenie support, hints. Data, not code: the words of
 * the instant commands, the settings the owner may change from WhatsApp (the code applies only these), the settings
 * that live only in the cabinet (and its section), and the human names of the settings in the owner's languages.
 */
type Lang = 'ru' | 'he' | 'en';

/** The whole message, any case: stop / start all client replies at once — no model, no question. */
export const STOP_ALL_WORDS: readonly string[] = ['стоп', 'עצור', 'stop'];
export const START_ALL_WORDS: readonly string[] = ['включи', 'הפעל', 'start'];
/** The whole message: the hint list («что ты умеешь?»). */
export const HELP_WORDS: readonly string[] = ['что ты умеешь', 'что умеешь', 'помощь', 'עזרה', 'מה את יודעת לעשות', 'help', 'what can you do'];

/** Settings the owner changes by a message (after «Было → станет. Сохранить? Да / Нет»). */
export const CHAT_SETTINGS = ['quiet_hours', 'day_off', 'daily_report_enabled', 'daily_report_time', 'auto_resume_hours',
  'polish_owner_answer', 'assistant_name', 'owner_language', 'auto_replies_paused'] as const;
export type ChatSetting = (typeof CHAT_SETTINGS)[number];

/** Settings only the cabinet changes → the «Настройки» section the reply links to (`?section=`). */
export const CABINET_ONLY_SETTINGS: Record<string, string> = {
  whatsapp: 'whatsapp', owner_phone: 'contact', time_zone: 'quiet', business_name: 'business', business_sector: 'business',
};

export const SETTING_LABELS: Record<ChatSetting | 'cabinet', Record<Lang, string>> = {
  quiet_hours: { ru: 'Когда не писать вам', he: 'מתי לא לכתוב לך', en: 'When not to message you' },
  day_off: { ru: 'Выходной', he: 'יום חופש', en: 'Day off' },
  daily_report_enabled: { ru: 'Утренний отчёт', he: 'דוח בוקר', en: 'Morning report' },
  daily_report_time: { ru: 'Время утреннего отчёта', he: 'שעת דוח הבוקר', en: 'Morning report time' },
  auto_resume_hours: { ru: 'Через сколько часов ассистент возвращается в чат', he: 'אחרי כמה שעות העוזרת חוזרת לשיחה', en: 'Hours before the assistant returns to a chat' },
  polish_owner_answer: { ru: 'Дописывать мои короткие ответы', he: 'להשלים את התשובות הקצרות שלי', en: 'Complete my short answers' },
  assistant_name: { ru: 'Имя ассистента', he: 'שם העוזרת', en: 'Assistant name' },
  owner_language: { ru: 'Язык сообщений вам', he: 'שפת ההודעות אליך', en: 'Language of messages to you' },
  auto_replies_paused: { ru: 'Ответы клиентам', he: 'מענה ללקוחות', en: 'Replies to clients' },
  cabinet: { ru: 'Настройки', he: 'הגדרות', en: 'Settings' },
};
export const SETTING_VALUE_WORDS: Record<'on' | 'off' | 'none' | 'paused' | 'running', Record<Lang, string>> = {
  on: { ru: 'включено', he: 'מופעל', en: 'on' },
  off: { ru: 'выключено', he: 'כבוי', en: 'off' },
  none: { ru: 'не задано', he: 'לא הוגדר', en: 'not set' },
  paused: { ru: 'остановлены', he: 'מושהה', en: 'stopped' },
  running: { ru: 'включены', he: 'פעיל', en: 'on' },
};
export const LANGUAGE_WORDS: Record<Lang, Record<Lang, string>> = {
  ru: { ru: 'русский', he: 'רוסית', en: 'Russian' },
  he: { ru: 'иврит', he: 'עברית', en: 'Hebrew' },
  en: { ru: 'английский', he: 'אנגלית', en: 'English' },
};
