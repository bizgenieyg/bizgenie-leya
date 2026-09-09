export const AGENT_DEFAULTS = {
 // Signals are a vertical-neutral cheap pre-filter for the classifier. Per-tenant tuning is
 // via behavior.agent_overrides.<AGENT>.keywords, so booking/appointment-style tokens are
 // deliberately not baked in here.
 SALE:{priority:10,signals:['цен|стоим|купить|прайс|price|cost|buy|quote|מחיר|עלות|כמה עולה'],systemPrompt:'SALE: помоги клиенту понять, что предлагает бизнес, и подскажи следующий шаг — только по базе знаний. Не совершай действий и не бери обязательств от имени бизнеса: ничего не оформляй, не подтверждай, не обещай наличие или сроки.'},
 SUPPORT:{priority:20,signals:['вопрос по|мой заказ|моя услуга|проблем|жалоб|статус|не работает|возврат|problem|complaint|status|broken|בעיה|תלונה|סטטוס'],systemPrompt:'SUPPORT: помоги разобраться с вопросом по уже полученному товару, услуге или обращению — только по базе знаний. Не выдумывай статус, наличие или результат проверки.'},
};
