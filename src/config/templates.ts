export const TEMPLATE_DEFAULTS: Record<string,Record<string,string>> = {
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
  "client.owner_timeout": {
    "ru": "Я ассистент владельца. Пока не получил ответ на ваш вопрос. Владелец свяжется с вами отдельно.",
    "he": "אני העוזרת של בעל העסק. עדיין לא התקבלה תשובה לשאלה שלך. בעל העסק ייצור איתך קשר בנפרד.",
    "en": "I'm the owner's assistant. I haven't received an answer yet. The owner will contact you separately."
  },
  "owner.escalation": {
    "ru": "❓ Новый вопрос от {name}:\n\n{question}\n\nЛея не нашла ответ в базе знаний.\nОтветьте реплеем на это сообщение. Для паузы диалога ответьте «Беру на себя», для возобновления — «Продолжить».",
    "en": "❓ Question from {name}:\n\n{question}\n\nThe assistant could not find an answer. Reply to this message. To take over, reply «Беру на себя»; to resume, «Продолжить».",
    "he": "❓ שאלה מאת {name}:\n\n{question}\n\nהעוזרת לא מצאה תשובה. יש להשיב בציטוט להודעה זו. לקבלת השיחה: «Беру на себя»; לחידוש: «Продолжить»."
  },
  "owner.learning": {
    "ru": "Ответ отправлен клиенту. Сохранить эту пару в базу знаний?\n\nВопрос: {question}\nОтвет: {answer}\n\nОтветьте реплеем на это сообщение: «Да» или «Нет».",
    "en": "Your answer was delivered. Save it to the knowledge base?\n\nQuestion: {question}\nAnswer: {answer}\n\nReply to this message: Yes or No.",
    "he": "התשובה נמסרה. לשמור אותה במאגר הידע?\n\nשאלה: {question}\nתשובה: {answer}\n\nנא להשיב בציטוט: כן או לא."
  },
  "owner.remind": {
    "ru": "Напоминание: клиент {name} ждёт ответа.\n\n{question}\n\nОтветьте реплеем на это сообщение.",
    "en": "Reminder: {name} is waiting for an answer.\n\n{question}\n\nReply to this message.",
    "he": "תזכורת: {name} ממתין לתשובה.\n\n{question}\n\nנא להשיב בציטוט להודעה זו."
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
