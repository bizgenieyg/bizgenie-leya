export const TEMPLATE_DEFAULTS: Record<string,Record<string,string>> = {
  // Z12: the owner cycle as in chef-bot; the daily report; the operator's quality review.
  "owner.request_card": {"ru": "📩 Заявка\n{card}\n📱 {phone}\n\nОтветьте реплеем — передам клиенту.", "he": "📩 בקשה\n{card}\n📱 {phone}\n\nהשיבו בציטוט — אעביר ללקוח.", "en": "📩 Request\n{card}\n📱 {phone}\n\nReply to this message — I'll pass it to the client."},
  "owner.human_request": {"ru": "Клиент просит связаться с вами лично.", "he": "הלקוח מבקש שתיצרו איתו קשר אישית.", "en": "The client asks you to contact them personally."},
  "owner.client_left": {"ru": "Клиент уже попрощался — ответ не пересылаю, сохранила в знания.", "he": "הלקוח כבר נפרד — לא מעבירה את התשובה, שמרתי אותה בידע.", "en": "The client has already said goodbye — I'm not forwarding the answer; I saved it to the knowledge."},
  "client.model_apology": {"ru": "Прошу прощения, небольшая заминка. Напишите, пожалуйста, ещё раз через минуту.", "he": "סליחה, יש תקלה קטנה. אפשר לכתוב שוב בעוד דקה?", "en": "Sorry, a small hiccup. Please write again in a minute."},
  "client.owner_forward_fallback": {"ru": "{owner_name} пишет:\n\n«{answer}»", "he": "התשובה של {owner_name}:\n\n«{answer}»", "en": "{owner_name} says:\n\n«{answer}»"},
  "owner.learned_title": {"ru": "Ответ {owner_name}, {date}, вопрос клиента: {question}", "he": "תשובת {owner_name}, {date}, שאלת לקוח: {question}", "en": "Answer of {owner_name}, {date}, client question: {question}"},
  "owner.learned_fact": {"ru": "Клиент спросил: {question}\nОтвет {owner_name}: {answer}", "he": "לקוח שאל: {question}\nתשובת {owner_name}: {answer}", "en": "A client asked: {question}\nAnswer of {owner_name}: {answer}"},
  "owner.daily_report": {"ru": "📊 Отчёт за {date}\n\nВсего обращений: {total}\n✅ Заявки: {request}\n💬 В процессе: {in_progress}\n❌ Не сложилось: {lost}\nℹ️ Справка: {info}\n\n{lines}", "he": "📊 דוח ל-{date}\n\nסה\"כ פניות: {total}\n✅ בקשות: {request}\n💬 בתהליך: {in_progress}\n❌ לא הסתדר: {lost}\nℹ️ מידע בלבד: {info}\n\n{lines}", "en": "📊 Report for {date}\n\nConversations: {total}\n✅ Requests: {request}\n💬 In progress: {in_progress}\n❌ Didn't work out: {lost}\nℹ️ Info only: {info}\n\n{lines}"},
  "owner.daily_report_line": {"ru": "{icon} {name} — {summary}{reason}", "he": "{icon} {name} — {summary}{reason}", "en": "{icon} {name} — {summary}{reason}"},
  "owner.daily_reason_price": {"ru": "дорого", "he": "יקר", "en": "too expensive"},
  "owner.daily_reason_date": {"ru": "не подошла дата", "he": "התאריך לא התאים", "en": "the date did not fit"},
  "owner.daily_reason_missing": {"ru": "нет нужного", "he": "אין את מה שחיפש", "en": "we don't have what they need"},
  "owner.daily_reason_silent": {"ru": "ушёл молча", "he": "עזב בלי להגיד", "en": "left without a word"},
  "owner.daily_reason_other": {"ru": "другое", "he": "אחר", "en": "other"},
  "operator.quality_report": {"ru": "🔎 Контроль ответов за {date}: {count}\n\n{lines}", "he": "🔎 בקרת תשובות ל-{date}: {count}\n\n{lines}", "en": "🔎 Reply review for {date}: {count}\n\n{lines}"},
  // Z11: the owner's rules from WhatsApp; one bundled interview message a day.
  "owner.address_simultaneous": {"ru": "Во всех местах принимают одновременно (есть сотрудники) — клиент выбирает, где удобнее.", "he": "בכל המקומות מקבלים במקביל (יש צוות) — הלקוח בוחר איפה נוח לו.", "en": "All locations work at the same time (there is staff) — the client chooses where is convenient."},
  "owner.address_schedule": {"ru": "Владелец принимает сам, по графику: {schedule}", "he": "בעל העסק מקבל בעצמו, לפי לוח זמנים: {schedule}", "en": "The owner works in person, by schedule: {schedule}"},
  "owner.rule_understood": {"ru": "Поняла так: «{text}». Сохранить? Да / Нет", "he": "הבנתי כך: „{text}”. לשמור? כן / לא", "en": "I understood: “{text}”. Save? Yes / No"},
  "owner.rule_edit_understood": {"ru": "Правило {number} станет: «{text}». Сохранить? Да / Нет", "he": "כלל {number} יהיה: „{text}”. לשמור? כן / לא", "en": "Rule {number} becomes: “{text}”. Save? Yes / No"},
  "owner.rule_remove_understood": {"ru": "Убрать правило {number}: «{text}»? Да / Нет", "he": "להסיר את כלל {number}: „{text}”? כן / לא", "en": "Remove rule {number}: “{text}”? Yes / No"},
  "owner.rule_conflict": {"ru": "Так не могу, потому что {reason}. Могу так: «{text}». Сохранить? Да / Нет", "he": "כך אני לא יכולה, כי {reason}. אפשר כך: „{text}”. לשמור? כן / לא", "en": "I can't do that because {reason}. I can do this: “{text}”. Save? Yes / No"},
  "owner.fact_understood": {"ru": "Запомню как факт: «{text}». Сохранить? Да / Нет", "he": "אזכור כעובדה: „{text}”. לשמור? כן / לא", "en": "I'll remember it as a fact: “{text}”. Save? Yes / No"},
  "owner.fact_rule_understood": {"ru": "Поняла так: факт «{fact}» и правило «{text}». Сохранить? Да / Нет", "he": "הבנתי כך: עובדה „{fact}” וכלל „{text}”. לשמור? כן / לא", "en": "I understood: fact “{fact}” and rule “{text}”. Save? Yes / No"},
  "owner.rule_saved": {"ru": "Сохранила. Правило {number}: «{text}».", "he": "נשמר. כלל {number}: „{text}”.", "en": "Saved. Rule {number}: “{text}”."},
  "owner.rule_removed": {"ru": "Убрала правило {number}.", "he": "כלל {number} הוסר.", "en": "Rule {number} removed."},
  "owner.fact_saved": {"ru": "Запомнила: «{text}».", "he": "נשמר: „{text}”.", "en": "Remembered: “{text}”."},
  "owner.rule_declined": {"ru": "Хорошо, не сохраняю. Как сказать по-другому?", "he": "בסדר, לא שומרת. איך לנסח אחרת?", "en": "OK, not saved. How should I put it instead?"},
  "owner.rules_list": {"ru": "Правила:\n{list}", "he": "כללים:\n{list}", "en": "Rules:\n{list}"},
  "owner.rules_empty": {"ru": "Правил пока нет. Напишите, как мне вести себя с клиентами — например: «город не спрашивай».", "he": "עדיין אין כללים. אפשר לכתוב איך להתנהג עם לקוחות — למשל: „לא לשאול על העיר”.", "en": "No rules yet. Tell me how to behave with clients — for example: “don't ask for the city”."},
  "owner.rules_full": {"ru": "Правил уже {max} — какое убрать?\n{list}", "he": "יש כבר {max} כללים — איזה להסיר?\n{list}", "en": "There are already {max} rules — which one should I remove?\n{list}"},
  "owner.rule_too_long": {"ru": "Правило длиннее {max} знаков — скажите короче.", "he": "הכלל ארוך מ-{max} תווים — אפשר לקצר?", "en": "The rule is longer than {max} characters — please say it shorter."},
  "owner.rule_not_found": {"ru": "Правила {number} нет.", "he": "אין כלל {number}.", "en": "There is no rule {number}."},
  "owner.undo_done": {"ru": "Отменила последнее изменение.", "he": "השינוי האחרון בוטל.", "en": "The last change is undone."},
  "owner.undo_none": {"ru": "Отменять нечего.", "he": "אין מה לבטל.", "en": "There is nothing to undo."},
  "owner.remember_offer": {"ru": "Запомнить на будущее? Да / Нет", "he": "לזכור לפעם הבאה? כן / לא", "en": "Remember this for next time? Yes / No"},
  "owner.rules_unavailable": {"ru": "Сейчас не получается разобрать сообщение — попробуйте чуть позже.", "he": "כרגע לא מצליחה להבין את ההודעה — כדאי לנסות שוב מעט מאוחר יותר.", "en": "I can't process the message right now — please try again a bit later."},
  "owner.interview_bundle": {"ru": "📝 Вопросы для базы знаний:\n{questions}\n\nОтветьте реплеем на это сообщение — можно начать с номера вопроса. «Пропустить» — спрошу позже.", "he": "📝 שאלות למאגר הידע:\n{questions}\n\nאפשר להשיב בציטוט להודעה הזו — ולהתחיל במספר השאלה. „לדלג” — אשאל מאוחר יותר.", "en": "📝 Questions for the knowledge base:\n{questions}\n\nReply to this message — you can start with the question number. “Skip” — I'll ask later."},
  // Z10: the owner's groups by topic ({name} — the assistant name).
  "owner.channel_needs_answer": {"ru": "{name} · Нужен ответ", "he": "{name} · צריך תשובה", "en": "{name} · Needs answer"},
  "owner.channel_reports": {"ru": "{name} · Отчёты", "he": "{name} · דוחות", "en": "{name} · Reports"},
  "owner.channel_needs_answer_description": {"ru": "Вопросы клиентов и заявки. Чтобы ответить клиенту — ответьте цитатой на сообщение.", "he": "שאלות של לקוחות ובקשות. כדי לענות ללקוח — יש להשיב בציטוט להודעה.", "en": "Client questions and requests. To answer a client, reply to the message with a quote."},
  "owner.channel_reports_description": {"ru": "Сводки о работе ассистента.", "he": "סיכומים על עבודת העוזר.", "en": "Summaries of the assistant's work."},
  "owner.channel_recreated": {"ru": "Прежняя группа недоступна — теперь пишу сюда.", "he": "הקבוצה הקודמת אינה זמינה — מעכשיו אכתוב כאן.", "en": "The previous group is unavailable — I'll write here from now on."},
  "owner.channels_moved": {"ru": "Теперь пишу вам в группах «{needs_answer}» и «{reports}».", "he": "מעכשיו אכתוב בקבוצות „{needs_answer}” ו„{reports}”.", "en": "From now on I'll write in the groups “{needs_answer}” and “{reports}”."},
  "owner.summary": {
    "ru": "Сводка Леи: обращений — {inquiries}, новых клиентов — {new_clients}, закрыто Леей — {closed_by_bot}, передано владельцу — {escalated}, ждут ответа — {unanswered}. Не хватило знаний: {missing_knowledge}.",
    "he": "סיכום ליה: פניות — {inquiries}, לקוחות חדשים — {new_clients}, נסגרו על ידי ליה — {closed_by_bot}, הועברו לבעל העסק — {escalated}, ממתינים לתשובה — {unanswered}. ידע חסר: {missing_knowledge}.",
    "en": "Leya summary: inquiries — {inquiries}, new clients — {new_clients}, closed by Leya — {closed_by_bot}, sent to owner — {escalated}, awaiting reply — {unanswered}. Missing knowledge: {missing_knowledge}."
  },
  "owner.pairing_code": {
    "ru": "Код подтверждения Leya: {code}. Ответьте на это сообщение цифрами кода, чтобы подтвердить, что это ваш номер. Код действует {minutes} минут.",
    "he": "קוד האימות של Leya: {code}. השיבו להודעה הזו עם הספרות של הקוד כדי לאשר שזה המספר שלכם. הקוד בתוקף ל-{minutes} דקות.",
    "en": "Your Leya confirmation code: {code}. Reply to this message with the digits to confirm this is your number. The code is valid for {minutes} minutes."
  },
  "client.reception_question": {
    "ru": "Я ассистент владельца. Что именно вас интересует?",
    "he": "אני העוזרת של בעל העסק. מה בדיוק מעניין אותך?",
    "en": "I'm the owner's assistant. What exactly are you interested in?"
  },
  "client.waiting": {
    "ru": "Я ассистент владельца. Уточню у владельца и напишу, когда получу ответ.",
    "he": "אני העוזרת של בעל העסק. אברר עם בעל העסק ואעדכן כשאקבל תשובה.",
    "en": "I'm the owner's assistant. I'll check with the owner and get back to you when I have an answer."
  },
  "client.waiting_quiet": {
    "ru": "Я ассистент владельца. Уточню после тихих часов, с {time} ({zone}, время владельца), и напишу, когда получу ответ.",
    "he": "אני העוזרת של בעל העסק. אברר אחרי שעות השקט, החל מ־{time} ({zone}), ואעדכן כשאקבל תשובה.",
    "en": "I'm the owner's assistant. I'll check after quiet hours, from {time} ({zone}, owner's time), and get back to you when I have an answer."
  },
  "client.owner_answer": {
    "ru": "Я ассистент владельца. Передаю ответ владельца:\n\n«{answer}»",
    "he": "אני העוזרת של בעל העסק. זו התשובה שקיבלתי מבעל העסק:\n\n«{answer}»",
    "en": "I'm the owner's assistant. Here is the owner's answer:\n\n«{answer}»"
  },
  "client.limit": {
    "ru": "Я ассистент владельца. Сейчас автоматические ответы недоступны. Владелец сможет ответить вам лично.",
    "he": "אני העוזרת של בעל העסק. כרגע המענה האוטומטי אינו זמין. בעל העסק יוכל לענות לך בהמשך.",
    "en": "I'm the owner's assistant. Automatic replies are currently unavailable. The owner can respond to you personally."
  },
  "client.voice_unavailable": {
    "ru": "Я ассистент владельца. Сейчас не удалось распознать голосовое сообщение. Напишите вопрос текстом или дождитесь владельца.",
    "he": "אני העוזרת של בעל העסק. כרגע לא הצלחתי לתמלל את ההודעה. אפשר לכתוב את השאלה או להמתין לבעל העסק.",
    "en": "I'm the owner's assistant. I couldn't transcribe this message. Please type your question or wait for the owner."
  },
  "client.voice_clarify": {
    "ru": "Я ассистент владельца. Не удалось уверенно разобрать детали голосового сообщения. Пожалуйста, уточните текстом имена, даты и количества.",
    "he": "אני העוזרת של בעל העסק. לא הצלחתי להבין בביטחון את פרטי ההודעה. נא לאשר בכתב שמות, תאריכים וכמויות.",
    "en": "I'm the owner's assistant. I couldn't reliably understand the details. Please confirm names, dates and quantities in writing."
  },
  "client.waiting_no_schedule": {
    "ru": "Я ассистент владельца. Передал ваш вопрос владельцу — он свяжется с вами.",
    "he": "אני העוזרת של בעל העסק. העברתי את השאלה לבעל העסק — הוא ייצור איתך קשר.",
    "en": "I'm the owner's assistant. I've passed your question to the owner — they'll get back to you."
  },
  "client.owner_timeout": {
    "ru": "Я ассистент владельца. Пока не получил ответ на ваш вопрос. Владелец свяжется с вами отдельно.",
    "he": "אני העוזרת של בעל העסק. עדיין לא התקבלה תשובה לשאלה שלך. בעל העסק ייצור איתך קשר בנפרד.",
    "en": "I'm the owner's assistant. I haven't received an answer yet. The owner will contact you separately."
  },
  "owner.escalation": {
    "ru": "❓ Вопрос от клиента {name} ({phone}): {question}\n\nОтветьте реплеем — передам клиенту.",
    "en": "❓ Question from client {name} ({phone}): {question}\n\nReply to this message — I'll pass it to the client.",
    "he": "❓ שאלה מהלקוח {name} ({phone}): {question}\n\nהשיבו בציטוט — אעביר ללקוח."
  },
  "owner.summary_suggestions": {
    "ru": "Добавить в базу знаний?\n{items}\nОтветьте номерами (например «1 3»), «все» или «нет».",
    "en": "Add to the knowledge base?\n{items}\nReply with numbers (e.g. «1 3»), «all» or «no».",
    "he": "להוסיף למאגר הידע?\n{items}\nהשיבו במספרים (למשל «1 3»), «הכול» או «לא»."
  },
  "owner.summary_suggestion_item": {
    "ru": "{index}. В: {question} — О: {answer}",
    "en": "{index}. Q: {question} — A: {answer}",
    "he": "{index}. ש: {question} — ת: {answer}"
  },
  "client.greeting": {
    "ru": "Здравствуйте{, client_first_name}! Это {assistant_name}, цифровой ассистент. Чем могу помочь?",
    "en": "Hi{ client_first_name}! This is {assistant_name}, a digital assistant. How can I help?",
    "he": "היי{ client_first_name}! כאן {assistant_name}, עוזרת דיגיטלית. במה אפשר לעזור?"
  },
  "client.greeting_known": {
    "ru": "Здравствуйте{, client_first_name}! Чем могу помочь?",
    "en": "Hi{ client_first_name}! How can I help?",
    "he": "היי{ client_first_name}! במה אפשר לעזור?"
  },
  "client.acknowledgement": {
    "ru": "Пожалуйста! Если появятся вопросы — пишите.",
    "en": "You're welcome! Write any time if you have questions.",
    "he": "בשמחה! אם יהיו שאלות — כתבו."
  },
  "owner.escalation_model_unavailable": {
    "ru": "(ассистент был недоступен)",
    "en": "(the assistant was unavailable)",
    "he": "(העוזר לא היה זמין)"
  },
  "client.request_sent": {
    "ru": "Готово{, client_first_name}! {owner_name} свяжется с вами{ в time}.",
    "he": "מעולה{ client_first_name}! הפרטים אצל {owner_name}, ניצור איתך קשר{ ב־time}.",
    "en": "Done{, client_first_name}! {owner_name} will get in touch with you{ on time}."
  },
  "client.instruction_fallback": {
    "ru": "Подскажите, пожалуйста, что для вас сейчас самое важное?",
    "he": "מה הכי חשוב לך כרגע?",
    "en": "What matters most to you right now?"
  },
  "client.model_fallback": {
    "ru": "Уточню этот вопрос — {owner_name} ответит, и я вернусь к вам.",
    "he": "אבדוק את השאלה — {owner_name} יענה, ואחזור אליך.",
    "en": "I'll check this — {owner_name} will answer, and I'll get back to you."
  },
  "client.model_fallback_no_name": {
    "ru": "Уточню этот вопрос и вернусь к вам.",
    "he": "אבדוק את השאלה ואחזור אליך.",
    "en": "I'll check this and get back to you."
  },
  "client.model_fallback_repeat": {
    "ru": "Я помню ваш вопрос и вернусь с ответом.",
    "he": "אני זוכרת את השאלה שלך ואחזור עם תשובה.",
    "en": "I remember your question and will get back with an answer."
  },
  "client.ask_owner_fallback": {
    "ru": "Уточню: {owner_name} ответит, и я сразу вернусь к вам.",
    "he": "אבדוק עם {owner_name} ואחזור עם תשובה.",
    "en": "I'll check with {owner_name} and get back to you."
  },
  "owner.data_request": {
    "ru": "🔐 Клиент {name} ({phone}) просит {action} свои данные. Ответьте ему напрямую.",
    "he": "🔐 הלקוח {name} ({phone}) מבקש {action} את המידע שלו. כדאי לענות לו ישירות.",
    "en": "🔐 Client {name} ({phone}) asks to {action} their data. Please reply to them directly."
  },
  "owner.data_request_delete": { "ru": "удалить", "he": "למחוק", "en": "delete" },
  "owner.data_request_access": { "ru": "показать", "he": "לראות", "en": "see" },
  "owner.interview_question": {
    "ru": "📝 Вопрос для базы знаний ({left}):\n{question}\n\nОтветьте реплеем — текстом или голосовым. «Пропустить» — спрошу позже.",
    "he": "📝 שאלה למאגר הידע ({left}):\n{question}\n\nאפשר לענות בציטוט — בטקסט או בהודעה קולית. «לדלג» — אשאל מאוחר יותר.",
    "en": "📝 A question for the knowledge base ({left}):\n{question}\n\nReply to this message — text or voice. «Skip» — I'll ask later."
  },
  "owner.interview_recorded": {
    "ru": "Записала: {facts}\nЕсли что-то не так — ответьте реплеем с исправлением.",
    "he": "רשמתי: {facts}\nאם משהו לא מדויק — אפשר לענות בציטוט עם תיקון.",
    "en": "Saved: {facts}\nIf something is wrong, reply to this message with a correction."
  },
  "owner.interview_postponed": {
    "ru": "Хорошо, спрошу позже.",
    "he": "בסדר, אשאל מאוחר יותר.",
    "en": "OK, I'll ask later."
  },
  "owner.interview_not_understood": {
    "ru": "Не получилось разобрать ответ. Попробуйте ещё раз текстом или «Пропустить».",
    "he": "לא הצלחתי להבין את התשובה. אפשר לנסות שוב בטקסט או לכתוב «לדלג».",
    "en": "I couldn't make out the answer. Try again in text, or «Skip»."
  },
  "client.ask_name": {
    "ru": "И как к вам обращаться?",
    "he": "ואיך לפנות אליך?",
    "en": "And what name should I use?"
  },
  "client.request_repeat": {
    "ru": "Я уже передала вашу заявку — {owner_name} свяжется с вами.",
    "he": "כבר העברתי את הבקשה שלך — {owner_name} ייצור איתך קשר.",
    "en": "I've already passed on your request — {owner_name} will get in touch with you."
  },
  "owner.request": {
    "ru": "📩 Заявка: {name} ({phone})\n{summary}\n\nОтветьте реплеем — я передам клиенту.",
    "he": "📩 בקשה: {name} ({phone})\n{summary}\n\nהשיבו בציטוט להודעה — אעביר ללקוח.",
    "en": "📩 Request: {name} ({phone})\n{summary}\n\nReply to this message — I'll pass it to the client."
  },
  "owner.request_time": {
    "ru": "Время: {time}",
    "he": "זמן: {time}",
    "en": "Time: {time}"
  },
  "owner.summary_requests": {
    "ru": "Заявки без ответа: {count}\n{items}",
    "he": "בקשות ללא מענה: {count}\n{items}",
    "en": "Requests without a reply: {count}\n{items}"
  },
  "owner.summary_request_item": {
    "ru": "- {name} — {summary}",
    "he": "- {name} — {summary}",
    "en": "- {name} — {summary}"
  },
  "client.partial_pending": {
    "ru": "По остальным вопросам ещё уточняю у владельца и напишу, как только получу ответ.",
    "he": "לגבי שאר השאלות אני עדיין בודקת עם בעל העסק ואעדכן ברגע שאקבל תשובה.",
    "en": "I'm still checking the remaining questions with the owner and will write as soon as I have an answer."
  },
  "owner.remind": {
    "ru": "🔔 Напоминание — жду ответа на вопрос от клиента {name} ({phone}):\n«{question}»\n\nОтветьте реплеем на это сообщение 🙏",
    "en": "🔔 Reminder — waiting for your answer to the question from {name} ({phone}):\n«{question}»\n\nReply to this message 🙏",
    "he": "🔔 תזכורת — מחכה לתשובה על השאלה של {name} ({phone}):\n«{question}»\n\nנא להשיב בציטוט להודעה זו 🙏"
  },
  "owner.reminder_missed": {
    "ru": "Напоминание клиенту {name} на {time} не отправлено вовремя.",
    "he": "התזכורת ללקוח {name} לשעה {time} לא נשלחה בזמן.",
    "en": "The reminder to {name} for {time} was not sent on time."
  },
  "owner.usage_warning": {
    "ru": "Использовано не менее {percent}% месячного лимита {resource}. Расход: {used} из {limit}. Измените лимит в кабинете.",
    "en": "At least {percent}% of the monthly {resource} allowance has been used: {used} of {limit}. Change the limit in your account.",
    "he": "נוצלו לפחות {percent}% ממכסת {resource} החודשית: {used} מתוך {limit}. ניתן לשנות את המכסה בחשבון."
  },
  "owner.usage_exhausted": {
    "ru": "Лимит {resource} не позволяет обработать новое сообщение автоматически. Расход: {used} из {limit}. Клиенту предложено дождаться вашего ответа.",
    "en": "The {resource} limit prevents an automatic response. Usage: {used} of {limit}. The customer was asked to wait for your reply.",
    "he": "מכסת {resource} אינה מאפשרת מענה אוטומטי. שימוש: {used} מתוך {limit}. הלקוח התבקש להמתין לתשובתך."
  },
  "owner.usage_failure": {
    "ru": "Сбой учёта расхода: автоответы продолжаются, но проверка лимитов временно недоступна. Администратору нужно проверить журнал usage_admission_unavailable.",
    "en": "Usage accounting is unavailable. Automatic replies continue, but quota checks are unavailable. Ask the administrator to check usage_admission_unavailable logs.",
    "he": "יש תקלה במעקב השימוש. המענה האוטומטי נמשך אך בדיקת המכסות אינה זמינה. יש לבקש מהמנהל לבדוק את יומן usage_admission_unavailable."
  },
  "owner.dialog_line": {
    "ru": "{name}{paused}\nПауза диалог {id}\nПродолжить диалог {id}",
    "en": "{name}{paused}\nПауза диалог {id}\nПродолжить диалог {id}",
    "he": "{name}{paused}\nПауза диалог {id}\nПродолжить диалог {id}"
  },
  "owner.owner_reply_5": {
    "ru": "Автоответы бизнеса приостановлены. Для возобновления напишите «Продолжить всё».",
    "en": "Automatic replies are paused. Send «Продолжить всё» to resume.",
    "he": "המענה האוטומטי מושהה. לחידוש יש לשלוח «Продолжить всё»."
  },
  "owner.owner_reply_6": {
    "ru": "Автоответы бизнеса возобновлены. Диалоги, взятые вручную, остаются на паузе.",
    "en": "Automatic replies resumed. Conversations taken over manually remain paused.",
    "he": "המענה האוטומטי חודש. שיחות שנלקחו לטיפול ידני נשארות בהשהיה."
  },
  "owner.owner_reply_12": {
    "ru": "Диалог на паузе до явного возобновления.",
    "en": "This conversation is paused until explicitly resumed.",
    "he": "השיחה מושהית עד לחידוש מפורש."
  },
  "owner.owner_reply_15": {
    "ru": "Ответьте реплеем на вопрос клиента. «Диалоги» — список диалогов и команд управления. Команды: «Пауза всё», «Продолжить всё»; реплеем на вопрос — «Беру на себя», «Пауза», «Продолжить».",
    "en": "Reply to the customer question using reply. Send «Диалоги» for conversations. Commands: «Пауза всё», «Продолжить всё»; reply to a question with «Беру на себя», «Пауза» or «Продолжить».",
    "he": "יש להשיב בציטוט לשאלת הלקוח. לרשימת השיחות שלחו «Диалоги». פקודות: «Пауза всё», «Продолжить всё»; בציטוט לשאלה: «Беру на себя», «Пауза» או «Продолжить»."
  },
  "owner.owner_reply_22": {
    "ru": "Автоответы в этом диалоге остановлены. Для возобновления ответьте «Продолжить» реплеем на вопрос.",
    "en": "Automatic replies in this conversation are paused. Reply «Продолжить» to the question to resume.",
    "he": "המענה האוטומטי בשיחה הושהה. לחידוש יש להשיב «Продолжить» בציטוט לשאלה."
  },
  "owner.owner_reply_23": {
    "ru": "Автоответы в этом диалоге возобновлены.",
    "en": "Automatic replies in this conversation resumed.",
    "he": "המענה האוטומטי בשיחה חודש."
  },
  "owner.owner_reply_24": {
    "ru": "Вопрос остаётся открытым. Когда будет ответ по существу, отправьте его реплеем на тот же вопрос.",
    "en": "The question remains open. When you have a substantive answer, reply to the same question.",
    "he": "השאלה נשארת פתוחה. כשהתשובה תהיה מוכנה, יש להשיב בציטוט לאותה שאלה."
  },
  "owner.owner_reply_25": {
    "ru": "Диалог на паузе. Возобновите автоответы и отправьте ответ ещё раз реплеем на вопрос. Обращение остаётся открытым.",
    "en": "This conversation is paused. Resume replies and send your answer again as a reply to the question. The case remains open.",
    "he": "השיחה מושהית. יש לחדש את המענה ולשלוח שוב את התשובה בציטוט לשאלה. הפנייה נשארת פתוחה."
  },
  "owner.owner_reply_26": {
    "ru": "Доставка ответа клиенту не подтверждена. Обращение не закрыто; нужна проверка доставки.",
    "en": "Delivery to the customer was not confirmed. The case remains open; delivery needs checking.",
    "he": "מסירת התשובה ללקוח לא אושרה. הפנייה לא נסגרה ויש לבדוק את המסירה."
  },
  "client.waiting_quiet_client": {
    "ru": "Я ассистент владельца. Уточню после тихих часов, с {time} ({zone}, ваше местное время), и напишу, когда получу ответ.",
    "en": "I'm the owner's assistant. I'll check after quiet hours, from {time} ({zone}, your local time), and get back to you when I have an answer.",
    "he": "אני העוזרת של בעל העסק. אברר אחרי שעות השקט, החל מ־{time} ({zone}, הזמן המקומי שלך), ואעדכן כשאקבל תשובה."
  },
  "owner.short_0": {
    "ru": "Активных диалогов пока нет.",
    "en": "No active conversations yet.",
    "he": "אין עדיין שיחות פעילות."
  },
  "owner.short_1": {
    "ru": "Автоответы диалога возобновлены.",
    "en": "Conversation replies resumed.",
    "he": "המענה בשיחה חודש."
  },
  "owner.short_2": {
    "ru": "Диалог не найден в этом бизнесе.",
    "en": "Conversation not found in this business.",
    "he": "השיחה לא נמצאה בעסק זה."
  },
  "owner.short_3": {
    "ru": "Ответ сохранён в базе знаний.",
    "en": "Answer saved to the knowledge base.",
    "he": "התשובה נשמרה במאגר הידע."
  },
  "owner.resource_voice": {
    "ru": "голосовых минут",
    "en": "voice minutes",
    "he": "דקות קוליות"
  },
  "owner.resource_messages": {
    "ru": "входящих сообщений",
    "en": "incoming messages",
    "he": "הודעות נכנסות"
  },
  "client.timezone_saved": {
    "ru": "Часовой пояс сохранён: {zone}.",
    "en": "Time zone saved: {zone}.",
    "he": "אזור הזמן נשמר: {zone}."
  }
};

/**
 * Former built-in defaults. A stored override equal to one of them was never really edited by the
 * owner (older cabinets saved the default as text), so it is read as "no override" and the current
 * default applies. Checked at read time: no data migration, owner-edited texts stay untouched.
 */
export const LEGACY_TEMPLATE_DEFAULTS: Record<string, string[]> = {
  "client.greeting": [
    "Здравствуйте! Это {assistant_name}, ассистент {owner_name}. Чем могу помочь?",
    "Hi! This is {assistant_name}, {owner_name}'s assistant. How can I help?",
    "היי! כאן {assistant_name}, בשם {owner_name}. במה אפשר לעזור?",
  ],
  "client.request_sent": [
    "Спасибо{, client_first_name}! Передала вашу заявку — {owner_name} свяжется с вами.",
    "תודה{ client_first_name}! העברתי את הבקשה שלך — {owner_name} ייצור איתך קשר.",
    "Thank you{, client_first_name}! I've passed on your request — {owner_name} will get in touch with you.",
    "Передала вашу заявку — {owner_name} свяжется с вами.",
    "העברתי את הבקשה שלך — {owner_name} ייצור איתך קשר.",
    "I've passed on your request — {owner_name} will get in touch with you.",
  ],
};
