-- 070 (Z14): before Z12 the system default for the owner reminder was 120 minutes; a tenant whose settings stored that
-- old default kept getting reminders after 2 hours instead of Z12's 4. The stored old default is dropped, so the system
-- default (escalation_remind_minutes in src/config/behavior.ts) applies again. Any other value — set on purpose — stays.
begin;
update public.notification_settings
   set behavior = behavior - 'escalation_remind_minutes'
 where behavior ? 'escalation_remind_minutes'
   and behavior->>'escalation_remind_minutes' = '120';
commit;
