export const TEMPLATE_DEFAULTS: Record<string,Record<string,string>> = {
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
    "ru": "❓ {name} ({phone}):\n«{question}»\n\nОтветьте реплеем — я передам клиенту.",
    "en": "❓ {name} ({phone}):\n«{question}»\n\nReply to this message — I'll pass it to the client.",
    "he": "❓ {name} ({phone}):\n«{question}»\n\nהשיבו בציטוט להודעה — אעביר ללקוח."
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
  "client.request_sent": {
    "ru": "Передала вашу заявку — {owner_name} свяжется с вами.",
    "he": "העברתי את הבקשה שלך — {owner_name} ייצור איתך קשר.",
    "en": "I've passed on your request — {owner_name} will get in touch with you."
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
    "ru": "Напоминание: клиент {name} ({phone}) ждёт ответа.\n\n{question}\n\nОтветьте реплеем на это сообщение.",
    "en": "Reminder: {name} ({phone}) is waiting for an answer.\n\n{question}\n\nReply to this message.",
    "he": "תזכורת: {name} ({phone}) ממתין לתשובה.\n\n{question}\n\nנא להשיב בציטוט להודעה זו."
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
