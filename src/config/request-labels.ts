/**
 * Z14: the owner never sees the model's label keys (consultation, name:, service:). When the model wrote no card after
 * [[REQUEST]], the code builds one from the label with these words; an unknown type or field gets the generic word.
 */
type Words = Record<'ru' | 'he' | 'en', string>;
export const REQUEST_TYPE_LABELS: Record<string, Words> = {
  consultation: { ru: 'консультация', he: 'ייעוץ', en: 'consultation' },
  meeting: { ru: 'встреча', he: 'פגישה', en: 'meeting' },
  procedure: { ru: 'запись на процедуру', he: 'תור לטיפול', en: 'treatment booking' },
  booking: { ru: 'запись', he: 'תור', en: 'booking' },
  reschedule: { ru: 'перенос записи', he: 'שינוי מועד', en: 'rescheduling' },
  estimate: { ru: 'расчёт стоимости', he: 'הצעת מחיר', en: 'estimate' },
  order: { ru: 'заказ', he: 'הזמנה', en: 'order' },
  access: { ru: 'доступ к данным', he: 'גישה למידע', en: 'data access' },
  delete: { ru: 'удаление данных', he: 'מחיקת מידע', en: 'data deletion' },
  call: { ru: 'звонок', he: 'שיחה', en: 'call' },
};
export const REQUEST_TYPE_OTHER: Words = { ru: 'заявка', he: 'בקשה', en: 'request' };
export const REQUEST_FIELD_LABELS: Record<string, Words> = {
  name: { ru: 'Имя', he: 'שם', en: 'Name' },
  service: { ru: 'Услуга', he: 'שירות', en: 'Service' },
  topic: { ru: 'Тема', he: 'נושא', en: 'Topic' },
  what: { ru: 'Что нужно', he: 'מה צריך', en: 'What' },
  task: { ru: 'Задача', he: 'משימה', en: 'Task' },
  items: { ru: 'Что заказывает', he: 'מה מזמינים', en: 'Items' },
  when: { ru: 'Когда удобно', he: 'מתי נוח', en: 'When' },
  time: { ru: 'Время', he: 'שעה', en: 'Time' },
  date: { ru: 'Дата', he: 'תאריך', en: 'Date' },
  city: { ru: 'Город', he: 'עיר', en: 'City' },
  area: { ru: 'Район', he: 'אזור', en: 'Area' },
  size: { ru: 'Объём', he: 'היקף', en: 'Size' },
  delivery: { ru: 'Доставка', he: 'משלוח', en: 'Delivery' },
  allergy: { ru: 'Аллергия', he: 'אלרגיה', en: 'Allergy' },
  budget: { ru: 'Бюджет', he: 'תקציב', en: 'Budget' },
  people: { ru: 'Сколько человек', he: 'כמה אנשים', en: 'People' },
};
export const REQUEST_FIELD_OTHER: Words = { ru: 'Детали', he: 'פרטים', en: 'Details' };
